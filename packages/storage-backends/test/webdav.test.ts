/**
 * What the WebDAV backend does that the conformance suite does not cover: authentication, the
 * `MKCOL` dance, the retry loop, and the four ways a WebDAV server can be unfit for the job.
 *
 * Everything here runs against the in-process fake in `src/testing/webdav-server.ts`. That fake is
 * not Nextcloud and passing against it is not a compatibility claim — see the README. What it can
 * do, and a container cannot, is fail on the third request and then stop failing.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { storageKeyFor } from '@recueil/core';
import { afterEach, describe, expect, it } from 'vitest';

import { StorageRequestError, StorageUnsupportedError } from '../src/errors.js';
import { startFakeWebDavServer } from '../src/testing/webdav-server.js';
import type { FakeWebDavOptions, FakeWebDavServer } from '../src/testing/webdav-server.js';
import { WebDavBackend, contentMd5 } from '../src/webdav/backend.js';
import type { WebDavBackendOptions } from '../src/webdav/backend.js';

const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

interface Fixture {
  server: FakeWebDavServer;
  backend: WebDavBackend;
  /** Delays the retry loop asked for, in order. Nothing actually waits. */
  slept: number[];
  scratch: string;
}

const fixture = async (
  serverOptions: FakeWebDavOptions = {},
  backendOptions: Partial<WebDavBackendOptions> = {},
): Promise<Fixture> => {
  const server = await startFakeWebDavServer(serverOptions);
  const scratch = await mkdtemp(join(tmpdir(), 'recueil-webdav-scratch-'));
  const slept: number[] = [];
  const backend = new WebDavBackend({
    url: server.url,
    scratchDirectory: scratch,
    retry: { attempts: 4, baseDelayMs: 10, maxDelayMs: 1000, jitter: false },
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...backendOptions,
  });
  cleanup.push(async () => {
    await server.close();
    await rm(scratch, { recursive: true, force: true });
  });
  return { server, backend, slept, scratch };
};

describe('WebDavBackend authentication', () => {
  it('sends basic credentials, and the server sees them', async () => {
    const { server, backend } = await fixture(
      { auth: { kind: 'basic', username: 'rh', password: 'app-password' } },
      { auth: { kind: 'basic', username: 'rh', password: 'app-password' } },
    );

    const bytes = Buffer.from('behind a password', 'utf8');
    const result = await backend.put(bytes);

    expect(result.created).toBe(true);
    expect(await backend.getBuffer(result.sha256)).toEqual(bytes);
    const expected = `Basic ${Buffer.from('rh:app-password', 'utf8').toString('base64')}`;
    expect(server.requests.every((request) => request.headers['authorization'] === expected)).toBe(true);
  });

  it('sends a bearer token', async () => {
    const { server, backend } = await fixture(
      { auth: { kind: 'bearer', token: 'oidc-access-token' } },
      { auth: { kind: 'bearer', token: 'oidc-access-token' } },
    );

    const result = await backend.put(Buffer.from('behind a token', 'utf8'));

    expect(result.created).toBe(true);
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer oidc-access-token');
  });

  it('reports a 401 as a 401, and does not retry it', async () => {
    const { server, backend } = await fixture(
      { auth: { kind: 'basic', username: 'rh', password: 'right' } },
      { auth: { kind: 'basic', username: 'rh', password: 'wrong' } },
    );

    await expect(backend.put(Buffer.from('nope', 'utf8'))).rejects.toThrow(/HTTP 401/u);
    // One OPTIONS, refused, and no second try: a wrong password does not become right.
    expect(server.requests).toHaveLength(1);
  });
});

describe('WebDavBackend collection handling', () => {
  it('creates the shard collections, and creates the parent when the server says 409', async () => {
    const { server, backend } = await fixture();
    const bytes = Buffer.from('sharded', 'utf8');
    const digest = digestOf(bytes);
    const [aa, bb] = [digest.slice(0, 2), digest.slice(2, 4)];

    await backend.put(bytes);

    const mkcols = server.requests
      .filter((request) => request.method === 'MKCOL')
      .map((request) => request.path.replace(/^\/dav\/?/u, ''));
    // `.tmp` first, then the two-level fan-out: the inner one is attempted, refused with 409
    // because its parent does not exist, the parent is created, and the inner one is retried.
    expect(mkcols).toEqual(['.tmp', `${aa}/${bb}`, aa, `${aa}/${bb}`]);
    expect(readFileSync(join(server.root, storageKeyFor(digest)))).toEqual(bytes);
  });

  it('does not re-create a collection it has already made', async () => {
    const { server, backend } = await fixture();

    await backend.put(Buffer.from('one', 'utf8'));
    const after = server.requests.length;
    await backend.put(Buffer.from('one', 'utf8'));

    const mkcolsAfterwards = server.requests
      .slice(after)
      .filter((request) => request.method === 'MKCOL');
    expect(mkcolsAfterwards).toEqual([]);
  });

  it('refuses a server that cannot MKCOL, and says why', async () => {
    const { backend } = await fixture({ disableMkcol: true, omitAllow: true });

    const error = await backend.put(Buffer.from('nowhere to put it', 'utf8')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageUnsupportedError);
    expect((error as StorageUnsupportedError).capability).toBe('MKCOL');
    expect((error as Error).message).toMatch(/65 536 shard collections/u);
  });
});

