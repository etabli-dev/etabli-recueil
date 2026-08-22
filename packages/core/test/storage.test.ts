/**
 * The content-addressed store (ADR-0004, P2).
 *
 * The properties under test are the ones the rest of the system assumes without checking: the
 * digest comes from the bytes, the layout is the one a person can navigate without the application
 * (P10), a second `put` of known bytes does not rewrite the blob, and a failed write leaves nothing
 * behind that looks like a blob.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalFsBackend, storageKeyFor } from '../src/index.js';
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

  it('does not rewrite a blob it already holds', async () => {
    const store = backend();
    const bytes = Buffer.from('the same bytes twice', 'utf8');

    const first = await store.put(bytes);
    const beforeMtime = statSync(store.path(first.sha256)).mtimeMs;

    // Mark the stored file so that a rewrite would be visible: the store must not touch it.
    const marker = Buffer.from('TAMPERED bytes twice', 'utf8');
    expect(marker.byteLength).toBe(bytes.byteLength);
    writeFileSync(store.path(first.sha256), marker);

    const second = await store.put(bytes);

    expect(second.created).toBe(false);
    expect(second.sha256).toBe(first.sha256);
    expect(readFileSync(store.path(first.sha256))).toEqual(marker);
    expect(statSync(store.path(first.sha256)).mtimeMs).toBeGreaterThanOrEqual(beforeMtime);
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

  it('refuses anything that is not a digest before it reaches a path join', () => {
    const store = backend();
    expect(() => store.path('../../etc/passwd')).toThrow(/Not a SHA-256 digest/u);
    expect(() => store.path('ABC')).toThrow(/Not a SHA-256 digest/u);
  });
});
