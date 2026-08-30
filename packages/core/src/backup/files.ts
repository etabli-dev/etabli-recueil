/**
 * The filesystem primitives a snapshot is built out of.
 *
 * Every one of them streams. A library holds four-hundred-megabyte scans, and a backup that
 * buffered a blob to hash it and buffered it again to copy it would need a gigabyte of resident
 * memory to move one file. Copying and hashing are the same pass for the same reason: reading the
 * bytes twice doubles the I/O of the whole operation and opens a window in which the file can
 * change between the hash and the copy.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { BackupFormatError } from './errors.js';
import { SHA256_PATTERN } from './format.js';

/** `LocalFsBackend`'s scratch directory for partial writes. Not blobs, and never backed up. */
const TEMP_DIRECTORY = '.tmp';

export interface HashedFile {
  readonly sha256: string;
  readonly size: number;
}

/** Hash a file without copying it. */
export const hashFile = async (path: string): Promise<HashedFile> => {
  const hash = createHash('sha256');
  let size = 0;
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    size += buffer.byteLength;
  }
  return { sha256: hash.digest('hex'), size };
};

/**
 * Copy a file, returning the digest of what was actually copied.
 *
 * Written through a temporary name in the destination directory and renamed into place, so an
 * interrupted backup leaves a `.part` file rather than a short file at a name the manifest will
 * claim is complete. The rename is within one directory and therefore within one filesystem, which
 * is what makes it atomic.
 */
export const copyFileHashing = async (from: string, to: string): Promise<HashedFile> => {
  await mkdir(dirname(to), { recursive: true });
  const temporary = `${to}.part`;
  const hash = createHash('sha256');
  let size = 0;

  const source = createReadStream(from);
  source.on('data', (chunk: string | Buffer) => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    hash.update(buffer);
    size += buffer.byteLength;
  });

  try {
    await pipeline(source, createWriteStream(temporary));
    await rename(temporary, to);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  return { sha256: hash.digest('hex'), size };
};

/**
 * The largest `manifest.json` this build will read into memory (ADR-0022 §2).
 *
 * A manifest is data off removable media, and `parseManifest` needs the whole of it as a string
 * before `JSON.parse` can see a single key — so an unbounded read is the caller's resident set in
 * somebody else's hands. Two hundred and fifty-six mebibytes is roughly three and a half million
 * blob entries, far past any library this is meant for, and a snapshot larger than that is a
 * refusal naming the limit rather than an out-of-memory kill or V8's opaque `ERR_STRING_TOO_LONG`.
 *
 * The `stat` is a fast rejection over metadata, so it cannot be the only bound; the read that
 * follows is capped by the same number through an explicit byte budget rather than trusting it.
 */
export const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

/**
 * Read a manifest file, refusing one too large to hold.
 *
 * `maxBytes` is a parameter and not only a constant so that a test can drive the refusal without
 * writing a quarter of a gigabyte: ADR-0022 asks for a test that goes past the limit and watches a
 * clean refusal, and a limit that can only be exceeded by exceeding it is a limit nobody tests.
 */
