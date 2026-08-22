/**
 * Reading a snapshot back (CONCEPT.md §5.15, "restore is tested in CI").
 *
 * The governing rule is that a restore verifies everything it writes. Every file named in the
 * manifest is hashed as it is copied, and the digest is compared with what the manifest says it
 * should be; a single mismatch fails the whole restore rather than leaving a library that is
 * mostly right. That is not defensiveness for its own sake — a backup is read years after it was
 * written, off media that has been moved twice, and the failure mode of an unverified restore is a
 * library that opens, looks plausible and has three broken PDFs in it.
 *
 * The second rule is that a restore never writes over anything by accident. The target must be
 * absent or empty; `force` is the operator saying, in as many words, that the contents of that
 * directory are expendable.
 *
 * What lands in the target is an ordinary Recueil deployment, not a special "restored" shape:
 *
 * ```
 * <target>/library.sqlite        RECUEIL_DATABASE_URL
 * <target>/storage/<aa>/<bb>/…   RECUEIL_STORAGE_PATH — byte-identical to the store that was backed up
 * <target>/config/recueil.json   the configuration the snapshot was taken with, for reference
 * ```
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { BackupFormatError, BackupTargetError, BackupVerificationError } from './errors.js';
import type { BackupVerificationFailure } from './errors.js';
import {
  MANIFEST_FILE,
  RESTORED_CONFIG_FILE,
  RESTORED_DATABASE_FILE,
  RESTORED_STORAGE_DIRECTORY,
} from './format.js';
import { copyFileHashing, hashFile, isEmptyDirectory } from './files.js';
import { inspectDatabaseFile } from './inspect.js';
import type { BackupFileEntry, BackupManifest } from './manifest.js';
import { manifestFiles, parseManifest } from './manifest.js';

/**
 * Find the snapshot root, given either it or the manifest inside it.
 *
 * Accepting both is not indulgence: `recueil restore <file>` is how §5.12 spells the command, and
 * a person who tab-completes their way to `manifest.json` should not be told they pointed at the
 * wrong thing.
 */
export const resolveSnapshotRoot = (from: string): string => {
  const target = resolve(from);
  if (target.endsWith(MANIFEST_FILE) && existsSync(target)) return dirname(target);
  if (existsSync(join(target, MANIFEST_FILE))) return target;

  throw new BackupFormatError(
    `No '${MANIFEST_FILE}' at '${target}'. A Recueil snapshot is a directory holding ` +
      `'${MANIFEST_FILE}'; point the restore at that directory, or at the file itself.`,
    { from: target },
  );
};

/** Read and parse the manifest of a snapshot. */
export const readManifest = async (from: string): Promise<{ root: string; manifest: BackupManifest }> => {
  const root = resolveSnapshotRoot(from);
  const path = join(root, MANIFEST_FILE);
  return { root, manifest: parseManifest(await readFile(path, 'utf8'), path) };
};

export interface VerifyBackupResult {
  readonly root: string;
  readonly manifest: BackupManifest;
  /** Empty when every file the manifest names is present and hashes to what it should. */
  readonly failures: readonly BackupVerificationFailure[];
  readonly filesChecked: number;
  readonly bytesChecked: number;
}

/**
 * Check a snapshot in place, without restoring it.
 *
 * This is the operation that turns "we have backups" into "we have backups that work", and it is
 * cheap enough — one pass over the bytes — to run on a schedule.
 */
export const verifyBackup = async (
  from: string,
  options: { onProgress?: (progress: RestoreProgress) => void } = {},
): Promise<VerifyBackupResult> => {
  const { root, manifest } = await readManifest(from);
  const progress = options.onProgress ?? ((): void => undefined);
  const files = manifestFiles(manifest);

  const failures: BackupVerificationFailure[] = [];
  let bytes = 0;
  let index = 0;

  for (const entry of files) {
    index += 1;
    progress({ phase: 'verify', done: index, total: files.length, label: entry.path });

    const path = join(root, entry.path);
    if (!existsSync(path)) {
      failures.push({
        path: entry.path,
        reason: 'missing',
        expectedSha256: entry.sha256,
        actualSha256: null,
        expectedSize: entry.size,
        actualSize: null,
      });
      continue;
    }

    const hashed = await hashFile(path);
    bytes += hashed.size;
    if (hashed.sha256 !== entry.sha256) {
      failures.push({
        path: entry.path,
        reason: hashed.size === entry.size ? 'hash' : 'size',
        expectedSha256: entry.sha256,
        actualSha256: hashed.sha256,
        expectedSize: entry.size,
        actualSize: hashed.size,
      });
    }
  }

  return { root, manifest, failures, filesChecked: files.length, bytesChecked: bytes };
};

export type RestorePhase = 'verify' | 'database' | 'config' | 'storage' | 'check';

export interface RestoreProgress {
  readonly phase: RestorePhase;
  readonly done: number;
  readonly total: number;
  readonly label: string | null;
}

export interface RestoreBackupOptions {
  /** The snapshot directory, or the `manifest.json` inside it. */
  readonly from: string;
  /** Where the library is written. Must be absent or empty unless `force`. */
  readonly into: string;
  /** Permission to write into a directory that already holds something. */
  readonly force?: boolean;
  readonly onProgress?: (progress: RestoreProgress) => void;
}

export interface RestoreResult {
  readonly manifest: BackupManifest;
  /** Absolute paths of what was written — what `RECUEIL_DATABASE_URL` and friends should be set to. */
  readonly databasePath: string;
  readonly storagePath: string;
  readonly configPath: string | null;
  readonly blobsRestored: number;
  readonly filesRestored: number;
  readonly bytesRestored: number;
  /** `PRAGMA integrity_check` on the restored database. */
  readonly integrityCheck: string;
  /** Table row counts of the restored database, against which the manifest's are compared. */
  readonly tableCounts: Readonly<Record<string, number>>;
}

