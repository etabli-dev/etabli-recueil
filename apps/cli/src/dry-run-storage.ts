/**
 * The store a dry run writes to.
 *
 * `recueil import zotero --dry-run` has to answer one question honestly: *what would this import
 * do?* The only way to answer it honestly is to do it — map every item, resolve every attachment,
 * hash every file — and then throw the result away. So a dry run opens an in-memory database and
 * hands the services this backend instead of the real one.
 *
 * It hashes exactly as `LocalFsBackend` does and discards the bytes. That is the difference
 * between a dry run that costs a pass over the files and one that costs a second copy of a
 * twenty-gigabyte library on a disk that may not have room for it — and the hash is the part that
 * matters, because the hash is what the attachment-coverage report is made of (CONCEPT §6).
 *
 * It is a `local` backend as far as the throwaway database is concerned, because that database is
 * deleted when the process ends and nothing will ever read the column. Reading a blob back is
 * refused rather than faked: no importer does it, and a silent empty buffer would be a lie the
 * report might be built on.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { storageKeyFor } from '@recueil/core';
import type { BlobSource, BlobStat, PutResult, StorageBackend } from '@recueil/core';

export class DryRunStorage implements StorageBackend {
  readonly backend = 'local' as const;

  /** Digest to byte size, for everything this run has seen. */
  readonly #seen = new Map<string, number>();

  /** How many blobs would have been written, and how many bytes they would have occupied. */
  get summary(): { blobs: number; bytes: number } {
    let bytes = 0;
    for (const size of this.#seen.values()) bytes += size;
    return { blobs: this.#seen.size, bytes };
  }

  async put(source: BlobSource): Promise<PutResult> {
    const hash = createHash('sha256');
    let size = 0;

    for await (const chunk of toReadable(source)) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      hash.update(buffer);
      size += buffer.byteLength;
    }

    const sha256 = hash.digest('hex');
    const created = !this.#seen.has(sha256);
    this.#seen.set(sha256, size);

    return { sha256, size, key: storageKeyFor(sha256), created };
  }

  get(sha256: string): Promise<Readable> {
    return Promise.reject(
      new Error(
        `A dry run keeps no bytes, so blob ${sha256} cannot be read back. Run the import without ` +
          '--dry-run to store the files.',
      ),
    );
  }

  getBuffer(sha256: string): Promise<Buffer> {
    return this.get(sha256) as unknown as Promise<Buffer>;
  }

  has(sha256: string): Promise<boolean> {
    return Promise.resolve(this.#seen.has(sha256));
  }

  stat(sha256: string): Promise<BlobStat | null> {
    const size = this.#seen.get(sha256);
    return Promise.resolve(size === undefined ? null : { sha256, size, key: storageKeyFor(sha256) });
  }

  delete(sha256: string): Promise<boolean> {
    return Promise.resolve(this.#seen.delete(sha256));
  }

  path(sha256: string): string {
    return `dry-run:${storageKeyFor(sha256)}`;
  }
}

const toReadable = (source: BlobSource): Readable => {
  if (Buffer.isBuffer(source)) return Readable.from([source]);
  if (source instanceof Uint8Array) return Readable.from([Buffer.from(source)]);
  return source;
};
