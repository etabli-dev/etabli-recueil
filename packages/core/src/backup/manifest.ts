/**
 * The manifest: what is in a snapshot, and what each file has to hash to.
 *
 * Three rules shape it.
 *
 * **Its paths are checked before they are used.** A manifest is data off removable media, and its
 * `path` fields are joined onto the snapshot root to read and onto the restore target to write. An
 * entry that escapes either root is rejected at the parse (`assertSnapshotRelativePath`), so no
 * consumer has to remember to check.
 *
 * **It is the only index.** Nothing in a snapshot is discovered by walking the directory — a
 * restore reads the manifest and asks for exactly the files it names. A blob that is on disk but
 * not in the manifest is therefore not restored, and a blob that is in the manifest but not on
 * disk is a hard failure rather than a quiet omission. That is the difference between a snapshot
 * and a directory that happens to contain some files.
 *
 * **It is written byte-stably.** Keys are emitted in a fixed order and the blob list is sorted by
 * digest, so two backups of an unchanged library produce an identical `manifest.json`. Together
 * with the content-addressed store — where an unchanged blob is the same bytes at the same path —
 * that is what makes the layout restic-friendly: the deduplicating backup program sees a tree in
 * which almost nothing changed.
 */
import { assertSnapshotRelativePath, BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from './format.js';
import { BackupFormatError } from './errors.js';

/** A file in the snapshot, addressed by its snapshot-relative path. */
export interface BackupFileEntry {
  /** Forward-slashed and relative to the snapshot root, on every platform. */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/** A blob, which additionally carries the store key its digest implies. */
export interface BackupBlobEntry extends BackupFileEntry {
  /** `<aa>/<bb>/<sha256>` — the key `documents.storage_key` holds (ADR-0004). */
  readonly key: string;
}

/** What the migration table said at the moment of the snapshot. */
export interface BackupSchemaState {
  /** How many migrations had been applied. */
  readonly applied: number;
  /** The hash of the last one, as drizzle records it. Null for an unmigrated database. */
  readonly latestHash: string | null;
  /** Its `created_at`, in drizzle's own millisecond form. Null for an unmigrated database. */
  readonly latestCreatedAt: number | null;
}

export interface BackupDatabaseManifest extends BackupFileEntry {
  /** The SQLite library that took the snapshot. */
  readonly sqliteVersion: string;
  readonly pageSize: number;
  readonly pageCount: number;
  /** `PRAGMA integrity_check` run against the snapshot, not against the live database. */
  readonly integrityCheck: string;
  readonly schema: BackupSchemaState;
  /**
   * Row counts per table, from the snapshot.
   *
   * They are what makes "the restored database is the one that was backed up" checkable without a
   * byte comparison — a restored file is never byte-identical to the source, because the backup
   * API rewrites the free list and the WAL is folded in.
   */
  readonly tableCounts: Readonly<Record<string, number>>;
}

export interface BackupStorageManifest {
  /** `local`, `webdav`, `s3` — whichever backend the store was read from. */
  readonly backend: string;
  /** The live store root the snapshot was taken from, for the operator's benefit only. */
  readonly root: string | null;
  /** False for a manifest-only snapshot: the digests are listed, the bytes are elsewhere. */
  readonly blobsIncluded: boolean;
  readonly blobCount: number;
  readonly totalBytes: number;
  /** Sorted by digest, so an unchanged store produces an unchanged manifest. */
  readonly blobs: readonly BackupBlobEntry[];
}

export interface BackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly formatVersion: number;
  readonly createdAt: string;
  readonly generator: { readonly name: string; readonly version: string };
  readonly database: BackupDatabaseManifest;
  /** Null when the caller recorded no configuration. */
  readonly config: BackupFileEntry | null;
  readonly storage: BackupStorageManifest;
}

/**
 * Serialise the manifest.
 *
 * `JSON.stringify` preserves insertion order, and every object in this module is built in a fixed
 * order, so the output is stable without a canonicalising pass. Indented, because a person reading
 * a backup directory at three in the morning is a real user of this file.
 */
export const serialiseManifest = (manifest: BackupManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackupFormatError(`${what} is not an object.`);
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new BackupFormatError(`${what} is not a string.`);
  return value;
};

const asNumber = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BackupFormatError(`${what} is not a number.`);
  }
  return value;
};

const asFileEntry = (value: unknown, what: string): BackupFileEntry => {
  const record = asRecord(value, what);
  return {
    // Checked here, at the parse, rather than at each use: this is the earliest point at which the
    // string exists, and it is the only point that every consumer — `verifyBackup`, `restoreBackup`
    // and anything a later phase adds — is guaranteed to pass through. A path that escapes the
    // snapshot root never becomes a `BackupFileEntry` at all.
    path: assertSnapshotRelativePath(asString(record['path'], `${what}.path`), `${what}.path`),
    sha256: asString(record['sha256'], `${what}.sha256`),
    size: asNumber(record['size'], `${what}.size`),
  };
};

