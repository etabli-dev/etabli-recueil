/**
 * The content-addressed store (ADR-0004, P2).
 *
 * The properties under test are the ones the rest of the system assumes without checking: the
 * digest comes from the bytes, the layout is the one a person can navigate without the application
 * (P10), a second `put` of known bytes does not rewrite the blob, and a failed write leaves nothing
 * behind that looks like a blob.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_BUFFER_BYTES,
  LocalFsBackend,
  ResourceBudgetError,
  storageKeyFor,
} from '../src/index.js';
import { makeTempDirectory } from './helpers.js';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const directories: Array<{ dispose(): void }> = [];
const backend = (): LocalFsBackend => {
  const temp = makeTempDirectory();
  directories.push(temp);
  return new LocalFsBackend({ root: temp.path });
};

afterEach(() => {
  while (directories.length > 0) directories.pop()?.dispose();
});

describe('LocalFsBackend', () => {
  it('hashes the bytes it is given and lays them out as <aa>/<bb>/<sha256>', async () => {
    const store = backend();
    const bytes = Buffer.from('Gather. Verify. Map.\n', 'utf8');

    const result = await store.put(bytes);

    expect(result.sha256).toBe(sha256(bytes));
    expect(result.size).toBe(bytes.byteLength);
    expect(result.created).toBe(true);
    expect(result.key).toBe(storageKeyFor(result.sha256));
    expect(result.key).toBe(
      `${result.sha256.slice(0, 2)}/${result.sha256.slice(2, 4)}/${result.sha256}`,
    );
    expect(readFileSync(store.path(result.sha256))).toEqual(bytes);
  });

  it('accepts a stream and hashes it while writing, without buffering it first', async () => {
    const store = backend();
    const chunks = ['one ', 'two ', 'three'].map((part) => Buffer.from(part, 'utf8'));
    const whole = Buffer.concat(chunks);

    const result = await store.put(Readable.from(chunks));

    expect(result.sha256).toBe(sha256(whole));
    expect(result.size).toBe(whole.byteLength);
    expect(await store.getBuffer(result.sha256)).toEqual(whole);
  });

  it('does not rewrite a blob it already holds and has verified', async () => {
    const store = backend();
    const bytes = Buffer.from('the same bytes twice', 'utf8');

    const first = await store.put(bytes);
    const beforeMtime = statSync(store.path(first.sha256)).mtimeMs;

    // Mark the stored file so that a rewrite would be visible. The marker is the same length, so
    // the default `size` verification is satisfied and the store must leave the file alone.
    const marker = Buffer.from('TAMPERED bytes twice', 'utf8');
    expect(marker.byteLength).toBe(bytes.byteLength);
    writeFileSync(store.path(first.sha256), marker);

    const second = await store.put(bytes);

    expect(second.created).toBe(false);
    expect(second.repaired).toBe(false);
    expect(second.sha256).toBe(first.sha256);
    expect(readFileSync(store.path(first.sha256))).toEqual(marker);
    expect(statSync(store.path(first.sha256)).mtimeMs).toBeGreaterThanOrEqual(beforeMtime);
  });

  /**
   * The C1 regression.
   *
   * A file at the digest path is an assertion, not evidence. Before the fix, `put` took the
   * assertion for proof: re-putting the correct bytes over a truncated blob discarded them, said
   * `created: false`, and reported the corrupt file's size — silent data loss of exactly the kind
   * ADR-0004 says cannot happen here.
   */
  it('repairs a truncated blob from the bytes of a later put rather than discarding them', async () => {
    const store = backend();
    const bytes = Buffer.from('X'.repeat(1800), 'utf8');

    const first = await store.put(bytes);
    expect(first.created).toBe(true);

    // Rot: the bytes go, the name that asserts their digest stays.
    writeFileSync(store.path(first.sha256), Buffer.from('TRUNCATED', 'utf8'));
    expect(statSync(store.path(first.sha256)).size).toBe(9);

    const second = await store.put(bytes);

    expect(second.repaired).toBe(true);
    expect(second.created).toBe(true);
    expect(second.size).toBe(1800);
    expect(readFileSync(store.path(first.sha256))).toEqual(bytes);
    expect(await store.getBuffer(first.sha256)).toEqual(bytes);
    expect(await store.verify(first.sha256)).toBe(true);
  });

  it('catches rot that kept the length, when asked to verify the digest', async () => {
    const store = backend();
    const bytes = Buffer.from('the same bytes twice', 'utf8');
    const rotted = Buffer.from('the sane bytes twice', 'utf8');
    expect(rotted.byteLength).toBe(bytes.byteLength);

    const first = await store.put(bytes);
    writeFileSync(store.path(first.sha256), rotted);

    const second = await store.put(bytes, { verify: 'digest' });

    expect(second.repaired).toBe(true);
    expect(readFileSync(store.path(first.sha256))).toEqual(bytes);
  });

  it('verifies the digest on every put when the backend is built that way', async () => {
    const temp = makeTempDirectory();
    directories.push(temp);
    const store = new LocalFsBackend({ root: temp.path, verifyOnPut: 'digest' });

    const bytes = Buffer.from('rot me in place', 'utf8');
    const first = await store.put(bytes);
    const rotted = Buffer.from('rot me in plaice'.slice(0, bytes.byteLength), 'utf8');
    expect(rotted.byteLength).toBe(bytes.byteLength);
    writeFileSync(store.path(first.sha256), rotted);

    expect((await store.put(bytes)).repaired).toBe(true);
    expect(readFileSync(store.path(first.sha256))).toEqual(bytes);
  });

  it('answers has, stat and get, and reports a missing blob rather than inventing one', async () => {
    const store = backend();
    const absent = 'f'.repeat(64);

    expect(await store.has(absent)).toBe(false);
    expect(await store.stat(absent)).toBeNull();
    await expect(store.get(absent)).rejects.toThrow(/not in the store/iu);

    const { sha256: digest, size } = await store.put(Buffer.from('present', 'utf8'));
    expect(await store.has(digest)).toBe(true);
    expect(await store.stat(digest)).toEqual({ sha256: digest, size, key: storageKeyFor(digest) });
  });

  it('deletes a blob and prunes the fan-out directories it emptied', async () => {
    const store = backend();
    const { sha256: digest } = await store.put(Buffer.from('to be purged', 'utf8'));

    expect(await store.delete(digest)).toBe(true);
    expect(await store.has(digest)).toBe(false);
    expect(await store.delete(digest)).toBe(false);
    expect(readdirSync(store.root).filter((entry) => entry !== '.tmp')).toEqual([]);
  });

  it('verifies a blob against its own name, which is the storage half of D2', async () => {
    const store = backend();
    const { sha256: digest } = await store.put(Buffer.from('honest bytes', 'utf8'));

    expect(await store.verify(digest)).toBe(true);

    writeFileSync(store.path(digest), Buffer.from('dishonest!!!', 'utf8'));
    expect(await store.verify(digest)).toBe(false);
  });

  it('leaves no partial file behind when the source stream fails', async () => {
    const store = backend();
    const failing = new Readable({
      read() {
        this.push(Buffer.from('half a file', 'utf8'));
        this.destroy(new Error('scanner went away'));
      },
    });

    await expect(store.put(failing)).rejects.toThrow(/scanner went away/u);

    // The root holds the temp directory and nothing that looks like a blob.
    expect(readdirSync(store.root)).toEqual(['.tmp']);
    expect(readdirSync(join(store.root, '.tmp'))).toEqual([]);
  });

  /** m1: an interrupted write leaves a `.part` file, and a store that never says so fills a disk. */
  it('reports the partial writes left in .tmp, and sweeps the ones that are old enough', async () => {
    const store = backend();
    await store.put(Buffer.from('a real blob', 'utf8'));

    const failing = new Readable({
      read() {
        this.push(Buffer.from('half a file', 'utf8'));
        this.destroy(new Error('scanner went away'));
      },
    });
    await expect(store.put(failing)).rejects.toThrow(/scanner went away/u);
    // That one cleaned up after itself; a killed process does not, so simulate the leftover.
    const abandoned = join(store.root, '.tmp', '01JABANDONEDABANDONEDABANDO.part');
    writeFileSync(abandoned, Buffer.from('half a scan', 'utf8'));
    utimesSync(abandoned, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));
    const fresh = join(store.root, '.tmp', '01JFRESHFRESHFRESHFRESHFRE.part');
    writeFileSync(fresh, Buffer.from('still uploading', 'utf8'));

    const stray = await store.listStrayTempFiles();
    expect(stray.map((file) => file.path).sort()).toEqual([abandoned, fresh].sort());
    expect(stray.find((file) => file.path === abandoned)?.size).toBe(11);

    const swept = await store.sweepTempFiles();
    expect(swept).toEqual({ removed: 1, bytes: 11 });
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('refuses anything that is not a digest before it reaches a path join', () => {
    const store = backend();
    expect(() => store.path('../../etc/passwd')).toThrow(/Not a SHA-256 digest/u);
    expect(() => store.path('ABC')).toThrow(/Not a SHA-256 digest/u);
  });
});

