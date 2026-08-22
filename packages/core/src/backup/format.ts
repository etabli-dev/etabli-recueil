/**
 * The names and the layout of a snapshot (CONCEPT.md §5.15).
 *
 * Everything about the on-disk shape that both halves — the writer and the reader — have to agree
 * on lives here, so that `create.ts` and `restore.ts` cannot drift apart by a directory name.
 * `FORMAT.md`, beside this file, is the prose version and is the document a third-party tool
 * should be able to implement from.
 */

/** The `format` field of the manifest. Present so a stray directory can be recognised. */
export const BACKUP_FORMAT = 'recueil-backup';

/**
 * Bumped when the layout changes in a way an older reader cannot handle.
 *
 * A reader refuses a version it does not know rather than guessing: half-restoring a library is
 * worse than not restoring it.
 */
export const BACKUP_FORMAT_VERSION = 1;

/** The index. Everything else in the snapshot is described by, and verified against, this file. */
export const MANIFEST_FILE = 'manifest.json';

/** `sha256sum -c` input, so the snapshot can be verified without Recueil (P10). */
export const CHECKSUMS_FILE = 'checksums.txt';

export const DATABASE_DIRECTORY = 'database';

/** The database, as the SQLite backup API wrote it. */
export const DATABASE_FILE = `${DATABASE_DIRECTORY}/library.sqlite`;

export const CONFIG_DIRECTORY = 'config';

/** The configuration the snapshot was taken with. Credentials are redacted by the caller. */
export const CONFIG_FILE = `${CONFIG_DIRECTORY}/recueil.json`;

/** The content-addressed store, in exactly the layout the live store uses (ADR-0004). */
export const STORAGE_DIRECTORY = 'storage';

/** What a restore writes the database to, inside the target directory. */
export const RESTORED_DATABASE_FILE = 'library.sqlite';

/** What a restore writes the store to, inside the target directory. */
export const RESTORED_STORAGE_DIRECTORY = 'storage';

/** What a restore writes the configuration to, inside the target directory. */
export const RESTORED_CONFIG_FILE = CONFIG_FILE;

/** 64 lowercase hex characters, which is both a blob's name and its identity. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** The fan-out path of a blob inside the snapshot: `storage/<aa>/<bb>/<sha256>`. */
export const blobPath = (sha256: string): string =>
  `${STORAGE_DIRECTORY}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
