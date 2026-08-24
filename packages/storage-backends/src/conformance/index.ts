/**
 * The conformance suite every storage backend has to pass.
 *
 * `CreateRecueilOptions.storage` accepts any `StorageBackend`, which means the rest of the system
 * treats the three implementations as interchangeable. That is a claim, and until something checks
 * it on all three it is the kind of claim the Phase 1 review kept finding: plausible, untested and
 * wrong in the corner that matters. So the suite lives here, is exported, and is run against the
 * local filesystem backend as well as the two remote ones — the local one is not the reference
 * implementation exempt from its own rules, it is a third candidate.
 *
 * What the suite tests is the contract in `@recueil/core`'s `backend.ts` and nothing else. Where an
 * implementation goes further — verifying on read, sweeping its temp directory, aborting a
 * multipart upload — that belongs in that backend's own tests. Where a behaviour is genuinely
 * optional, the harness declares it in `capabilities` and the suite tests it only for the backends
 * that claim it, rather than being watered down until all three pass.
 *
 * Usage:
 *
 * ```ts
 * runStorageBackendConformance({
 *   name: 'LocalFsBackend',
 *   create: async () => ({ backend: new LocalFsBackend({ root }), dispose: async () => …  }),
 * });
 * ```
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { storageKeyFor } from '@recueil/core';
import type { StorageBackend } from '@recueil/core';
import { afterEach, describe, expect, it } from 'vitest';

/** A backend under test, plus the out-of-band access the harder assertions need. */
export interface ConformanceSubject {
  backend: StorageBackend & { verify?(sha256: string): Promise<boolean> };
  /**
   * Replace the bytes of a stored blob without going through the backend — the rot, the truncated
   * write, the botched restore.
   *
   * A harness that cannot do this makes the suite unable to test the single most important property
   * of a content-addressed store, so it is strongly encouraged; the corresponding tests are skipped
   * without it, and the suite says so out loud.
   */
  corrupt?(sha256: string, bytes: Buffer): Promise<void>;
  dispose(): Promise<void>;
}

export interface StorageBackendConformanceOptions {
  /** Appears in the test names. */
  name: string;
  /** A fresh, empty store per test. */
  create(): Promise<ConformanceSubject>;
  /**
   * Bytes for the "a big blob survives" case. Set it above the backend's multipart threshold to
   * make that path part of conformance rather than a footnote. Default 1 MiB.
   */
  largeBlobSize?: number;
  capabilities?: {
    /**
     * `get` fails rather than returning bytes that do not match the digest. True for the remote
     * backends, where a truncated 200 from a proxy is indistinguishable from a short file; false
     * for the local one, which offers a separate `verify()`.
     */
    verifiesOnRead?: boolean;
  };
}

const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const drain = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
};

/** Deterministic pseudo-random bytes: compressible data would hide a truncation on some paths. */
const bytesOfLength = (length: number, seed: string): Buffer => {
  const out = Buffer.alloc(length);
  let block = createHash('sha256').update(seed).digest();
  for (let offset = 0; offset < length; offset += block.byteLength) {
    block.copy(out, offset, 0, Math.min(block.byteLength, length - offset));
    block = createHash('sha256').update(block).digest();
  }
  return out;
};