/**
 * A whole-blob read is a whole-file read into memory, and a library holds four-hundred-megabyte
 * scans that arrived from a mailbox or a watched folder (ADR-0022 §2).
 */
describe('LocalFsBackend.getBuffer is bounded', () => {
  it('refuses a blob larger than the caller will hold, naming the limit', async () => {
    const store = backend();
    const bytes = Buffer.alloc(64 * 1024, 7);
    const { sha256: digest } = await store.put(bytes);

    await expect(store.getBuffer(digest, { maxBytes: bytes.byteLength - 1 })).rejects.toThrow(
      ResourceBudgetError,
    );
    await expect(store.getBuffer(digest, { maxBytes: bytes.byteLength - 1 })).rejects.toThrow(
      /Stream it with get\(\) instead/u,
    );
    expect(await store.getBuffer(digest, { maxBytes: bytes.byteLength })).toEqual(bytes);
  });

  it('has a default ceiling rather than none at all', async () => {
    const store = backend();
    const { sha256: digest } = await store.put(Buffer.from('small', 'utf8'));
    expect(DEFAULT_MAX_BUFFER_BYTES).toBe(64 * 1024 * 1024);
    expect(await store.getBuffer(digest)).toEqual(Buffer.from('small', 'utf8'));
  });
});

/**
 * `sweepTempFiles` is a stat-then-delete with a directory walk in the gap.
 *
 * A `.part` file belongs to a `put` that may still be running, and the only thing separating
 * "abandoned" from "in flight" is when it was last written to — read once, during the listing, and
 * acted on afterwards. A stalled upload that resumes inside that window used to have its temporary
 * file deleted underneath it, so the `rename` that ends `put` failed and the bytes were lost.
 */
