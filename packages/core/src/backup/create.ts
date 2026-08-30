/**
 * Taking a snapshot (CONCEPT.md §5.15).
 *
 * The requirement is one word long — *consistent* — and it is the whole reason this is not eight
 * lines of `cp`. A live SQLite database is a file plus a write-ahead log plus a shared-memory
 * index, and the three are only in agreement at instants the copying process cannot see. Copying
 * the file while a write is in flight produces a database that opens, passes a cursory look and is
 * missing a transaction; copying the file and the WAL separately produces one that may not open at
 * all. So the database half of a snapshot is taken with SQLite's own online backup API
 * (`sqlite3_backup_step`), which copies pages under the reader/writer discipline of the engine
 * itself: writers keep working, pages that change during the copy are re-copied, and what lands is
 * the database as of one instant.
 *
 * The store half needs no such ceremony, and that is a property of ADR-0004 rather than luck.
 * Blobs are immutable and named by their own digest, so a blob either exists in full or does not
 * exist, and a concurrent ingest can only *add*. The snapshot copies each blob, hashing as it goes,
 * and refuses to record one whose bytes disagree with its name.
 *
 * **Every run reads every source blob**, including an incremental one written over yesterday's
 * snapshot. The incremental saving is the write, not the read: a run that skipped the read for a
 * blob already at the destination would be a run in which rot in the live store is invisible, and
 * `onCorruptBlob` — whose default is to refuse the backup — could never fire again after the first
 * night. A nightly snapshot is often the only thing that reads the whole store, so it is also the
 * thing that finds the rot.
 *
 * **Restic-friendly** (the other word in §5.15) means: a directory of ordinary files, laid out so
 * that consecutive snapshots overlap almost entirely. Blobs keep their content-addressed path, so
 * an unchanged blob is the identical file at the identical path every night and a deduplicating
 * backup program stores it once. The manifest is emitted in a fixed key order, so an unchanged
 * library produces an unchanged manifest. The database is taken with the backup API rather than
 * `VACUUM INTO` precisely because the backup API preserves page layout: content-defined chunking
 * then finds the unchanged pages. And because the same output path can be written again, a
 * snapshot taken over yesterday's re-copies only what changed.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

import { MEMORY_DATABASE, resolveDatabaseFile } from '../db/client.js';
import { nowTimestamp } from '../time.js';
import { BackupTargetError, BackupFormatError } from './errors.js';
import {
  CHECKSUMS_FILE,
  CONFIG_FILE,
  DATABASE_FILE,
  MANIFEST_FILE,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  blobPath,
} from './format.js';
import {
  copyFileHashing,
  hashFile,
  isEmptyDirectory,
  listFilesRecursively,
  listStoredBlobs,
  readManifestFile,
} from './files.js';
import { inspectDatabaseFile } from './inspect.js';
import type { BackupBlobEntry, BackupFileEntry, BackupManifest } from './manifest.js';
import { manifestFiles, parseManifest, renderChecksums, serialiseManifest } from './manifest.js';
import { BACKUP_GENERATOR } from './version.js';

export type BackupPhase = 'database' | 'storage' | 'config' | 'manifest';

export interface BackupProgress {
  readonly phase: BackupPhase;
  readonly done: number;
  /** Zero when the total is not known in advance, which is only true of the database copy. */
  readonly total: number;
  /** What is being worked on: a digest, a filename. */
  readonly label: string | null;
}

/** A blob in the live store whose bytes no longer hash to its name (invariant D2). */
export interface CorruptBlob {
  readonly key: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly size: number;
}