describe('WebDavBackend atomic writes', () => {
  it('writes to .tmp and MOVEs into place, so nothing partial ever wears a digest', async () => {
    const { server, backend } = await fixture();
    const bytes = Buffer.from('moved into place', 'utf8');

    const result = await backend.put(bytes);

    const write = server.requests.filter((request) => request.method === 'PUT');
    expect(write).toHaveLength(1);
    expect(write[0]?.path).toMatch(/^\/dav\/\.tmp\/[0-9A-Z]+\.part$/u);
    const move = server.requests.filter((request) => request.method === 'MOVE');
    expect(move).toHaveLength(1);
    expect(move[0]?.headers['destination']).toBe(backend.path(result.sha256));
    expect(move[0]?.headers['overwrite']).toBe('T');
    // Nothing left behind in the temporary collection.
    expect(readdirSync(join(server.root, '.tmp'))).toEqual([]);
  });

  it('refuses a server whose Allow list has no MOVE, before it writes anything', async () => {
    const { server, backend } = await fixture({ disableMove: true });

    const error = await backend.put(Buffer.from('cannot be moved', 'utf8')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageUnsupportedError);
    expect((error as StorageUnsupportedError).capability).toBe('MOVE');
    expect((error as Error).message).toMatch(/writeStrategy: 'direct-put'/u);
    expect(server.requests.filter((request) => request.method === 'PUT')).toEqual([]);
  });

  it('refuses a MOVE-less server that hid the fact, and cleans up the temporary file', async () => {
    // `omitAllow` is the realistic version: the server advertises class 1 and simply does not
    // implement MOVE, which is only discovered at the moment it matters.
    const { server, backend } = await fixture({ disableMove: true, omitAllow: true });

    const error = await backend.put(Buffer.from('cannot be moved either', 'utf8')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageUnsupportedError);
    expect((error as StorageUnsupportedError).capability).toBe('MOVE');
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(server.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect(readdirSync(join(server.root, '.tmp'))).toEqual([]);
  });

  it('writes straight to the final path when told to, on a server that cannot MOVE', async () => {
    const { server, backend } = await fixture(
      { disableMove: true, omitAllow: true },
      { writeStrategy: 'direct-put' },
    );
    const bytes = Buffer.from('no MOVE here', 'utf8');

    const result = await backend.put(bytes);

    expect(result.created).toBe(true);
    expect(server.requests.filter((request) => request.method === 'MOVE')).toEqual([]);
    expect(readFileSync(join(server.root, storageKeyFor(result.sha256)))).toEqual(bytes);
  });

  it('refuses a truncated upload and leaves the final path empty', async () => {
    // The failure the checksum headers are supposed to catch and usually do not: a proxy body
    // limit, a full disk, a connection the server treated as a clean end of request.
    const { server, backend } = await fixture({ truncatePutsTo: 4 });
    const bytes = Buffer.from('a good deal longer than four bytes', 'utf8');

    const error = await backend.put(bytes).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageRequestError);
    expect((error as Error).message).toMatch(/stored 4 bytes of the 34 that were sent/u);
    expect(server.requests.filter((request) => request.method === 'MOVE')).toEqual([]);
    expect(readdirSync(join(server.root, storageKeyFor(digestOf(bytes)).slice(0, 2))).length).toBe(1);
    expect(await backend.has(digestOf(bytes))).toBe(false);
  });
});