describe('LocalFsBackend.sweepTempFiles re-checks before it deletes', () => {
  const stale = (path: string): void => {
    const when = Date.now() / 1000 - 7200;
    utimesSync(path, when, when);
  };

  it('leaves a temporary file that changed after the listing', async () => {
    const store = backend();
    await store.put(Buffer.from('warm the store', 'utf8'));
    const part = join(store.root, '.tmp', '01STALLEDUPLOAD.part');
    writeFileSync(part, Buffer.alloc(1024));
    stale(part);

    // The writer resumes in the gap between the listing and the delete the listing authorises.
    const listed = store.listStrayTempFiles.bind(store);
    store.listStrayTempFiles = async () => {
      const found = await listed();
      appendFileSync(part, Buffer.alloc(4096));
      return found;
    };

    expect(await store.sweepTempFiles()).toEqual({ removed: 0, bytes: 0 });
    expect(existsSync(part), 'an upload that was still running was swept away').toBe(true);
    expect(statSync(part).size).toBe(5120);
  });

  it('still reclaims one that really was abandoned', async () => {
    const store = backend();
    await store.put(Buffer.from('warm the store', 'utf8'));
    const part = join(store.root, '.tmp', '01ABANDONED.part');
    writeFileSync(part, Buffer.alloc(2048));
    stale(part);

    expect(await store.sweepTempFiles()).toEqual({ removed: 1, bytes: 2048 });
    expect(existsSync(part)).toBe(false);
  });

  it('leaves a recent one alone', async () => {
    const store = backend();
    await store.put(Buffer.from('warm the store', 'utf8'));
    const part = join(store.root, '.tmp', '01INFLIGHT.part');
    writeFileSync(part, Buffer.alloc(512));

    expect(await store.sweepTempFiles()).toEqual({ removed: 0, bytes: 0 });
    expect(existsSync(part)).toBe(true);
  });
});