export const runStorageBackendConformance = (options: StorageBackendConformanceOptions): void => {
  const largeBlobSize = options.largeBlobSize ?? 1024 * 1024;
  const verifiesOnRead = options.capabilities?.verifiesOnRead ?? false;

  describe(`StorageBackend conformance: ${options.name}`, () => {
    const open: ConformanceSubject[] = [];

    const subject = async (): Promise<ConformanceSubject> => {
      const created = await options.create();
      open.push(created);
      return created;
    };

    afterEach(async () => {
      while (open.length > 0) await open.pop()?.dispose();
    });

    it('hashes the bytes it is given and keys them as <aa>/<bb>/<sha256>', async () => {
      const { backend } = await subject();
      const bytes = Buffer.from('Gather. Verify. Map.\n', 'utf8');

      const result = await backend.put(bytes);

      expect(result.sha256).toBe(digestOf(bytes));
      expect(result.size).toBe(bytes.byteLength);
      expect(result.created).toBe(true);
      expect(result.repaired).toBe(false);
      expect(result.key).toBe(storageKeyFor(result.sha256));
      expect(result.key).toBe(
        `${result.sha256.slice(0, 2)}/${result.sha256.slice(2, 4)}/${result.sha256}`,
      );
      expect(await backend.getBuffer(result.sha256)).toEqual(bytes);
    });

    it('accepts a stream and hashes it as it goes', async () => {
      const { backend } = await subject();
      const chunks = ['one ', 'two ', 'three'].map((part) => Buffer.from(part, 'utf8'));
      const whole = Buffer.concat(chunks);

      const result = await backend.put(Readable.from(chunks));

      expect(result.sha256).toBe(digestOf(whole));
      expect(result.size).toBe(whole.byteLength);
      expect(await backend.getBuffer(result.sha256)).toEqual(whole);
    });

    it('stores an empty blob, which is a real thing to be handed and not an error', async () => {
      const { backend } = await subject();
      const result = await backend.put(Buffer.alloc(0));

      expect(result.sha256).toBe(digestOf(Buffer.alloc(0)));
      expect(result.size).toBe(0);
      expect(await backend.has(result.sha256)).toBe(true);
      expect(await backend.getBuffer(result.sha256)).toEqual(Buffer.alloc(0));
    });

    it('round-trips a blob large enough to take the backend’s bulk path', async () => {
      const { backend } = await subject();
      const bytes = bytesOfLength(largeBlobSize, 'conformance-large');

      const result = await backend.put(bytes);

      expect(result.size).toBe(largeBlobSize);
      expect(result.sha256).toBe(digestOf(bytes));
      const read = await backend.getBuffer(result.sha256);
      expect(read.byteLength).toBe(largeBlobSize);
      expect(digestOf(read)).toBe(result.sha256);
    });

    it('reports created: false for bytes it already holds, and does not report a repair', async () => {
      const { backend } = await subject();
      const bytes = Buffer.from('the same bytes twice', 'utf8');

      const first = await backend.put(bytes);
      const second = await backend.put(bytes);

      expect(second.sha256).toBe(first.sha256);
      expect(second.size).toBe(first.size);
      expect(second.created).toBe(false);
      expect(second.repaired).toBe(false);
      expect(await backend.getBuffer(first.sha256)).toEqual(bytes);
    });

    it('keeps distinct blobs distinct', async () => {
      const { backend } = await subject();
      const first = Buffer.from('the first document', 'utf8');
      const second = Buffer.from('the second document', 'utf8');

      const one = await backend.put(first);
      const two = await backend.put(second);

      expect(one.sha256).not.toBe(two.sha256);
      expect(await backend.getBuffer(one.sha256)).toEqual(first);
      expect(await backend.getBuffer(two.sha256)).toEqual(second);
    });

    it('answers has, stat and get, and reports a missing blob rather than inventing one', async () => {
      const { backend } = await subject();
      const absent = 'f'.repeat(64);

      expect(await backend.has(absent)).toBe(false);
      expect(await backend.stat(absent)).toBeNull();
      await expect(backend.get(absent)).rejects.toThrow(/not in the store/iu);
      await expect(backend.getBuffer(absent)).rejects.toThrow(/not in the store/iu);

      const { sha256, size } = await backend.put(Buffer.from('present', 'utf8'));
      expect(await backend.has(sha256)).toBe(true);
      expect(await backend.stat(sha256)).toEqual({ sha256, size, key: storageKeyFor(sha256) });
    });

    it('deletes a blob, and says so only the first time', async () => {
      const { backend } = await subject();
      const { sha256 } = await backend.put(Buffer.from('to be purged', 'utf8'));

      expect(await backend.delete(sha256)).toBe(true);
      expect(await backend.has(sha256)).toBe(false);
      expect(await backend.stat(sha256)).toBeNull();
      expect(await backend.delete(sha256)).toBe(false);
      await expect(backend.get(sha256)).rejects.toThrow(/not in the store/iu);
    });

    it('refuses anything that is not a digest before it reaches a path or a key', async () => {
      const { backend } = await subject();

      expect(() => backend.path('../../etc/passwd')).toThrow(/Not a SHA-256 digest/u);
      expect(() => backend.path('ABC')).toThrow(/Not a SHA-256 digest/u);
      expect(() => backend.path('F'.repeat(64))).toThrow(/Not a SHA-256 digest/u);
      await expect(backend.has('../../etc/passwd')).rejects.toThrow(/Not a SHA-256 digest/u);
      await expect(backend.stat('..')).rejects.toThrow(/Not a SHA-256 digest/u);
      await expect(backend.get('%2e%2e%2f')).rejects.toThrow(/Not a SHA-256 digest/u);
      await expect(backend.delete('a'.repeat(63))).rejects.toThrow(/Not a SHA-256 digest/u);
    });

    it('gives a pure, key-bearing location for a digest', async () => {
      const { backend } = await subject();
      const digest = digestOf(Buffer.from('located', 'utf8'));

      const location = backend.path(digest);
      // Every backend ends its location with the shared key, whatever it puts in front of it: an
      // absolute path, an object key under a prefix, or an https URL. That is what lets a blob be
      // copied from one backend to another and still be found.
      const [aa, bb] = [digest.slice(0, 2), digest.slice(2, 4)];
      expect(location).toMatch(new RegExp(`${aa}[/\\\\]${bb}[/\\\\]${digest}$`, 'u'));
      // Pure: nothing was stored, and asking twice gives the same answer.
      expect(backend.path(digest)).toBe(location);
      expect(await backend.has(digest)).toBe(false);
    });

    it('survives two concurrent puts of the same bytes', async () => {
      const { backend } = await subject();
      const bytes = bytesOfLength(64 * 1024, 'conformance-race');

      const [first, second] = await Promise.all([backend.put(bytes), backend.put(bytes)]);

      expect(first.sha256).toBe(digestOf(bytes));
      expect(second.sha256).toBe(first.sha256);
      expect(await backend.getBuffer(first.sha256)).toEqual(bytes);
    });

    it('propagates a failing source and stores nothing', async () => {
      const { backend } = await subject();
      const failing = new Readable({
        read() {
          this.push(Buffer.from('half a file', 'utf8'));
          this.destroy(new Error('scanner went away'));
        },
      });

      await expect(backend.put(failing)).rejects.toThrow(/scanner went away/u);

      const halfDigest = digestOf(Buffer.from('half a file', 'utf8'));
      expect(await backend.has(halfDigest)).toBe(false);
    });

    describe('when the store has rotted', () => {
      it('repairs a truncated blob from the bytes of a later put rather than discarding them', async () => {
        const created = await subject();
        if (created.corrupt === undefined) {
          throw new Error(
            `The ${options.name} harness supplies no corrupt(), so the property that matters most ` +
              'in a content-addressed store cannot be tested. Give the harness out-of-band write ' +
              'access to the store.',
          );
        }

        const bytes = Buffer.from('X'.repeat(1800), 'utf8');
        const first = await created.backend.put(bytes);
        await created.corrupt(first.sha256, Buffer.from('TRUNCATED', 'utf8'));

        const second = await created.backend.put(bytes);

        expect(second.repaired).toBe(true);
        expect(second.created).toBe(true);
        expect(second.size).toBe(1800);
        expect(await created.backend.getBuffer(first.sha256)).toEqual(bytes);
      });

      it('catches rot that kept the length when asked to verify the digest', async () => {
        const created = await subject();
        if (created.corrupt === undefined) throw new Error('The harness supplies no corrupt().');

        const bytes = Buffer.from('the same bytes twice', 'utf8');
        const rotted = Buffer.from('the sane bytes twice', 'utf8');
        expect(rotted.byteLength).toBe(bytes.byteLength);

        const first = await created.backend.put(bytes);
        await created.corrupt(first.sha256, rotted);

        // The cheap check cannot see this, and must not claim to.
        const cheap = await created.backend.put(bytes, { verify: 'size' });
        expect(cheap.repaired).toBe(false);

        const thorough = await created.backend.put(bytes, { verify: 'digest' });
        expect(thorough.repaired).toBe(true);
        expect(await created.backend.getBuffer(first.sha256)).toEqual(bytes);
      });

      it(
        verifiesOnRead
          ? 'fails the read rather than handing back bytes that are not the digest'
          : 'hands back whatever is stored, and offers verify() to find out that it is wrong',
        async () => {
          const created = await subject();
          if (created.corrupt === undefined) throw new Error('The harness supplies no corrupt().');

          const bytes = Buffer.from('honest bytes', 'utf8');
          const { sha256 } = await created.backend.put(bytes);
          await created.corrupt(sha256, Buffer.from('dishonest!!!', 'utf8'));

          if (verifiesOnRead) {
            await expect(created.backend.getBuffer(sha256)).rejects.toThrow(/integrity/iu);
            await expect(drain(await created.backend.get(sha256))).rejects.toThrow(/integrity/iu);
          } else {
            expect(await created.backend.getBuffer(sha256)).toEqual(
              Buffer.from('dishonest!!!', 'utf8'),
            );
          }

          if (created.backend.verify !== undefined) {
            expect(await created.backend.verify(sha256)).toBe(false);
          }
        },
      );
    });

    it('verifies a blob against its own name when it offers verify()', async () => {
      const { backend } = await subject();
      if (backend.verify === undefined) return;

      const { sha256 } = await backend.put(Buffer.from('honest bytes', 'utf8'));
      expect(await backend.verify(sha256)).toBe(true);
      expect(await backend.verify('f'.repeat(64))).toBe(false);
    });
  });
};