describe('WebDavBackend checksum headers', () => {
  it('sends Content-MD5 and OC-Checksum with every upload', async () => {
    const { server, backend } = await fixture();
    const bytes = Buffer.from('checksummed', 'utf8');

    await backend.put(bytes);

    const put = server.requests.find((request) => request.method === 'PUT');
    expect(put?.headers['content-md5']).toBe(contentMd5(bytes));
    expect(put?.headers['oc-checksum']).toBe(`SHA256:${digestOf(bytes)}`);
  });

  it('is accepted by a server that does verify OC-Checksum', async () => {
    const { backend } = await fixture({ verifyOcChecksum: true, verifyContentMd5: true });
    const bytes = Buffer.from('nextcloud checks this one', 'utf8');

    const result = await backend.put(bytes);

    expect(result.created).toBe(true);
    expect(await backend.getBuffer(result.sha256)).toEqual(bytes);
  });

  it('still catches a truncation on a server that ignores both headers', async () => {
    // This is the documented failure mode: the overwhelming majority of WebDAV servers accept
    // Content-MD5 and never look at it. The size check after the write is what stands in for it.
    const { server, backend } = await fixture({ truncatePutsTo: 2 });

    await expect(backend.put(Buffer.from('ignored entirely', 'utf8'))).rejects.toThrow(
      /stored 2 bytes/u,
    );
    const put = server.requests.find((request) => request.method === 'PUT');
    expect(put?.headers['content-md5']).toBeDefined();
  });

  it('can be told not to send them', async () => {
    const { server, backend } = await fixture({}, { sendContentMd5: false, sendOcChecksum: false });

    await backend.put(Buffer.from('bare', 'utf8'));

    const put = server.requests.find((request) => request.method === 'PUT');
    expect(put?.headers['content-md5']).toBeUndefined();
    expect(put?.headers['oc-checksum']).toBeUndefined();
  });
});

