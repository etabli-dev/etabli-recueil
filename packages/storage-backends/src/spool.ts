/**
 * Spooling: hash the bytes on this machine before any of them leave it.
 *
 * A content-addressed store cannot know a blob's key until it has seen every byte, and a remote
 * store cannot be told the key after the fact. Both remote backends therefore write the source to a
 * local scratch file first, hashing as it goes, and only then decide what to do — which turns out
 * to buy three things beyond the key:
 *
 * 1. **The existing object can be checked before anything is uploaded.** A re-download of a paper
 *    already in the library costs one `HEAD`, not one `PUT` of forty megabytes.
 * 2. **A retry can resend the same bytes.** An HTTP body is consumed once. A file can be reopened,
 *    which is what makes `withRetry` safe on a `PUT` and what makes an S3 part re-uploadable.
 * 3. **A multipart upload can be cut into parts of a known size**, which the SDK needs up front.
 *
 * The cost is honest and worth stating plainly: **a `put` needs scratch space the size of the
 * blob**, on the machine running Recueil, in addition to the space it will occupy on the remote.
 * The local filesystem backend needs the same thing but the scratch file and the final file are on
 * one disk and `rename(2)` costs nothing, so it never shows up. Point `scratchDirectory` at a
 * volume with room for the largest thing you will ingest.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Readable as NodeReadable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { newId } from '@recueil/core';
import type { BlobSource } from '@recueil/core';

/** A local copy of the bytes, with their digest, that the caller must dispose of. */
export interface SpooledBlob {
  /** Absolute path of the scratch file. */
  path: string;
  /** 64 lowercase hex characters, computed from the bytes as they were written. */
  sha256: string;
  size: number;
  /** Open the spooled bytes again. A retry, or one part of a multipart upload. */
  open(range?: { start: number; end: number }): Readable;
  /**
   * Any extra digests that were asked for, keyed by algorithm and already base64-encoded — the
   * form the wire wants them in. `Content-MD5` is the only current customer.
   */
  additional: Record<string, string>;
  /** Delete the scratch file. Safe to call twice; never throws. */
  dispose(): Promise<void>;
}

export interface SpoolOptions {
  /**
   * Extra digests to compute in the same pass, by `node:crypto` name.
   *
   * They are computed here rather than in a second read because the second read of a 400 MB scan
   * costs as much as the first, and because the file may already have been evicted from the page
   * cache by the time anybody wants an MD5 of it.
   */
  additionalHashes?: readonly string[];
}

const toReadable = (source: BlobSource): Readable => {
  if (Buffer.isBuffer(source)) return NodeReadable.from([source]);
  if (source instanceof Uint8Array) return NodeReadable.from([Buffer.from(source)]);
  return source;
};

/**
 * Write `source` to a scratch file under `directory`, hashing it on the way through.
 *
 * The digest comes from the bytes and from nothing else — there is no parameter by which a caller
 * can assert one, which is the whole of ADR-0004 restated as an API.
 */
export const spool = async (
  source: BlobSource,
  directory: string,
  options: SpoolOptions = {},
): Promise<SpooledBlob> => {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${newId()}.part`);
  const hash = createHash('sha256');
  const additionalHashes = (options.additionalHashes ?? []).map(
    (algorithm) => [algorithm, createHash(algorithm)] as const,
  );
  let size = 0;

  const stream = toReadable(source);
  stream.on('data', (chunk: Buffer | string) => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    hash.update(buffer);
    for (const [, extra] of additionalHashes) extra.update(buffer);
    size += buffer.byteLength;
  });

  try {
    await pipeline(stream, createWriteStream(path, { flags: 'wx' }));
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }

  // Trust the filesystem's count over the one accumulated from 'data' events; they agree, and when
  // they ever do not it is the file that is about to be uploaded.
  const written = await stat(path);
  if (written.size !== size) {
    await rm(path, { force: true });
    throw new Error(
      `Spooled ${size} bytes but the scratch file holds ${written.size}. Refusing to upload.`,
    );
  }

  const additional: Record<string, string> = {};
  for (const [algorithm, extra] of additionalHashes) {
    additional[algorithm] = extra.digest('base64');
  }

  let disposed = false;
  return {
    path,
    sha256: hash.digest('hex'),
    size,
    additional,
    open: (range) =>
      range === undefined
        ? createReadStream(path)
        : createReadStream(path, { start: range.start, end: range.end }),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await rm(path, { force: true }).catch(() => undefined);
    },
  };
};

/** The default scratch location: a per-process directory under the OS temp directory. */
export const defaultScratchDirectory = (): string => join(tmpdir(), 'recueil-storage-scratch');
