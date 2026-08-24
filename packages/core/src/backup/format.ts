/**
 * The names and the layout of a snapshot (CONCEPT.md §5.15).
 *
 * Everything about the on-disk shape that both halves — the writer and the reader — have to agree
 * on lives here, so that `create.ts` and `restore.ts` cannot drift apart by a directory name.
 * `FORMAT.md`, beside this file, is the prose version and is the document a third-party tool
 * should be able to implement from.
 */

import { BackupFormatError } from './errors.js';

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

/**
 * What a path inside a snapshot may look like.
 *
 * A manifest is data, and a restore reads it off media that has been carried across machines and
 * years. Its `path` fields address files on **both** sides of the operation — they are joined onto
 * the snapshot root to read and onto the target directory to write — so an entry reading
 * `../../.ssh/authorized_keys` reads outside the snapshot, writes outside the target, and is then
 * deleted by the rollback that tidies up after a failed restore. That is arbitrary file write and
 * arbitrary file delete from a backup archive.
 *
 * The rule is an allow-list rather than a search for `..`, because a blocklist over path syntax is
 * a losing game: `.`/`..`, a leading slash, a Windows drive letter, a UNC prefix, a backslash that
 * is a separator on one platform and a filename character on another, an embedded NUL, a URL
 * escape. Every path this format ever writes is
 * `database/library.sqlite`, `config/recueil.json` or `storage/<aa>/<bb>/<sha256>`, so the
 * characters those need are the characters allowed.
 */
const SNAPSHOT_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/u;

/**
 * Check that a manifest path addresses something inside the snapshot, and return it unchanged.
 *
 * Called before any I/O, on the read side and the write side alike. Throws rather than sanitising:
 * a manifest carrying a path like this is not a Recueil snapshot with a typo in it, and quietly
 * rewriting the entry would restore a library that does not correspond to what was backed up.
 */
export const assertSnapshotRelativePath = (path: string, where: string): string => {
  const reject = (reason: string): never => {
    throw new BackupFormatError(
      `${where} is not a path inside the snapshot: '${path}' ${reason}. A snapshot path is ` +
        'relative, forward-slashed, and made of the characters a Recueil backup writes.',
      { path, where, reason },
    );
  };

  if (path === '') reject('is empty');
  if (path.includes('\u0000')) reject('contains a NUL');
  if (path.includes('\\')) reject('contains a backslash');
  if (path.startsWith('/')) reject('is absolute');
  if (/^[A-Za-z]:/u.test(path)) reject('names a Windows drive');

  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '') reject('has an empty segment');
    if (segment === '.' || segment === '..') reject(`has a '${segment}' segment`);
    if (!SNAPSHOT_PATH_SEGMENT.test(segment)) reject(`has the segment '${segment}'`);
  }
  return path;
};