describe('WebDavBackend retrying', () => {
  it('retries a 503 with a doubling backoff and then succeeds', async () => {
    const { server, backend, slept } = await fixture();
    server.setFault({ failFirst: 2, status: 503, method: 'PUT' });
    const bytes = Buffer.from('third time lucky', 'utf8');

    const result = await backend.put(bytes);

    expect(result.created).toBe(true);
    expect(slept).toEqual([10, 20]);
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(3);
    expect(await backend.getBuffer(result.sha256)).toEqual(bytes);
  });

  it('waits at least as long as Retry-After asks', async () => {
    const { server, backend, slept } = await fixture(
      {},
      { retry: { attempts: 4, baseDelayMs: 10, maxDelayMs: 5000, jitter: false } },
    );
    server.setFault({ failFirst: 1, status: 429, retryAfter: '2', method: 'PUT' });

    await backend.put(Buffer.from('slow down', 'utf8'));

    // The computed backoff would have been 10 ms. The server asked for two seconds.
    expect(slept).toEqual([2000]);
  });

  it('still bounds a Retry-After by maxDelayMs, so a proxy cannot stall an ingest queue', async () => {
    const { server, backend, slept } = await fixture(
      {},
      { retry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 1000, jitter: false } },
    );
    server.setFault({ failFirst: 1, status: 503, retryAfter: '3600', method: 'PUT' });

    await backend.put(Buffer.from('an hour, it says', 'utf8'));

    expect(slept).toEqual([1000]);
  });

  it('gives up after the configured number of attempts and reports the status', async () => {
    const { server, backend, slept } = await fixture();
    server.setFault({ failFirst: 99, status: 502, method: 'PUT' });

    const error = await backend.put(Buffer.from('never lands', 'utf8')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageRequestError);
    expect((error as StorageRequestError).status).toBe(502);
    expect((error as StorageRequestError).retryable).toBe(true);
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(4);
    expect(slept).toEqual([10, 20, 40]);
  });

  it('does not retry a 4xx that is not a 429', async () => {
    const { server, backend, slept } = await fixture();
    server.setFault({ failFirst: 99, status: 403, method: 'PUT' });

    await expect(backend.put(Buffer.from('forbidden', 'utf8'))).rejects.toThrow(/HTTP 403/u);

    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('re-sends the whole body on a retry rather than the remains of a consumed stream', async () => {
    const { server, backend } = await fixture();
    server.setFault({ failFirst: 1, status: 500, method: 'PUT' });
    const bytes = Buffer.from('X'.repeat(200_000), 'utf8');

    const result = await backend.put(bytes);

    expect(result.size).toBe(200_000);
    expect(readFileSync(join(server.root, storageKeyFor(result.sha256))).byteLength).toBe(200_000);
    expect(await backend.getBuffer(result.sha256)).toEqual(bytes);
  });
});

describe('WebDavBackend write verification levels', () => {
  it('lets a same-length corruption through when only the size is checked', async () => {
    // Stated as a test rather than as a caveat in a comment: `verifyOnWrite: 'size'` is one HEAD
    // and cannot see bytes that were swapped rather than lost.
    const { backend } = await fixture({ flipPutByte: 0 }, { verifyOnWrite: 'size' });

    const result = await backend.put(Buffer.from('one byte will be flipped', 'utf8'));

    expect(result.created).toBe(true);
    // …and the next read is where it is caught, because reads verify.
    await expect(backend.getBuffer(result.sha256)).rejects.toThrow(/Integrity failure/u);
  });

  it('catches the same corruption when the write is verified by digest', async () => {
    const { server, backend } = await fixture({ flipPutByte: 0 }, { verifyOnWrite: 'digest' });

    const error = await backend
      .put(Buffer.from('one byte will be flipped', 'utf8'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageRequestError);
    expect((error as Error).message).toMatch(/read back hashes to/u);
    // Caught at the temporary name, so nothing corrupt was ever moved under a digest.
    expect(server.requests.filter((request) => request.method === 'MOVE')).toEqual([]);
  });

  it('checks an existing blob by digest on every put when built that way', async () => {
    const { server, backend } = await fixture({}, { verifyOnPut: 'digest' });
    const bytes = Buffer.from('rot me in place!', 'utf8');
    const rotted = Buffer.from('rot me in plaice', 'utf8');
    expect(rotted.byteLength).toBe(bytes.byteLength);

    const first = await backend.put(bytes);
    await server.corrupt(storageKeyFor(first.sha256), rotted);

    const second = await backend.put(bytes);

    expect(second.repaired).toBe(true);
    expect(await backend.getBuffer(first.sha256)).toEqual(bytes);
  });

  it('skips the write check entirely when told to, and finds out on the read', async () => {
    const { server, backend } = await fixture({ truncatePutsTo: 2 }, { verifyOnWrite: 'none' });

    const result = await backend.put(Buffer.from('this will be cut short', 'utf8'));

    expect(result.created).toBe(true);
    expect(server.requests.filter((request) => request.method === 'HEAD')).toHaveLength(1);
    await expect(backend.getBuffer(result.sha256)).rejects.toThrow(/Integrity failure/u);
  });
});

describe('WebDavBackend stray temporary files', () => {
  it('lists the partial uploads a killed process left behind', async () => {
    const { server, backend } = await fixture();
    await backend.put(Buffer.from('a real blob', 'utf8'));
    expect(await backend.listStrayTempFiles()).toEqual([]);

    // What a `SIGKILL` between the PUT and the MOVE leaves: nothing cleans this up, and a store
    // that never mentions it fills somebody else's disk.
    await fetch(`${server.url}/.tmp/01JABANDONED.part`, { method: 'PUT', body: 'half a scan' });

    const stray = await backend.listStrayTempFiles();

    expect(stray).toHaveLength(1);
    expect(stray[0]).toMatch(/\/\.tmp\/01JABANDONED\.part$/u);
  });

  it('says nothing is stray when there is no temporary collection yet', async () => {
    const { backend } = await fixture();

    expect(await backend.listStrayTempFiles()).toEqual([]);
  });
});

describe('WebDavBackend server capability checks', () => {
  it('refuses an endpoint that does not advertise WebDAV at all', async () => {
    const { backend } = await fixture({ davCompliance: '' });

    const error = await backend.put(Buffer.from('not dav', 'utf8')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageUnsupportedError);
    expect((error as StorageUnsupportedError).capability).toBe('DAV: 1');
    expect((error as Error).message).toMatch(/not at a web UI/u);
  });

  it('asks the server what it can do exactly once', async () => {
    const { server, backend } = await fixture();

    await backend.put(Buffer.from('a', 'utf8'));
    await backend.put(Buffer.from('b', 'utf8'));

    expect(server.requests.filter((request) => request.method === 'OPTIONS')).toHaveLength(1);
  });

  it('explains itself when the server answers HEAD without a Content-Length', async () => {
    const { backend } = await fixture({ omitHeadContentLength: true });

    const error = await backend.put(Buffer.from('unmeasurable', 'utf8')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorageUnsupportedError);
    expect((error as StorageUnsupportedError).capability).toBe('Content-Length on HEAD');
  });
});

describe('WebDavBackend paths', () => {
  it('builds a URL from the digest and refuses anything else', async () => {
    const { server, backend } = await fixture();
    const digest = digestOf(Buffer.from('located', 'utf8'));

    expect(backend.path(digest)).toBe(`${server.url}/${storageKeyFor(digest)}`);
    expect(() => backend.path('../../../etc/passwd')).toThrow(/Not a SHA-256 digest/u);
  });

  it('reads back a blob that the server truncated after the fact, and fails the read', async () => {
    const { server, backend } = await fixture();
    const bytes = Buffer.from('Y'.repeat(4096), 'utf8');
    const { sha256 } = await backend.put(bytes);

    await server.corrupt(storageKeyFor(sha256), Buffer.from('Y'.repeat(4000), 'utf8'));

    await expect(backend.getBuffer(sha256)).rejects.toThrow(/Integrity failure/u);
    expect(await backend.verify(sha256)).toBe(false);
  });
});
