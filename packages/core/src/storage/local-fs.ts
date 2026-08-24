/**
 * The local filesystem backend (ADR-0004).
 *
 * Layout is `<root>/<aa>/<bb>/<sha256>`, two levels of fan-out from the leading four hex
 * characters. The fan-out is not decoration: a single directory holding a hundred thousand files is
 * slow to list on every filesystem worth naming, and the two levels give 65 536 buckets, which is
 * enough that a large personal library keeps a few dozen files per directory.
 *
 * Two properties matter more than anything else here, and both are P10 promises as much as
 * correctness ones — the store must stay readable, and stay right, without the application:
 *
 * 1. **The digest is computed from the bytes as they are written**, never taken from the caller.
 *    A client that uploads a file with a wrong `sha256` gets the true digest back, not its claim.
 * 2. **Writes are atomic.** Bytes go to a temporary file in `<root>/.tmp` and are renamed into
 *    place, so an interrupted write leaves a stray temp file and never a truncated blob at a name
 *    that asserts a digest it does not have. `rename(2)` within one filesystem is atomic, which is
 *    why the temp directory is inside the root and not in `/tmp`.
 *
 * A `put` of bytes already present does not rewrite the blob. It hashes, discovers the file, drops
 * the temp copy and reports `created: false` — but only after **verifying what is already there**.
 * The presence of a file at the digest path is not evidence that the file holds those bytes: the
 * name is an assertion, and media rot, a truncated write on a full disk or a restore from a damaged
 * archive all leave a file whose name is a lie. Treating the name as proof would mean a `put` of
 * the correct bytes over a rotted blob silently discards the correct bytes, which is the one
 * failure ADR-0004 says this store must not have. So an existing object is checked — its length
 * always, its digest when `verifyOnPut: 'digest'` is set — and a mismatch is repaired from the
 * bytes in hand rather than trusted.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { Readable as NodeReadable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { newId } from '../ids.js';
import type {
  BlobSource,
  BlobStat,
  PutOptions,
  PutResult,
  PutVerification,
  StorageBackend,
} from './backend.js';
import { assertSha256, storageKeyFor } from './backend.js';

const TEMP_DIRECTORY = '.tmp';

export interface LocalFsBackendOptions {
  /** The store root. Created if it does not exist. */
  root: string;
  /**
   * How much of an object already in the store is checked before a `put` reports `created: false`.
   *
   * `size` — the default — compares the length of the stored object with the length of the bytes
   * just hashed. It is one `stat`, it catches every truncation, and truncation is what an
   * interrupted write, a full disk and a half-finished copy all produce. `digest` re-reads the
   * stored object and compares its hash, which also catches in-place rot at unchanged length, and
   * costs a full read of a blob that may be four hundred megabytes.
   *
   * Neither setting can lose the incoming bytes: a failed check repairs the blob from them.
   */
  verifyOnPut?: PutVerification;
}

/** A partial write left in `.tmp` by an interrupted `put`. */
export interface StrayTempFile {
  /** Absolute path, so an operator can look at it or delete it. */
  path: string;
  size: number;
  /** Last modification, which is how old the interrupted write is. */
  modifiedAt: Date;
}

export class LocalFsBackend implements StorageBackend {
  readonly backend = 'local' as const;

  readonly root: string;

  private readonly tempRoot: string;

  private readonly verifyOnPut: PutVerification;

  private prepared = false;

  constructor(options: LocalFsBackendOptions) {
    this.root = options.root;
    this.tempRoot = join(options.root, TEMP_DIRECTORY);
    this.verifyOnPut = options.verifyOnPut ?? 'size';
  }

  /** Absolute path of a blob. Pure — it does not touch the disk. */
  path(sha256: string): string {
    return join(this.root, ...storageKeyFor(sha256).split('/'));
  }

  /** The `documents.storage_key` for a digest. */
  key(sha256: string): string {
    return storageKeyFor(sha256);
  }

