/**
 * Verification on the read path.
 *
 * The local backend hands back a plain `createReadStream` and leaves verification to a separate
 * `verify()` call, which is defensible when the bytes are on the same disk as the process. It is
 * not defensible over a network. Between the store and the reader sit a reverse proxy, a TLS
 * terminator, an object store that may be serving a replica that has not caught up, and — for
 * WebDAV — a server that will happily return a 200 with a truncated body when its own backing
 * store hiccups. None of those failures announce themselves.
 *
 * So both remote backends verify **while streaming**: the digest is computed over the bytes as they
 * flow to the caller and checked at end-of-stream. A mismatch destroys the stream with a
 * `StorageIntegrityError` rather than letting a short or wrong read reach the caller as a clean
 * EOF.
 *
 * The one thing this cannot do is un-deliver the bytes already read. A consumer that writes as it
 * reads must treat the error as "what I just wrote is rubbish", not as "nothing happened" — which
 * is why the error carries the byte count.
 */
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';

import { StorageIntegrityError } from './errors.js';

/**
 * How hard a freshly written object is read back before the write is believed.
 *
 * Shared by both remote backends because the trade-off is identical: `size` is one metadata call
 * and catches every truncation, `digest` is a second full transfer and catches bytes that were
 * swapped rather than lost, `none` believes the 200 and finds out on the next read.
 */
export type WriteVerification = 'none' | 'size' | 'digest';

/**
 * Wrap `source` so the stream fails at the end unless the bytes hash to `expected`.
 *
 * `expectedSize`, when known, is checked first: a truncation is caught by length before the whole
 * body has been hashed, and the resulting error says "short" rather than "wrong".
 */
export const verifyingStream = (
  source: Readable,
  expected: string,
  backend: string,
  expectedSize?: number,
): Readable => {
  const hash = createHash('sha256');
  let size = 0;

  const verifier = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hash.update(buffer);
      size += buffer.byteLength;
      callback(null, buffer);
    },
    flush(callback) {
      if (expectedSize !== undefined && size !== expectedSize) {
        callback(
          new StorageIntegrityError(backend, {
            expected,
            actual: `${size} bytes, expected ${expectedSize}`,
            size,
          }),
        );
        return;
      }
      const actual = hash.digest('hex');
      if (actual !== expected) {
        callback(new StorageIntegrityError(backend, { expected, actual, size }));
        return;
      }
      callback();
    },
  });

  // Without this the caller sees a silent truncation when the upstream response is cut off: the
  // transform would simply end.
  source.on('error', (error) => verifier.destroy(error));
  source.pipe(verifier);
  return verifier;
};

/** Drain a stream into one buffer, propagating the verification failure if there is one. */
export const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
};

/** The digest of everything a stream produces. Used to check an object already in the store. */
export const digestOf = async (stream: Readable): Promise<{ sha256: string; size: number }> => {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    hash.update(buffer);
    size += buffer.byteLength;
  }
  return { sha256: hash.digest('hex'), size };
};
