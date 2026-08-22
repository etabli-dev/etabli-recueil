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
 * the temp copy and reports `created: false`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { Readable as NodeReadable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { newId } from '../ids.js';
import type { BlobSource, BlobStat, PutResult, StorageBackend } from './backend.js';
import { assertSha256, storageKeyFor } from './backend.js';

const TEMP_DIRECTORY = '.tmp';

export interface LocalFsBackendOptions {
  /** The store root. Created if it does not exist. */
  root: string;
}

export class LocalFsBackend implements StorageBackend {
  readonly backend = 'local' as const;

  readonly root: string;

  private readonly tempRoot: string;

  private prepared = false;

  constructor(options: LocalFsBackendOptions) {
    this.root = options.root;
    this.tempRoot = join(options.root, TEMP_DIRECTORY);
  }

  /** Absolute path of a blob. Pure — it does not touch the disk. */
  path(sha256: string): string {
    return join(this.root, ...storageKeyFor(sha256).split('/'));
  }

  /** The `documents.storage_key` for a digest. */
  key(sha256: string): string {
    return storageKeyFor(sha256);
  }

  async put(source: BlobSource): Promise<PutResult> {
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
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    const sha256 = hash.digest('hex');
    const finalPath = this.path(sha256);

    try {
      const existing = await stat(finalPath).catch(() => null);
      if (existing !== null) {
        // The bytes are already here. Never rewrite them: a content-addressed store that rewrites
        // is one bug away from writing the wrong bytes under a digest that promises otherwise.
        await rm(temporaryPath, { force: true });
        return { sha256, size: existing.size, key: storageKeyFor(sha256), created: false };
      }

      await mkdir(dirname(finalPath), { recursive: true });
      await rename(temporaryPath, finalPath);
      return { sha256, size, key: storageKeyFor(sha256), created: true };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
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