  async put(source: BlobSource, options: PutOptions = {}): Promise<PutResult> {
    await this.prepare();

    const temporaryPath = join(this.tempRoot, `${newId()}.part`);
    const hash = createHash('sha256');
    let size = 0;

    const stream = toReadable(source);
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hash.update(buffer);
      size += buffer.byteLength;
    });

    try {
      await pipeline(stream, createWriteStream(temporaryPath, { flags: 'wx' }));
      // Durable before the rename, so a crash between the two cannot leave a name asserting a
      // digest over bytes still in the page cache.
      // `r+` rather than `r`: `fsync` on a read-only descriptor is allowed on Linux and is not
      // portable, and this store is meant to be readable — and writable — on any platform.
      const handle = await open(temporaryPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    const sha256 = hash.digest('hex');
    const finalPath = this.path(sha256);

    try {
      const existing = await stat(finalPath).catch(() => null);
      if (existing !== null) {
        const verification = options.verify ?? this.verifyOnPut;
        const sound =
          existing.size === size &&
          (verification === 'size' || (await this.digestOf(finalPath)) === sha256);

        if (sound) {
          // The bytes really are here. Never rewrite them: a content-addressed store that rewrites
          // what it has already verified is one bug away from writing the wrong bytes under a
          // digest that promises otherwise.
          await rm(temporaryPath, { force: true });
          return { sha256, size: existing.size, key: storageKeyFor(sha256), created: false, repaired: false };
        }

        // The file at this path is not these bytes, whatever its name says. The bytes in hand were
        // hashed on the way in and are known to be right, so they win; discarding them in favour
        // of a corrupt blob is silent data loss (ADR-0004).
        await mkdir(dirname(finalPath), { recursive: true });
        await rename(temporaryPath, finalPath);
        return { sha256, size, key: storageKeyFor(sha256), created: true, repaired: true };
      }

      await mkdir(dirname(finalPath), { recursive: true });
      await rename(temporaryPath, finalPath);
      return { sha256, size, key: storageKeyFor(sha256), created: true, repaired: false };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  /**
   * Partial writes left in `.tmp` by a `put` that never finished.
   *
   * They are invisible to `listStoredBlobs` by design — a `.part` file is not a blob and must never
   * be given a digest it does not have — but invisible is not the same as absent, and a store that
   * quietly accumulates half-written four-hundred-megabyte scans until the disk fills is a fault
   * report nobody can diagnose. Reported rather than deleted: the caller decides, because a `.part`
   * file thirty seconds old belongs to an upload that is still running.
   */
  async listStrayTempFiles(): Promise<StrayTempFile[]> {
    const entries = await readdir(this.tempRoot, { withFileTypes: true }).catch(() => []);
    const stray: StrayTempFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
      const path = join(this.tempRoot, entry.name);
      const found = await stat(path).catch(() => null);
      if (found === null) continue;
      stray.push({ path, size: found.size, modifiedAt: found.mtime });
    }
    stray.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return stray;
  }

  /**
   * Delete the partial writes older than `olderThanMs` (one hour by default), and say how many.
   *
   * The age bound is the whole safety argument: a `.part` file belongs to a `put` that may still be
   * streaming, and the only thing distinguishing "abandoned" from "in flight" is how long it has
   * been since anything was written to it.
   */
  async sweepTempFiles(olderThanMs = 3_600_000): Promise<{ removed: number; bytes: number }> {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    let bytes = 0;
    for (const file of await this.listStrayTempFiles()) {
      if (file.modifiedAt.getTime() > cutoff) continue;
      await rm(file.path, { force: true });
      removed += 1;
      bytes += file.size;
    }
    return { removed, bytes };
  }

  /** The digest of whatever is at this path, streamed. */
  private async digestOf(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }

  async get(sha256: string): Promise<Readable> {
    if (!(await this.has(sha256))) {
      throw new Error(`Blob not in the store: ${sha256}`);
    }
    return createReadStream(this.path(sha256));
  }

  async getBuffer(sha256: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.get(sha256)) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks);
  }

  async has(sha256: string): Promise<boolean> {
    return (await stat(this.path(assertSha256(sha256))).catch(() => null)) !== null;
  }

  async stat(sha256: string): Promise<BlobStat | null> {
    const found = await stat(this.path(assertSha256(sha256))).catch(() => null);
    if (found === null) return null;
    return { sha256, size: found.size, key: storageKeyFor(sha256) };
  }

  async delete(sha256: string): Promise<boolean> {
    const target = this.path(assertSha256(sha256));
    try {
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    // Leave no empty fan-out directories behind. Both calls fail harmlessly when a sibling remains.
    await rmdir(dirname(target)).catch(() => undefined);
    await rmdir(dirname(dirname(target))).catch(() => undefined);
    return true;
  }

  /**
   * Re-read a blob and confirm its bytes still hash to its name. This is the `attachment_integrity`
   * check of CONCEPT §5.5 at the storage layer; a mismatch is invariant D2's hard failure, and the
   * caller must set `documents.storage_ok = 0` rather than rewrite the digest.
   */
  async verify(sha256: string): Promise<boolean> {
    if (!(await this.has(sha256))) return false;
    const hash = createHash('sha256');
    await pipeline(createReadStream(this.path(sha256)), async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk as Buffer);
        yield chunk;
      }
    });
    return hash.digest('hex') === sha256;
  }

  /** Create the root and the temp directory once per process. */
  private async prepare(): Promise<void> {
    if (this.prepared) return;
    await mkdir(this.tempRoot, { recursive: true });
    this.prepared = true;
  }
}

const toReadable = (source: BlobSource): Readable => {
  if (Buffer.isBuffer(source)) return NodeReadable.from([source]);
  if (source instanceof Uint8Array) return NodeReadable.from([Buffer.from(source)]);
  return source;
};