export interface CreateBackupOptions {
  /** The live library: `:memory:` is refused, since there is nothing to snapshot. */
  readonly databaseUrl: string;
  /** The content-addressed store root. Omit for a database-and-config-only snapshot. */
  readonly storagePath?: string | null;
  /** Where the snapshot goes. Must be absent, empty, or a snapshot being replaced with `force`. */
  readonly out: string;
  /**
   * Copy the blobs. Default true.
   *
   * False writes the storage *manifest* and no bytes, which is the shape §5.15 describes for a
   * deployment that already backs the content-addressed store up on its own — restic over an
   * immutable, deduplicated directory is very good at that, and copying it twice is waste. Such a
   * snapshot cannot restore the store on its own, and says so in the manifest.
   */
  readonly includeBlobs?: boolean;
  /** Recorded as `config/recueil.json`. The caller redacts; this module never sees a secret. */
  readonly config?: Record<string, unknown> | null;
  /** Replace an existing snapshot at `out`. Never permits writing over anything else. */
  readonly force?: boolean;
  /**
   * `fail` — the default — refuses to write a snapshot over a store that has rotted.
   *
   * Applies on every run. The live blob is hashed whether or not the destination already holds a
   * copy of it, so an incremental snapshot detects rot exactly as a first one does.
   */
  readonly onCorruptBlob?: 'fail' | 'skip';
  /** Count the rows of every table for the manifest. Default true. */
  readonly tableCounts?: boolean;
  readonly onProgress?: (progress: BackupProgress) => void;
  /** Fixed clock, for tests. */
  readonly now?: () => string;
}

export interface BackupResult {
  /** Absolute path of the snapshot directory. */
  readonly path: string;
  readonly manifest: BackupManifest;
  readonly blobsCopied: number;
  /** Blobs already present at the destination with the right digest, and therefore not re-copied. */
  readonly blobsReused: number;
  /** Files removed from a replaced snapshot because the new one does not claim them. */
  readonly filesPruned: number;
  readonly bytesWritten: number;
  /** Blobs left out because their bytes disagreed with their name, under `onCorruptBlob: 'skip'`. */
  readonly corruptBlobs: readonly CorruptBlob[];
  /** Entries under the store root that are not blobs, and were therefore not backed up. */
  readonly ignoredStoreEntries: readonly string[];
}

/**
 * Decide whether `out` may be written to.
 *
 * Three states are allowed: it does not exist, it exists and is empty, or it is a snapshot in this
 * format and `force` was given. Anything else is refused — including a non-empty directory with
 * `force`, because `--force` is permission to replace *a backup*, not permission to write a
 * database file into somebody's home directory and then delete the parts of it that look stale.
 */