const verificationFailure = (
  entry: BackupFileEntry,
  actual: { sha256: string; size: number },
): BackupVerificationFailure => ({
  path: entry.path,
  reason: actual.size === entry.size ? 'hash' : 'size',
  expectedSha256: entry.sha256,
  actualSha256: actual.sha256,
  expectedSize: entry.size,
  actualSize: actual.size,
});

/**
 * Where a snapshot-relative path lands in the target.
 *
 * The database and the configuration are placed where a Recueil deployment expects them; blobs
 * keep their content-addressed path exactly, which is what makes the restored store byte-identical
 * to the one that was backed up rather than merely equivalent to it.
 */
const targetFor = (manifest: BackupManifest, entry: BackupFileEntry): string => {
  if (entry.path === manifest.database.path) return RESTORED_DATABASE_FILE;
  if (manifest.config !== null && entry.path === manifest.config.path) return RESTORED_CONFIG_FILE;
  // `storage/<aa>/<bb>/<sha256>` — the same relative path on both sides.
  return entry.path;
};

export const restoreBackup = async (options: RestoreBackupOptions): Promise<RestoreResult> => {
  const { root, manifest } = await readManifest(options.from);
  const into = resolve(options.into);
  const progress = options.onProgress ?? ((): void => undefined);

  if (!(await isEmptyDirectory(into)) && options.force !== true) {
    throw new BackupTargetError(
      `'${into}' is not empty. A restore will not write over a library that is already there; ` +
        'pass force if the contents are genuinely expendable, or restore into an empty directory.',
      { into },
    );
  }

  if (!manifest.storage.blobsIncluded && manifest.storage.blobCount > 0) {
    throw new BackupFormatError(
      `This snapshot carries the storage manifest but not the blobs: ${manifest.storage.blobCount} ` +
        'files are listed and none are here. Restore the content-addressed store from wherever it ' +
        'is backed up, then restore this snapshot into the same directory with force.',
      { blobCount: manifest.storage.blobCount },
    );
  }

  await mkdir(into, { recursive: true });
  await mkdir(join(into, RESTORED_STORAGE_DIRECTORY), { recursive: true });

  // A database file restored next to somebody else's write-ahead log is a corrupt database. Under
  // `force` the old one goes first, in full.
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(join(into, `${RESTORED_DATABASE_FILE}${suffix}`), { force: true });
  }

  const files = manifestFiles(manifest);
  const failures: BackupVerificationFailure[] = [];
  const written: string[] = [];

  let bytes = 0;
  let blobs = 0;
  let index = 0;

  for (const entry of files) {
    index += 1;
    const phase: RestorePhase =
      entry.path === manifest.database.path
        ? 'database'
        : manifest.config !== null && entry.path === manifest.config.path
          ? 'config'
          : 'storage';
    progress({ phase, done: index, total: files.length, label: entry.path });

    const source = join(root, entry.path);
    if (!existsSync(source)) {
      failures.push({
        path: entry.path,
        reason: 'missing',
        expectedSha256: entry.sha256,
        actualSha256: null,
        expectedSize: entry.size,
        actualSize: null,
      });
      continue;
    }

    const destination = join(into, targetFor(manifest, entry));
    const copied = await copyFileHashing(source, destination);
    written.push(destination);

    if (copied.sha256 !== entry.sha256 || copied.size !== entry.size) {
      failures.push(verificationFailure(entry, copied));
      continue;
    }
    bytes += copied.size;
    if (phase === 'storage') blobs += 1;
  }

  if (failures.length > 0) {
    // Nothing half-restored is left behind: a directory that looks like a library but is not one
    // is the single most dangerous thing this function could produce.
    for (const path of written) await rm(path, { force: true });
    throw new BackupVerificationError(failures, `restoring '${root}' into '${into}'`);
  }

  /* Does the database that arrived behave like the one that left? ------------------------------ */

  progress({ phase: 'check', done: 0, total: 1, label: RESTORED_DATABASE_FILE });
  const databasePath = join(into, RESTORED_DATABASE_FILE);
  const facts = inspectDatabaseFile(databasePath, {
    counts: Object.keys(manifest.database.tableCounts).length > 0,
  });

  if (facts.integrityCheck !== 'ok') {
    throw new BackupVerificationError(
      [
        {
          path: manifest.database.path,
          reason: 'hash',
          expectedSha256: manifest.database.sha256,
          actualSha256: null,
          expectedSize: manifest.database.size,
          actualSize: null,
        },
      ],
      `the restored database at '${databasePath}' fails SQLite's integrity check (${facts.integrityCheck})`,
    );
  }

  const countMismatches = Object.entries(manifest.database.tableCounts)
    .filter(([table, expected]) => facts.tableCounts[table] !== expected)
    .map(([table, expected]) => ({ table, expected, actual: facts.tableCounts[table] ?? null }));

  if (countMismatches.length > 0) {
    throw new BackupFormatError(
      `The restored database does not hold what the manifest says it should: ` +
        `${countMismatches.map((row) => `${row.table} ${String(row.actual)}≠${row.expected}`).join(', ')}.`,
      { mismatches: countMismatches },
    );
  }

  progress({ phase: 'check', done: 1, total: 1, label: RESTORED_DATABASE_FILE });

  return {
    manifest,
    databasePath,
    storagePath: join(into, RESTORED_STORAGE_DIRECTORY),
    configPath: manifest.config === null ? null : join(into, RESTORED_CONFIG_FILE),
    blobsRestored: blobs,
    filesRestored: files.length,
    bytesRestored: bytes,
    integrityCheck: facts.integrityCheck,
    tableCounts: facts.tableCounts,
  };
};