export const readManifestFile = async (path: string, maxBytes = MAX_MANIFEST_BYTES): Promise<string> => {
  const found = await stat(path).catch(() => null);
  if (found !== null && found.size > maxBytes) {
    throw new BackupFormatError(
      `'${path}' is ${found.size} bytes; a Recueil manifest is read whole and this build will ` +
        `not read more than ${maxBytes}. That file is not a manifest this snapshot can be ` +
        'restored from.',
      { path, size: found.size, limit: maxBytes },
    );
  }

  // Bounded by the read itself and not by the `stat` above: the file can grow between the two, and
  // on removable media the size the filesystem reports is not a promise about the bytes. The
  // stream is destroyed the moment the running total passes the limit, so the refusal costs one
  // chunk rather than the whole file.
  const stream = createReadStream(path);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new BackupFormatError(
        `'${path}' passed ${maxBytes} bytes while being read; a Recueil manifest is read whole ` +
          'and this build will not read more than that.',
        { path, limit: maxBytes },
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * Join a snapshot-relative path onto a root and prove the result is inside it.
 *
 * The belt to `assertSnapshotRelativePath`'s braces. The syntactic check runs at the parse and
 * catches everything a manifest can say; this one runs at the I/O and catches what the filesystem
 * can do that the syntax cannot express — a symlinked directory inside the snapshot, a root that is
 * itself a relative path, a platform that treats a character as a separator when we did not.
 */
export const resolveWithin = (root: string, relative: string): string => {
  const base = resolve(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) {
    throw new BackupFormatError(
      `'${relative}' resolves to '${target}', which is outside '${base}'. A snapshot never ` +
        'addresses anything beyond its own root, on either side of a restore.',
      { root: base, relative, resolved: target },
    );
  }
  return target;
};

/** True when the path does not exist, or is a directory containing nothing. */
export const isEmptyDirectory = async (path: string): Promise<boolean> => {
  const found = await stat(path).catch(() => null);
  if (found === null) return true;
  if (!found.isDirectory()) return false;
  return (await readdir(path)).length === 0;
};

/** One blob found in a content-addressed store. */
export interface StoredBlob {
  /** The digest the file's name asserts. */
  readonly sha256: string;
  readonly absolutePath: string;
  /** `<aa>/<bb>/<sha256>`. */
  readonly key: string;
  readonly size: number;
}

/**
 * Every blob in a local content-addressed store, in digest order.
 *
 * Only files whose position and name agree with ADR-0004's layout are returned — `<aa>/<bb>/` from
 * the first four characters of a 64-character lowercase hex name. Everything else is ignored
 * rather than copied: `.tmp/` holds the partial writes of an in-flight ingest, and a stray file a
 * person dropped into the store is not a blob and must not be given a digest it does not have.
 * What was ignored is returned alongside, because "the backup silently skipped 4,000 files" is
 * exactly the sort of thing that must not be silent.
 */
export const listStoredBlobs = async (
  root: string,
): Promise<{ blobs: StoredBlob[]; ignored: string[] }> => {
  const blobs: StoredBlob[] = [];
  const ignored: string[] = [];

  const rootStat = await stat(root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) return { blobs, ignored };

  for (const first of await readdir(root, { withFileTypes: true })) {
    // `.tmp/` is the store's own scratch directory for in-flight writes (ADR-0004). It is expected
    // and it is never blobs, so it is skipped silently; anything else is reported.
    if (first.name === TEMP_DIRECTORY) continue;
    if (!first.isDirectory() || !/^[0-9a-f]{2}$/u.test(first.name)) {
      ignored.push(first.name);
      continue;
    }
    const firstPath = join(root, first.name);

    for (const second of await readdir(firstPath, { withFileTypes: true })) {
      if (!second.isDirectory() || !/^[0-9a-f]{2}$/u.test(second.name)) {
        ignored.push(`${first.name}${sep}${second.name}`);
        continue;
      }
      const secondPath = join(firstPath, second.name);

      for (const entry of await readdir(secondPath, { withFileTypes: true })) {
        const relative = `${first.name}/${second.name}/${entry.name}`;
        if (
          !entry.isFile() ||
          !SHA256_PATTERN.test(entry.name) ||
          !entry.name.startsWith(`${first.name}${second.name}`)
        ) {
          ignored.push(relative);
          continue;
        }
        const absolutePath = join(secondPath, entry.name);
        const found = await stat(absolutePath);
        blobs.push({ sha256: entry.name, absolutePath, key: relative, size: found.size });
      }
    }
  }

  blobs.sort((left, right) => (left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0));
  ignored.sort();
  return { blobs, ignored };
};

/** Every file under `root`, as forward-slashed paths relative to it. */
export const listFilesRecursively = async (root: string, prefix = ''): Promise<string[]> => {
  const found = await stat(root).catch(() => null);
  if (found === null || !found.isDirectory()) return [];

  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFilesRecursively(join(root, entry.name), relative)));
    else out.push(relative);
  }
  return out;
};
