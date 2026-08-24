/**
 * `/api/v1/storage/backends` — configuring a remote store, and proving it works.
 *
 * The probes run against `startFakeWebDavServer`, which is a real HTTP server on loopback holding
 * real bytes in a real temporary directory. It proves the client is internally consistent and
 * nothing whatever about Nextcloud — the package's own README says so — but it is the difference
 * between a health endpoint that has been executed and one that has been written.
 *
 * The fault injection is the interesting part. `truncatePutsTo` and `flipPutByte` are the two ways
 * a store can accept a write and hold something else, and they are exactly what separates a probe
 * that reads back and compares from one that trusts a 201.
 */
import { startFakeWebDavServer } from '@recueil/storage-backends/testing';
import type { FakeWebDavServer } from '@recueil/storage-backends/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_SECRET_KEY, body, harness } from './helpers.js';
import type { Harness } from './helpers.js';

interface HealthResult {
  status: 'ok' | 'degraded' | 'failed';
  mode: string;
  checks: { check: string; ok: boolean; detail: string }[];
  detail: string;
}

describe('/api/v1/storage/backends', () => {
  let h: Harness;
  let server: FakeWebDavServer;

  beforeEach(async () => {
    server = await startFakeWebDavServer({ auth: { kind: 'basic', username: 'rh', password: 's3cret' } });
    h = await harness({ env: { RECUEIL_SECRET_KEY: TEST_SECRET_KEY } });
  });

  afterEach(async () => {
    await h.close();
    await server.close();
  });

  const create = async (overrides: Record<string, unknown> = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/storage/backends',
      payload: {
        name: 'Nextcloud',
        config: { kind: 'webdav', url: server.url, username: 'rh', authKind: 'basic' },
        secret: { password: 's3cret' },
        ...overrides,
      },
    });

  const health = async (id: string, mode?: string): Promise<HealthResult> =>
    body<HealthResult>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/storage/backends/${id}/health`,
        payload: mode === undefined ? {} : { mode },
      }),
    );

  it('stores a configuration without its credential, and does not rebind the library', async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);

    const backend = body<{ id: string; kind: string; secretNames: string[]; active: boolean }>(response);
    expect(backend.kind).toBe('webdav');
    expect(backend.secretNames).toEqual(['password']);
    expect(response.payload).not.toContain('s3cret');
    // Configuring is not rebinding: this process is still writing to the local filesystem.
    expect(backend.active).toBe(false);
    expect(h.recueil.storage.backend).toBe('local');
  });

  it('probes without writing in `read` mode', async () => {
    const id = body<{ id: string }>(await create()).id;
    const result = await health(id);

    expect(result.status).toBe('ok');
    expect(result.mode).toBe('read');
    expect(result.checks.map((check) => check.check)).toEqual(['configure', 'read']);
    // Nothing was written: the only methods the server saw are reads.
    expect(server.requests.every((request) => ['GET', 'HEAD', 'PROPFIND'].includes(request.method))).toBe(
      true,
    );
  });

  it('writes, reads back and cleans up in `roundtrip` mode', async () => {
    const id = body<{ id: string }>(await create()).id;
    const result = await health(id, 'roundtrip');

    expect(result.status).toBe('ok');
    expect(result.checks.map((check) => check.check)).toEqual([
      'configure',
      'read',
      'write',
      'verify',
      'cleanup',
    ]);
    expect(server.requests.some((request) => request.method === 'PUT')).toBe(true);
    expect(server.requests.some((request) => request.method === 'DELETE')).toBe(true);

    // The verdict is recorded, so a list view can show it without re-probing.
    const listed = body<{ data: { lastStatus: string; lastCheckedAt: string }[] }>(
      await h.app.inject({ method: 'GET', url: '/api/v1/storage/backends' }),
    );
    expect(listed.data[0]?.lastStatus).toBe('ok');
    expect(listed.data[0]?.lastCheckedAt).toBeTypeOf('string');
  });

  it('catches a server that stores different bytes of the same length', async () => {
    const id = body<{ id: string }>(await create()).id;
    // The rot a length check cannot see, which is why the probe hashes what it reads back.
    server.setFault(undefined);
    await server.close();
    server = await startFakeWebDavServer({
      auth: { kind: 'basic', username: 'rh', password: 's3cret' },
      flipPutByte: 0,
      verifyOcChecksum: false,
    });
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/storage/backends/${id}`,
      payload: { config: { kind: 'webdav', url: server.url, username: 'rh', authKind: 'basic' } },
    });

    const result = await health(id, 'roundtrip');
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/hash|digest|verif/iu);
  });

  it('names the read-back, not the write, when a store cannot serve what it accepted', async () => {
    const id = body<{ id: string }>(await create()).id;

    // The `PUT` is accepted; every `GET` after it fails. A probe that wrapped the write and the
    // read-back in one `try` would report this as a failed write and send an operator to look at
    // permissions on a store that took the bytes quite happily.
    server.setFault({ method: 'GET', failFirst: 50, status: 500 });

    const result = await health(id, 'roundtrip');
    expect(result.status).toBe('failed');

    const write = result.checks.filter((check) => check.check === 'write');
    expect(write.length).toBe(1);
    expect(write[0]?.ok).toBe(true);
    expect(result.checks.find((check) => check.check === 'verify')?.ok).toBe(false);

    // And the probe still tidied up after itself.
    expect(server.requests.some((request) => request.method === 'DELETE')).toBe(true);
  });

  it('does not claim to have cleaned up a probe blob it never wrote', async () => {
    const id = body<{ id: string }>(await create()).id;
    server.setFault({ method: 'PUT', failFirst: 50, status: 507 });

    const result = await health(id, 'roundtrip');
    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.check === 'write')?.ok).toBe(false);
    expect(result.checks.some((check) => check.check === 'verify')).toBe(false);
    expect(result.checks.some((check) => check.check === 'cleanup')).toBe(false);
  });

  it('reports a wrong credential as a failed read rather than a 500', async () => {
    const id = body<{ id: string }>(await create({ secret: { password: 'wrong' } })).id;
    const result = await health(id);

    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.check === 'read')?.ok).toBe(false);
  });

  it('refuses two backends with the same name', async () => {
    expect((await create()).statusCode).toBe(201);
    expect((await create()).statusCode).toBe(409);
  });

  it('refuses to store a credential with no key configured', async () => {
    const keyless = await harness();
    try {
      const response = await keyless.app.inject({
        method: 'POST',
        url: '/api/v1/storage/backends',
        payload: {
          name: 'Nextcloud',
          config: { kind: 'webdav', url: server.url },
          secret: { password: 's3cret' },
        },
      });
      expect(response.statusCode).toBe(409);
      expect(body<{ detail: string }>(response).detail).toContain('RECUEIL_SECRET_KEY');
    } finally {
      await keyless.close();
    }
  });

  it('removes a configuration that is not the live store', async () => {
    const id = body<{ id: string }>(await create()).id;
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/storage/backends/${id}` })).statusCode).toBe(
      204,
    );
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/storage/backends/${id}` })).statusCode).toBe(
      404,
    );
  });

  it('accepts an S3 configuration and reports a store it cannot reach as failed', async () => {
    // No MinIO, no container: an endpoint on a closed port is a real, reachable-in-a-test failure
    // and it exercises the same path a misconfigured bucket would.
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/storage/backends',
      payload: {
        name: 'MinIO',
        config: {
          kind: 's3',
          bucket: 'library',
          endpoint: 'http://127.0.0.1:1',
          forcePathStyle: true,
          accessKeyId: 'minioadmin',
        },
        secret: { secretAccessKey: 'minioadmin' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(body<{ kind: string; secretNames: string[] }>(created)).toMatchObject({
      kind: 's3',
      secretNames: ['secretAccessKey'],
    });

    const result = await health(body<{ id: string }>(created).id);
    expect(result.status).toBe('failed');
    expect(result.checks.find((check) => check.check === 'read')?.ok).toBe(false);
  }, 30_000);
});