const prepareTarget = async (out: string, force: boolean): Promise<{ replacing: boolean }> => {
  if (await isEmptyDirectory(out)) {
    await mkdir(out, { recursive: true });
    return { replacing: false };
  }

  if (existsSync(out) && !existsSync(join(out, MANIFEST_FILE))) {
    throw new BackupTargetError(
      `'${out}' is not empty and is not a Recueil snapshot. Choose an empty directory: a backup ` +
        'will not write into a directory whose contents it does not understand.',
      { out },
    );
  }

  let existing: BackupManifest;
  try {
    existing = parseManifest(await readManifestFile(join(out, MANIFEST_FILE)), join(out, MANIFEST_FILE));
  } catch (cause) {
    throw new BackupTargetError(
      `'${out}' holds a '${MANIFEST_FILE}' that is not a readable Recueil snapshot, so it is not ` +
        'safe to replace. Choose an empty directory.',
      { out, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }

  if (!force) {
    throw new BackupTargetError(
      `'${out}' already holds a snapshot taken at ${existing.createdAt}. Pass force to replace it, ` +
        'or choose another path.',
      { out, createdAt: existing.createdAt },
    );
  }

  return { replacing: true };
};

/**
 * Remove whatever a replaced snapshot held that the new one does not claim.
 *
 * Without this, a snapshot written over an older one would be the union of the two, and the
 * manifest would be describing a directory that contains more than it says. A blob deleted from
 * the library since the last run has to disappear from the backup as well, or the backup is not a
 * snapshot of anything.
 */
const pruneStaleFiles = async (out: string, keep: ReadonlySet<string>): Promise<number> => {
  let pruned = 0;
  for (const relative of await listFilesRecursively(out)) {
    if (keep.has(relative)) continue;
    await rm(join(out, relative), { force: true });
    pruned += 1;
  }
  return pruned;
};

export const createBackup = async (options: CreateBackupOptions): Promise<BackupResult> => {
  const out = resolve(options.out);
  const clock = options.now ?? nowTimestamp;
  const progress = options.onProgress ?? ((): void => undefined);
  const includeBlobs = options.includeBlobs !== false;

  const sourceFile = resolveDatabaseFile(options.databaseUrl);
  if (sourceFile === MEMORY_DATABASE) {
    throw new BackupFormatError(
      'An in-memory database has nothing to snapshot: it exists only inside the process that ' +
        'opened it. Point the backup at a database file.',
    );
  }
  if (!existsSync(sourceFile)) {
    throw new BackupFormatError(`No database at '${sourceFile}'.`, { databaseFile: sourceFile });
  }

  await prepareTarget(out, options.force === true);

  /* The database ------------------------------------------------------------------------------ */

  progress({ phase: 'database', done: 0, total: 0, label: sourceFile });
  const databaseTarget = join(out, DATABASE_FILE);
  await mkdir(dirname(databaseTarget), { recursive: true });
  // Removed rather than overwritten: the backup API appends to whatever it finds, and a stale
  // WAL beside a replaced file is a corrupt database waiting to be opened.
  await rm(databaseTarget, { force: true });
  await rm(`${databaseTarget}-wal`, { force: true });
  await rm(`${databaseTarget}-shm`, { force: true });

  // Opened read-write because a WAL database needs to be able to create its shared-memory index;
  // nothing here writes. `sqlite3_backup_step` is the whole point of this line.
  const source = new BetterSqlite3(sourceFile, { fileMustExist: true });
  try {
    source.pragma('busy_timeout = 30000');
    await source.backup(databaseTarget, {
      progress: ({ totalPages, remainingPages }) => {
        progress({
          phase: 'database',
          done: totalPages - remainingPages,
          total: totalPages,
          label: sourceFile,
        });
        // Keep going, one page group at a time; the number is the pages per step.
        return 100;
      },
    });
  } finally {
    source.close();
  }

  const databaseHash = await hashFile(databaseTarget);
  const facts = inspectDatabaseFile(databaseTarget, { counts: options.tableCounts !== false });
  // Reading a WAL database — even read-only — leaves a shared-memory index and an empty log
  // beside it. Neither belongs in a snapshot: the manifest does not name them, and a restore that
  // copied one would put a stale log next to a fresh database.
  await rm(`${databaseTarget}-wal`, { force: true });
  await rm(`${databaseTarget}-shm`, { force: true });
  if (facts.integrityCheck !== 'ok') {
    throw new BackupFormatError(
      `The snapshot of '${sourceFile}' does not pass SQLite's integrity check: ` +
        `${facts.integrityCheck}. The backup has not been completed.`,
      { integrityCheck: facts.integrityCheck },
    );
  }

  /* The configuration -------------------------------------------------------------------------- */

  let config: BackupFileEntry | null = null;
  if (options.config != null) {
    const body = `${JSON.stringify(options.config, null, 2)}\n`;
    const target = join(out, CONFIG_FILE);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, 'utf8');
    const hashed = await hashFile(target);
    config = { path: CONFIG_FILE, sha256: hashed.sha256, size: hashed.size };
    progress({ phase: 'config', done: 1, total: 1, label: CONFIG_FILE });
  }

  /* The store ---------------------------------------------------------------------------------- */

  const storeRoot = options.storagePath == null ? null : resolve(options.storagePath);
  const { blobs: stored, ignored } = storeRoot === null
    ? { blobs: [], ignored: [] }
    : await listStoredBlobs(storeRoot);

  const blobs: BackupBlobEntry[] = [];
  const corrupt: CorruptBlob[] = [];
  let copied = 0;
  let reused = 0;
  let bytesWritten = databaseHash.size + (config?.size ?? 0);

  let index = 0;
  for (const blob of stored) {
    index += 1;
    progress({ phase: 'storage', done: index, total: stored.length, label: blob.sha256 });

    const relative = blobPath(blob.sha256);
    const target = join(out, relative);

    let digest: string;
    let size: number;

    if (includeBlobs) {
      // The **source** is hashed on every run, incremental or not.
      //
      // The reuse below saves the write, which is what makes a nightly snapshot over yesterday's
      // cheap; it must not save the read. An earlier version hashed only the destination and, on a
      // match, never opened the live file — so from the second snapshot onward rot in the live
      // store was invisible and `onCorruptBlob: 'fail'` could not fire, which is the one thing this
      // loop exists to do. Detecting rot in a store means reading the store.
      const sourceHash = await hashFile(blob.absolutePath);

      // The destination is hashed too when it is already there, because a backup that rotted is as
      // useless as a library that did. It is only reused when both sides agree with the name.
      const existingHash = existsSync(target) ? await hashFile(target) : null;
      if (
        sourceHash.sha256 === blob.sha256 &&
        existingHash !== null &&
        existingHash.sha256 === blob.sha256
      ) {
        digest = existingHash.sha256;
        size = existingHash.size;
        reused += 1;
      } else if (sourceHash.sha256 !== blob.sha256) {
        // Corrupt at the source. Reported below from the source's own digest; never copied, and
        // never left standing at the destination from a previous run either.
        digest = sourceHash.sha256;
        size = sourceHash.size;
      } else {
        const written = await copyFileHashing(blob.absolutePath, target);
        digest = written.sha256;
        size = written.size;
        copied += 1;
        bytesWritten += size;
      }
    } else {
      const hashed = await hashFile(blob.absolutePath);
      digest = hashed.sha256;
      size = hashed.size;
    }

    if (digest !== blob.sha256) {
      // Invariant D2: the bytes no longer are what their name says they are. Never record the
      // true digest under the old name and never record the old name over the true bytes; either
      // would launder the corruption into the backup.
      if (includeBlobs) await rm(target, { force: true });
      const failure: CorruptBlob = {
        key: blob.key,
        expectedSha256: blob.sha256,
        actualSha256: digest,
        size,
      };
      if (options.onCorruptBlob !== 'skip') {
        throw new BackupFormatError(
          `The blob '${blob.key}' in '${storeRoot ?? ''}' hashes to ${digest}, not to its own name. ` +
            'The store has rotted (invariant D2); the backup has not been completed. Investigate, ' +
            'or re-run allowing corrupt blobs to be skipped and listed.',
          { blob: failure },
        );
      }
      corrupt.push(failure);
      continue;
    }

    blobs.push({ path: relative, sha256: digest, size, key: blob.key });
  }

  const totalBytes = blobs.reduce((sum, blob) => sum + blob.size, 0);

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: clock(),
    generator: BACKUP_GENERATOR,
    database: {
      path: DATABASE_FILE,
      sha256: databaseHash.sha256,
      size: databaseHash.size,
      sqliteVersion: facts.sqliteVersion,
      pageSize: facts.pageSize,
      pageCount: facts.pageCount,
      integrityCheck: facts.integrityCheck,
      schema: facts.schema,
      tableCounts: facts.tableCounts,
    },
    config,
    storage: {
      backend: 'local',
      root: storeRoot,
      blobsIncluded: includeBlobs,
      blobCount: blobs.length,
      totalBytes,
      blobs,
    },
  };

  /* The index ----------------------------------------------------------------------------------- */

  progress({ phase: 'manifest', done: 0, total: 2, label: MANIFEST_FILE });

  const pruned = await pruneStaleFiles(
    out,
    new Set([...manifestFiles(manifest).map((file) => file.path), MANIFEST_FILE, CHECKSUMS_FILE]),
  );

  const manifestBody = serialiseManifest(manifest);
  await writeFile(join(out, MANIFEST_FILE), manifestBody, 'utf8');
  const manifestHash = await hashFile(join(out, MANIFEST_FILE));

  await writeFile(
    join(out, CHECKSUMS_FILE),
    renderChecksums([
      ...manifestFiles(manifest),
      { path: MANIFEST_FILE, sha256: manifestHash.sha256, size: manifestHash.size },
    ]),
    'utf8',
  );
  progress({ phase: 'manifest', done: 2, total: 2, label: CHECKSUMS_FILE });

  return {
    path: out,
    manifest,
    blobsCopied: copied,
    blobsReused: reused,
    filesPruned: pruned,
    bytesWritten,
    corruptBlobs: corrupt,
    ignoredStoreEntries: ignored,
  };
};