/**
 * Parse a manifest, refusing anything that is not one.
 *
 * Deliberately hand-written rather than delegated to a schema package: `@recueil/core` is the
 * bottom of the stack, and a restore has to work in a rescue shell where the only thing that is
 * certainly present is this package.
 */
export const parseManifest = (raw: string, where: string): BackupManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new BackupFormatError(`${where} is not valid JSON.`, { cause: String(cause) });
  }

  const root = asRecord(parsed, where);
  if (root['format'] !== BACKUP_FORMAT) {
    throw new BackupFormatError(
      `${where} is not a Recueil backup: expected format '${BACKUP_FORMAT}', found ` +
        `'${String(root['format'])}'.`,
      { found: root['format'] },
    );
  }

  const formatVersion = asNumber(root['formatVersion'], `${where}.formatVersion`);
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupFormatError(
      `${where} was written in backup format version ${formatVersion}; this build reads up to ` +
        `${BACKUP_FORMAT_VERSION}. Restore it with the version of Recueil that wrote it.`,
      { formatVersion, supported: BACKUP_FORMAT_VERSION },
    );
  }

  const database = asRecord(root['database'], `${where}.database`);
  const storage = asRecord(root['storage'], `${where}.storage`);
  const generator = asRecord(root['generator'], `${where}.generator`);
  const schema = asRecord(database['schema'], `${where}.database.schema`);

  const blobsRaw = storage['blobs'];
  if (!Array.isArray(blobsRaw)) throw new BackupFormatError(`${where}.storage.blobs is not an array.`);

  const blobs: BackupBlobEntry[] = blobsRaw.map((entry, index) => {
    const file = asFileEntry(entry, `${where}.storage.blobs[${index}]`);
    const record = asRecord(entry, `${where}.storage.blobs[${index}]`);
    return { ...file, key: asString(record['key'], `${where}.storage.blobs[${index}].key`) };
  });

  return {
    format: BACKUP_FORMAT,
    formatVersion,
    createdAt: asString(root['createdAt'], `${where}.createdAt`),
    generator: {
      name: asString(generator['name'], `${where}.generator.name`),
      version: asString(generator['version'], `${where}.generator.version`),
    },
    database: {
      ...asFileEntry(database, `${where}.database`),
      sqliteVersion: asString(database['sqliteVersion'], `${where}.database.sqliteVersion`),
      pageSize: asNumber(database['pageSize'], `${where}.database.pageSize`),
      pageCount: asNumber(database['pageCount'], `${where}.database.pageCount`),
      integrityCheck: asString(database['integrityCheck'], `${where}.database.integrityCheck`),
      schema: {
        applied: asNumber(schema['applied'], `${where}.database.schema.applied`),
        latestHash: typeof schema['latestHash'] === 'string' ? schema['latestHash'] : null,
        latestCreatedAt: typeof schema['latestCreatedAt'] === 'number' ? schema['latestCreatedAt'] : null,
      },
      tableCounts: asRecord(database['tableCounts'], `${where}.database.tableCounts`) as Record<string, number>,
    },
    config: root['config'] === null || root['config'] === undefined
      ? null
      : asFileEntry(root['config'], `${where}.config`),
    storage: {
      backend: asString(storage['backend'], `${where}.storage.backend`),
      root: typeof storage['root'] === 'string' ? storage['root'] : null,
      blobsIncluded: storage['blobsIncluded'] !== false,
      blobCount: asNumber(storage['blobCount'], `${where}.storage.blobCount`),
      totalBytes: asNumber(storage['totalBytes'], `${where}.storage.totalBytes`),
      blobs,
    },
  };
};

/** Every file the manifest claims the snapshot holds, in the order a restore should read them. */
export const manifestFiles = (manifest: BackupManifest): readonly BackupFileEntry[] => [
  manifest.database,
  ...(manifest.config === null ? [] : [manifest.config]),
  ...(manifest.storage.blobsIncluded ? manifest.storage.blobs : []),
];

/**
 * The `checksums.txt` body: `sha256sum -c` input, sorted by path.
 *
 * The point is P10. A snapshot has to be verifiable, and restorable, by someone who does not have
 * Recueil — with `sha256sum -c checksums.txt` and `cp`.
 */
export const renderChecksums = (entries: readonly BackupFileEntry[]): string =>
  `${[...entries]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((entry) => `${entry.sha256}  ${entry.path}`)
    .join('\n')}\n`;
