/**
 * `/api/v1/ingestion` — sources, the share-target upload, the work queue and the review queue.
 *
 * Every test here drives the real thing: a real SQLite library in a temporary directory, the real
 * `@recueil/ingest` pipeline, a real watched folder on the filesystem and — for the WebDAV source —
 * the in-process fake server from `@recueil/storage-backends/testing`, listening on loopback. There
 * is no container anywhere and no mock of the pipeline: a test that stubbed the pipeline would
 * prove that the route calls a stub.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { listStoredBlobs } from '@recueil/core';

import { startFakeWebDavServer } from '@recueil/storage-backends/testing';
import type { FakeWebDavServer } from '@recueil/storage-backends/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SecretBox } from '../src/ingestion/secrets.js';
import { IngestionSourceService, redact } from '../src/ingestion/sources.js';

import { startFakeImap } from './fakes/imap-server.js';
import type { FakeImapServer } from './fakes/imap-server.js';

import {
  TEST_SECRET_KEY,
  body,
  harness,
  listen,
  multipart,
  readSseFrames,
  temporaryDirectory,
} from './helpers.js';
import type { Harness } from './helpers.js';

/** A plausible office document as bytes: an invoice, in plain text. */
const INVOICE = [
  'Stadtwerke Ulm',
  'Rechnung Nr. 2026-0042',
  'Rechnungsdatum: 12.03.2026',
  '',
  'Betrag: 84,20 EUR',
].join('\n');

interface UploadResult {
  outcome: string;
  jobId: string;
  document: { id: string; sha256: string } | null;
  item: { id: string } | null;
  reviewEntry: { id: string; status: string; proposedAction: string | null } | null;
  reasonCode: string | null;
  detail: string;
}

const upload = async (
  h: Harness,
  content: string,
  filename = 'invoice.txt',
  fields: Record<string, string> = {},
): Promise<{ status: number; result: UploadResult }> => {
  const part = multipart(
    { name: 'file', filename, contentType: 'text/plain', bytes: content },
    fields,
  );
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/v1/ingestion/upload',
    payload: part.payload,
    headers: part.headers,
  });
  return { status: response.statusCode, result: body<UploadResult>(response) };
};

/* ============================================================================================== */
/* Sources                                                                                          */
/* ============================================================================================== */

describe('/api/v1/ingestion/sources', () => {
  let h: Harness;
  let watched: { path: string; remove: () => void };

  beforeEach(async () => {
    watched = temporaryDirectory();
    h = await harness({ env: { RECUEIL_SECRET_KEY: TEST_SECRET_KEY } });
  });

  afterEach(async () => {
    await h.close();
    watched.remove();
  });

  const createFolderSource = async (overrides: Record<string, unknown> = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/sources',
      payload: {
        name: 'Scanner drop',
        sourceKind: 'scanner',
        config: { kind: 'folder', root: watched.path },
        ...overrides,
      },
    });

  it('configures a watched folder and resolves its root', async () => {
    const response = await createFolderSource();
    expect(response.statusCode).toBe(201);

    const source = body<{ id: string; kind: string; config: { root: string }; secretNames: string[] }>(
      response,
    );
    expect(source.kind).toBe('folder');
    expect(source.secretNames).toEqual([]);
    // The stored root is the resolved, symlink-followed one, not the string that was sent: on
    // macOS `/var/folders/...` is a link to `/private/var/folders/...` and the two must not both
    // be configurable as separate sources.
    expect(source.config.root.endsWith(watched.path.split('/').pop() as string)).toBe(true);
    expect(response.headers['location']).toBe(`/api/v1/ingestion/sources/${source.id}`);
  });

  it('refuses a relative root, and a root that is not there', async () => {
    const relative = await createFolderSource({ config: { kind: 'folder', root: './consume' } });
    expect(relative.statusCode).toBe(422);
    expect(body<{ detail: string }>(relative).detail).toMatch(/absolute/iu);

    const missing = await createFolderSource({
      config: { kind: 'folder', root: join(watched.path, 'not-here') },
    });
    expect(missing.statusCode).toBe(422);
  });

  it('refuses a consume destination that escapes the root', async () => {
    const response = await createFolderSource({
      consume: { mode: 'move', to: '../../elsewhere' },
    });
    expect(response.statusCode).toBe(422);
    expect(body<{ detail: string }>(response).detail).toMatch(/outside the source root/iu);
  });

  it('honours RECUEIL_INGEST_ALLOWED_ROOTS', async () => {
    const other = temporaryDirectory('recueil-allowed-');
    const guarded = await harness({
      env: { RECUEIL_SECRET_KEY: TEST_SECRET_KEY, RECUEIL_INGEST_ALLOWED_ROOTS: other.path },
    });
    try {
      const outside = await guarded.app.inject({
        method: 'POST',
        url: '/api/v1/ingestion/sources',
        payload: { name: 'Outside', config: { kind: 'folder', root: watched.path } },
      });
      expect(outside.statusCode).toBe(422);
      expect(body<{ detail: string }>(outside).detail).toContain('RECUEIL_INGEST_ALLOWED_ROOTS');

      const inside = join(other.path, 'inbox');
      mkdirSync(inside);
      const allowed = await guarded.app.inject({
        method: 'POST',
        url: '/api/v1/ingestion/sources',
        payload: { name: 'Inside', config: { kind: 'folder', root: inside } },
      });
      expect(allowed.statusCode).toBe(201);
    } finally {
      await guarded.close();
      other.remove();
    }
  });

  it('refuses two sources with the same name', async () => {
    expect((await createFolderSource()).statusCode).toBe(201);
    const clash = await createFolderSource();
    expect(clash.statusCode).toBe(409);
  });

  it('never returns a credential, and says which ones it holds', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/sources',
      payload: {
        name: 'Mailbox',
        config: { kind: 'imap', host: '127.0.0.1', username: 'rh', port: 1143, secure: false },
        secret: { password: 'hunter2' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(body<{ secretNames: string[] }>(created).secretNames).toEqual(['password']);
    // The whole response body, not just the fields the schema names: a strict schema would reject
    // an extra key, but this is the assertion that matters and it is worth making directly.
    expect(created.payload).not.toContain('hunter2');

    const id = body<{ id: string }>(created).id;
    const fetched = await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/sources/${id}` });
    expect(fetched.payload).not.toContain('hunter2');

    const listed = await h.app.inject({ method: 'GET', url: '/api/v1/ingestion/sources' });
    expect(listed.payload).not.toContain('hunter2');

    // And it really is encrypted at rest, not merely omitted from the response.
    const stored = h.recueil.connection
      .prepare('select secret_ciphertext from ingestion_sources where id = ?')
      .get(id) as { secret_ciphertext: string };
    expect(stored.secret_ciphertext).not.toContain('hunter2');
    expect(stored.secret_ciphertext.startsWith('v1.')).toBe(true);
  });

  it('refuses to store a credential when no key is configured', async () => {
    const keyless = await harness();
    try {
      const response = await keyless.app.inject({
        method: 'POST',
        url: '/api/v1/ingestion/sources',
        payload: {
          name: 'Mailbox',
          config: { kind: 'imap', host: '127.0.0.1', username: 'rh' },
          secret: { password: 'hunter2' },
        },
      });
      expect(response.statusCode).toBe(409);
      expect(body<{ detail: string }>(response).detail).toContain('RECUEIL_SECRET_KEY');

      // A source that needs no credential is still configurable on such a server.
      const plain = await keyless.app.inject({
        method: 'POST',
        url: '/api/v1/ingestion/sources',
        payload: { name: 'Drop', config: { kind: 'folder', root: watched.path } },
      });
      expect(plain.statusCode).toBe(201);
    } finally {
      await keyless.close();
    }
  });

  it('enables and disables', async () => {
    const id = body<{ id: string }>(await createFolderSource()).id;

    const disabled = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/sources/${id}/disable`,
    });
    expect(body<{ enabled: boolean; version: number }>(disabled).enabled).toBe(false);

    const enabled = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/sources/${id}/enable`,
    });
    expect(body<{ enabled: boolean }>(enabled).enabled).toBe(true);

    const filtered = await h.app.inject({ method: 'GET', url: '/api/v1/ingestion/sources?enabled=false' });
    expect(body<{ data: unknown[] }>(filtered).data).toHaveLength(0);
  });

  it('refuses to run a disabled source', async () => {
    const id = body<{ id: string }>(await createFolderSource()).id;
    await h.app.inject({ method: 'POST', url: `/api/v1/ingestion/sources/${id}/disable` });

    const run = await h.app.inject({ method: 'POST', url: `/api/v1/ingestion/sources/${id}/run` });
    expect(run.statusCode).toBe(409);
  });

  it('tests a folder connection against the filesystem', async () => {
    const id = body<{ id: string }>(await createFolderSource()).id;
    writeFileSync(join(watched.path, 'a.txt'), 'hello');

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/sources/${id}/test-connection`,
    });
    expect(response.statusCode).toBe(200);

    const result = body<{ ok: boolean; checks: { check: string; ok: boolean; detail: string }[] }>(
      response,
    );
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.check)).toEqual(['resolve', 'directory', 'read']);
    // The read check counted what is really there, so it is evidence and not a constant.
    expect(result.checks[2]?.detail).toContain('1 entr');
  });

  it('reports a folder that has gone away rather than claiming success', async () => {
    const id = body<{ id: string }>(await createFolderSource()).id;
    watched.remove();

    const result = body<{ ok: boolean; checks: { check: string; ok: boolean }[] }>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/ingestion/sources/${id}/test-connection`,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ check: 'resolve', ok: false });

    // Put it back so `afterEach` has something to remove.
    mkdirSync(watched.path, { recursive: true });
  });

  it('removes a source without touching what it produced', async () => {
    const id = body<{ id: string }>(await createFolderSource()).id;
    const removed = await h.app.inject({ method: 'DELETE', url: `/api/v1/ingestion/sources/${id}` });
    expect(removed.statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/sources/${id}` })).statusCode).toBe(
      404,
    );

    const audit = h.recueil.connection
      .prepare(`select action, before from audit_log where entity_type = 'ingestion_source' order by id`)
      .all() as { action: string; before: string | null }[];
    expect(audit.map((row) => row.action)).toContain('ingestion_source.removed');
    // The configuration is recoverable from the log, which is what makes the delete acceptable.
    const removal = audit.find((row) => row.action === 'ingestion_source.removed');
    expect(JSON.parse(removal?.before ?? '{}')).toMatchObject({ kind: 'folder' });
  });
});

/* ============================================================================================== */
/* WebDAV, against an in-process server                                                             */
/* ============================================================================================== */

describe('a WebDAV source', () => {
  let h: Harness;
  let server: FakeWebDavServer;

  beforeEach(async () => {
    server = await startFakeWebDavServer({ auth: { kind: 'basic', username: 'rh', password: 's3cret' } });
    // The fake listens on loopback, which is precisely what `EgressGuard` refuses by default. That
    // is the operator opt-in of workstream H4, exercised the way an operator would use it: a
    // deliberately internal target, declared once for the process. Every SSRF test below runs
    // *without* it, which is what makes this line a declaration rather than a weakening.
    vi.stubEnv('RECUEIL_INGEST_ALLOW_PRIVATE_TARGETS', 'true');
    h = await harness({ env: { RECUEIL_SECRET_KEY: TEST_SECRET_KEY } });
  });

  afterEach(async () => {
    await h.close();
    await server.close();
    vi.unstubAllEnvs();
  });

  const create = async (secret: Record<string, string>) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/sources',
      payload: {
        name: 'Nextcloud inbox',
        config: { kind: 'webdav', url: server.url, username: 'rh', authKind: 'basic' },
        secret,
      },
    });

  it('passes the connection test with the right password', async () => {
    const id = body<{ id: string }>(await create({ password: 's3cret' })).id;

    const result = body<{ ok: boolean; checks: { check: string; ok: boolean }[] }>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/ingestion/sources/${id}/test-connection`,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.check)).toEqual(['options', 'list']);
    // The server really was spoken to, twice.
    expect(server.requests.map((request) => request.method)).toEqual(['OPTIONS', 'PROPFIND']);
  });

  it('fails the connection test with the wrong password', async () => {
    const id = body<{ id: string }>(await create({ password: 'wrong' })).id;

    const result = body<{ ok: boolean; detail: string }>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/ingestion/sources/${id}/test-connection`,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/401|unauthor/iu);
  });
});

/* ============================================================================================== */
/* Where the server may connect, and what it may say about it (hardening H4)                        */
/* ============================================================================================== */

/** A stand-in for whatever is listening inside the machine: an EC2 metadata service, say. */
interface InternalService {
  readonly origin: string;
  readonly requests: { method: string; url: string }[];
  close(): Promise<void>;
}

const startInternalService = async (): Promise<InternalService> => {
  const requests: { method: string; url: string }[] = [];
  const server: Server = createServer((request, response) => {
    requests.push({ method: request.method ?? '?', url: request.url ?? '?' });
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('SECRET-FROM-INTERNAL-SERVICE: aws_secret_access_key=wJalrXUtnFEMI/K7MDENG');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};

/**
 * The Phase 2 review's SSRF proof, as a test.
 *
 * The review created a WebDAV source with `url: http://127.0.0.1:<port>/latest/meta-data/`, got a
 * 201, and then got a 200 out of `test-connection` whose `detail` read
 * `options: OPTIONS http://127.0.0.1:35781/latest/meta-data/ answered 500:
 * SECRET-FROM-INTERNAL-SERVICE: aws_secret_access_key=…`. `z.url().max(2048)` and a scheme test were
 * the whole of the validation, and anything holding `ingestion:write` — by default, anything at all
 * — could aim the server at any address it could reach.
 */
describe('a source URL is not a way into this machine', () => {
  let h: Harness;
  let internal: InternalService;

  beforeEach(async () => {
    internal = await startInternalService();
    h = await harness({ env: { RECUEIL_SECRET_KEY: TEST_SECRET_KEY } });
  });

  afterEach(async () => {
    await h.close();
    await internal.close();
  });

  const createWebDav = async (url: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/sources',
      payload: { name: `Probe ${url}`, config: { kind: 'webdav', url } },
    });

  it('refuses a source pointing at loopback, and never connects to it', async () => {
    const response = await createWebDav(`${internal.origin}/latest/meta-data/`);

    expect(response.statusCode).toBe(422);
    expect(body<{ detail: string }>(response).detail).toMatch(/loopback/iu);
    // The proof that matters: nothing was sent. A refusal that still made the request would have
    // leaked the timing and, with it, whether the port is open.
    expect(internal.requests).toEqual([]);
    // And nothing was stored, so no later run can pick it up.
    expect(
      h.recueil.connection.prepare('select count(*) as n from ingestion_sources').get(),
    ).toEqual({ n: 0 });
  });

  it('refuses link-local, IPv6 loopback, private and multicast addresses too', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/', // the cloud metadata address
      'http://[::1]:8080/dav/',
      'http://[::ffff:127.0.0.1]:8080/dav/', // the same address, wearing IPv6
      'http://10.0.0.5/dav/',
      'http://192.168.1.4/remote.php/dav/',
      'http://172.16.9.9/dav/',
      'http://127.1/dav/', // 127.0.0.1 written the short way
      'http://224.0.0.1/dav/',
      'http://[fd00::1]/dav/',
      'http://[fe80::1]/dav/',
    ]) {
      const response = await createWebDav(url);
      expect(`${url} → ${String(response.statusCode)}`).toBe(`${url} → 422`);
    }
  });

  it('accepts a loopback target when the operator has opted in', async () => {
    vi.stubEnv('RECUEIL_INGEST_ALLOW_PRIVATE_TARGETS', 'true');
    const opted = await harness({ env: { RECUEIL_SECRET_KEY: TEST_SECRET_KEY } });
    try {
      const response = await opted.app.inject({
        method: 'POST',
        url: '/api/v1/ingestion/sources',
        payload: {
          name: 'The NAS in the cupboard',
          config: { kind: 'webdav', url: `${internal.origin}/dav/` },
        },
      });
      expect(response.statusCode).toBe(201);
    } finally {
      await opted.close();
      vi.unstubAllEnvs();
    }
  });
});

/**
 * DNS rebinding: the reason the address rule cannot live at the configuration form.
 *
 * The name below resolves to a public address while the source is being created and to `127.0.0.1`
 * by the time anything connects to it — one A record and a zero TTL, which is entirely within the
 * gift of whoever owns the domain in the URL. A parse-time check sees only the first answer and
 * admits the source; the second answer is the one the socket uses.
 *
 * The service is built directly rather than through `buildApp` because the whole test is about what
 * the *resolver* returns, and a resolver has to be injected somewhere. Everything else is real: the
 * real `IngestionSourceService`, the real `WebDavClient`, and a real HTTP server on loopback
 * standing in for whatever the rebind lands on.
 */
describe('a name that rebinds between the form and the socket', () => {
  let h: Harness;
  let internal: InternalService;

  beforeEach(async () => {
    internal = await startInternalService();
    h = await harness({ env: { RECUEIL_SECRET_KEY: TEST_SECRET_KEY } });
  });

  afterEach(async () => {
    await h.close();
    await internal.close();
  });

  it('is admitted by the form and refused by the connection', async () => {
    const resolved: string[] = [];
    let call = 0;
    const service = new IngestionSourceService({
      recueil: h.recueil,
      secrets: SecretBox.fromConfig(h.config.secretKey),
      allowedRoots: [],
      resolve: async (hostname) => {
        // First answer public, every answer after that loopback. The zone is the attacker's.
        const address = call === 0 ? '93.184.216.34' : '127.0.0.1';
        call += 1;
        resolved.push(`${hostname} -> ${address}`);
        return [{ address, family: 4 }];
      },
    });
    const port = new URL(internal.origin).port;
    const row = await service.create(
      {
        name: 'Rebinding share',
        config: { kind: 'webdav', url: `http://share.rebind.example:${port}/dav/` },
      },
      h.recueil.actor,
    );
    // The form passed: at that moment the name was a public address, exactly as the attacker
    // arranged. A parse-time-only check has now finished its work.
    expect(row.id).toBeTruthy();
    expect(resolved[0]).toBe('share.rebind.example -> 93.184.216.34');

    const checks = await service.testConnection(row);
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.detail).toMatch(/loopback/iu);
    // The socket was never opened, so the rebind bought nothing.
    expect(internal.requests).toEqual([]);
    expect(resolved.length).toBeGreaterThan(1);
  });
});

/**
 * The Phase 2 review's credential-leak proof, as a test.
 *
 * The review created a source with `url: http://carol:hunter2@127.0.0.1:46289/…`, then read the
 * password back out of `GET /ingestion/sources/{id}` and, twice more, out of the `detail` of
 * `test-connection`. `IngestionSourceConfig` is documented as "everything about a source that is
 * safe to send back. Credentials are not in here", and `url` was outside that promise.
 *
 * Every response body this suite can reach is swept for the secret, which is the acceptance
 * criterion H4 sets: not "the field we thought of is clean" but "the string does not appear".
 */
describe('a password pasted into a source URL', () => {
  let h: Harness;
  let server: FakeWebDavServer;

  beforeEach(async () => {
    server = await startFakeWebDavServer({ auth: { kind: 'basic', username: 'carol', password: 'hunter2' } });
    vi.stubEnv('RECUEIL_INGEST_ALLOW_PRIVATE_TARGETS', 'true');
    h = await harness({ env: { RECUEIL_SECRET_KEY: TEST_SECRET_KEY } });
  });

  afterEach(async () => {
    await h.close();
    await server.close();
    vi.unstubAllEnvs();
  });

  const withUserinfo = (): string => {
    const url = new URL(server.url);
    url.username = 'carol';
    url.password = 'hunter2';
    return url.toString();
  };

  it('moves into the secret box, never comes back, and still authenticates', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/sources',
      payload: { name: 'Nextcloud inbox', config: { kind: 'webdav', url: withUserinfo() } },
    });
    expect(created.statusCode).toBe(201);
    const source = body<{ id: string; config: { url: string; username?: string }; secretNames: string[] }>(
      created,
    );

    // Split at ingress: the address is stored, the credential is sealed, and the username — which
    // is not a secret and is needed to build the Authorization header — is kept in the config.
    expect(source.config.url).not.toContain('carol');
    expect(source.config.url).not.toContain('hunter2');
    expect(source.config.username).toBe('carol');
    expect(source.secretNames).toEqual(['password']);

    // The stored row, read straight out of SQLite: the ciphertext column is the only place the
    // password may be, and `config` is what a leaked recueil.db hands over first.
    const stored = h.recueil.connection
      .prepare('select config, secret_ciphertext from ingestion_sources')
      .all() as { config: string; secret_ciphertext: string | null }[];
    expect(stored[0]?.config).not.toContain('hunter2');
    expect(stored[0]?.secret_ciphertext).not.toBeNull();
    expect(stored[0]?.secret_ciphertext).not.toContain('hunter2');

    // It really did become the credential, rather than being quietly dropped: the fake share wants
    // basic auth as carol/hunter2 and the connection test passes.
    const test = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/sources/${source.id}/test-connection`,
    });
    expect(body<{ ok: boolean }>(test).ok).toBe(true);

    const list = await h.app.inject({ method: 'GET', url: '/api/v1/ingestion/sources' });
    const one = await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/sources/${source.id}` });
    for (const [label, response] of [
      ['create', created],
      ['list', list],
      ['get', one],
      ['test-connection', test],
    ] as const) {
      expect(`${label}: ${response.payload}`).not.toContain('hunter2');
    }
  });

  it('keeps the password out of the check details when the connection fails', async () => {
    // The review got the password back twice in one `test-connection` body, out of an error
    // message that interpolated `url.toString()`. Point the source somewhere that will not answer
    // and read every word of what comes back.
    const url = new URL(server.url);
    url.username = 'carol';
    url.password = 'hunter2';
    url.pathname = '/definitely-not-a-collection/';
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/sources',
      payload: { name: 'Broken share', config: { kind: 'webdav', url: url.toString() } },
    });
    const id = body<{ id: string }>(created).id;

    const test = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/sources/${id}/test-connection`,
    });
    expect(test.payload).not.toContain('hunter2');
    expect(test.payload).not.toContain(Buffer.from('carol:hunter2', 'utf8').toString('base64'));
  });

  it('scrubs a secret out of a string in the forms it travels in', () => {
    expect(redact('OPTIONS failed: bad password hunter2', ['hunter2'])).toBe(
      'OPTIONS failed: bad password [redacted]',
    );
    // Percent-encoded, which is how it looks once something has put it back into a URL.
    expect(redact('http://host/dav/?p=p%40ss%3Aword', ['p@ss:word'])).toContain('[redacted]');
    // An Authorization header quoted back inside an exception. The password is inside the base64
    // of `user:pass`, so searching for the password would not find it; the header is scrubbed by
    // shape instead.
    const header = `Basic ${Buffer.from('carol:hunter2', 'utf8').toString('base64')}`;
    expect(redact(`request failed with ${header}`, [])).toBe('request failed with Basic [redacted]');
    expect(redact('sent Bearer abc.def.ghi', [])).toBe('sent Bearer [redacted]');
    // Too short to be told apart from prose: redacting every 'a' would destroy the message and
    // protect nothing.
    expect(redact('a cat sat on the mat', ['a'])).toBe('a cat sat on the mat');
  });

  it('keeps the password out of the job log and out of last_error', async () => {
    // The review noted that the credential "also appears in the job log via `describe(error)`".
    // A run against a share that will not answer is the shortest way to make this application
    // write an exception message from the WebDAV client into both places a caller can read it.
    const url = new URL(server.url);
    url.username = 'carol';
    url.password = 'hunter2';
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/sources',
      payload: { name: 'Doomed share', config: { kind: 'webdav', url: url.toString() } },
    });
    const id = body<{ id: string }>(created).id;
    // The collection is not there, which is what an operator's typo looks like and what a moved
    // share looks like. The run fails somewhere inside the WebDAV client.
    await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/ingestion/sources/${id}`,
      payload: {
        config: {
          kind: 'webdav',
          url: `${url.toString().replace(/\/$/u, '')}/definitely-not-a-collection/`,
        },
      },
    });

    const accepted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/sources/${id}/run`,
      payload: { runLabel: 'doomed' },
    });
    expect(accepted.statusCode).toBe(202);
    const jobId = body<{ jobId: string }>(accepted).jobId;

    const deadline = Date.now() + 15_000;
    let job = await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/queue/${jobId}` });
    while (['queued', 'running'].includes(body<{ job: { state: string } }>(job).job.state)) {
      if (Date.now() > deadline) throw new Error('the run never settled');
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/queue/${jobId}` });
    }

    // The whole job document — state, error message and every log line — and then the source row
    // the list view renders from.
    expect(job.payload).not.toContain('hunter2');
    const source = await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/sources/${id}` });
    expect(source.payload).not.toContain('hunter2');
    // Stored, not merely omitted on the way out: a secret in a column is a secret in the backup.
    const rows = h.recueil.connection
      .prepare('select last_error from ingestion_sources where id = ?')
      .all(id) as { last_error: string | null }[];
    expect(JSON.stringify(rows)).not.toContain('hunter2');
    const logs = h.recueil.connection
      .prepare('select message from job_logs')
      .all() as { message: string }[];
    expect(JSON.stringify(logs)).not.toContain('hunter2');
  });

  it('takes the userinfo back off a row an older build wrote', async () => {
    // `sourceToWire` is the last thing between the row and the response body, and rows written
    // before the ingress split still carry whatever was pasted. Written here the way that build
    // would have written it: straight into `config`.
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/sources',
      payload: { name: 'Legacy share', config: { kind: 'webdav', url: server.url } },
    });
    const id = body<{ id: string }>(created).id;
    h.recueil.connection
      .prepare('update ingestion_sources set config = ? where id = ?')
      .run(JSON.stringify({ kind: 'webdav', url: withUserinfo() }), id);

    // The row really does hold the password now, which is the state an older build left behind.
    const stored = h.recueil.connection
      .prepare('select config from ingestion_sources where id = ?')
      .get(id) as { config: string };
    expect(stored.config).toContain('hunter2');

    const response = await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/sources/${id}` });
    expect(response.payload).not.toContain('hunter2');
    expect(response.payload).not.toContain('carol:');
  });
});

/* ============================================================================================== */
/* The share-target upload, the queue and the review queue                                          */
/* ============================================================================================== */

describe('an IMAP source', () => {
  let h: Harness;
  let server: FakeImapServer;

  beforeEach(async () => {
    server = await startFakeImap({
      username: 'rh',
      password: 'mailbox-secret',
      mailboxes: { INBOX: 3, Rechnungen: 0 },
    });
    h = await harness({ env: { RECUEIL_SECRET_KEY: TEST_SECRET_KEY } });
  });

  afterEach(async () => {
    await h.close();
    await server.close();
  });

  const create = async (
    secret: Record<string, string>,
    overrides: Record<string, unknown> = {},
  ) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/sources',
      payload: {
        name: 'Scanner mailbox',
        sourceKind: 'imap',
        config: {
          kind: 'imap',
          host: server.host,
          port: server.port,
          // Loopback, and the fake speaks plain IMAP: implicit TLS on a socket with no certificate
          // would fail at the handshake and prove nothing about the three checks under test.
          secure: false,
          username: 'rh',
          mailbox: 'INBOX',
        },
        secret,
        ...overrides,
      },
    });

  it('connects, logs in and selects the mailbox', async () => {
    const id = body<{ id: string }>(await create({ password: 'mailbox-secret' })).id;

    const result = body<{ ok: boolean; checks: { check: string; ok: boolean; detail: string }[] }>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/ingestion/sources/${id}/test-connection`,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.check)).toEqual(['connect', 'login', 'select']);
    // The count in the answer is the server's own EXISTS, not something the route invented.
    expect(result.checks[2]?.detail).toMatch(/3 message/u);

    // And the far side really was spoken to, in the order the checks claim.
    const verbs = server.commands.map((line) => line.split(' ')[1]?.toUpperCase());
    expect(verbs).toContain('LOGIN');
    expect(verbs).toContain('SELECT');
    expect(verbs).toContain('LOGOUT');
  });

  it('reports a wrong password as a failed login rather than a green tick', async () => {
    const id = body<{ id: string }>(await create({ password: 'not-the-password' })).id;

    const result = body<{ ok: boolean; checks: { check: string; ok: boolean }[]; detail: string }>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/ingestion/sources/${id}/test-connection`,
      }),
    );

    expect(result.ok).toBe(false);
    // The socket opened — that check is honest — and the login is the one that failed.
    expect(result.checks.find((check) => check.check === 'connect')?.ok).toBe(true);
    expect(result.checks.find((check) => check.check === 'login')?.ok).toBe(false);
    expect(result.detail).toMatch(/login|credential/iu);
  });

  it('reports a mailbox that is not there', async () => {
    const id = body<{ id: string }>(
      await create(
        { password: 'mailbox-secret' },
        {
          config: {
            kind: 'imap',
            host: server.host,
            port: server.port,
            secure: false,
            username: 'rh',
            mailbox: 'Nowhere',
          },
        },
      ),
    ).id;

    const result = body<{ ok: boolean; checks: { check: string; ok: boolean }[] }>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/ingestion/sources/${id}/test-connection`,
      }),
    );

    expect(result.ok).toBe(false);
    // The login was fine; it is the SELECT that failed, and the report says so. Reporting this as
    // a failed login would send an operator to reset a password that was never wrong.
    expect(result.checks.find((check) => check.check === 'login')?.ok).toBe(true);
    expect(result.checks.find((check) => check.check === 'select')?.ok).toBe(false);
  });

  it('refuses to test a mailbox it holds no password for', async () => {
    const id = body<{ id: string }>(await create({})).id;

    const result = body<{ ok: boolean; checks: { check: string; ok: boolean; detail: string }[] }>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/ingestion/sources/${id}/test-connection`,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      { check: 'credentials', ok: false, detail: 'no password is stored for this mailbox' },
    ]);
    // Nothing was dialled: a source with no credential is refused before the socket.
    expect(server.commands).toEqual([]);
  });
});

describe('POST /api/v1/ingestion/upload', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('runs the pipeline and reports what the gate decided', async () => {
    const { status, result } = await upload(h, INVOICE);

    expect(status).toBe(200);
    // No OCR and no resolvers in this build, so a plain text invoice does not clear the default
    // 0.75 gate: it is stored and queued, which is P3 working rather than a failure.
    expect(result.outcome).toBe('review');
    expect(result.document).not.toBeNull();
    expect(result.reviewEntry).not.toBeNull();
    expect(result.reviewEntry?.status).toBe('open');
    expect(result.reviewEntry?.proposedAction).toBe('create_item');
    expect(result.item).toBeNull();
    expect(result.jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

    // The document really is in the library, addressed by its digest.
    const stored = await h.app.inject({
      method: 'GET',
      url: `/api/v1/documents/by-sha256/${result.document?.sha256 ?? ''}`,
    });
    expect(stored.statusCode).toBe(200);
  });

  it('creates the item outright when the gate is open', async () => {
    const permissive = await harness({ env: { RECUEIL_INGEST_CONFIDENCE_THRESHOLD: '0' } });
    try {
      const { status, result } = await upload(permissive, INVOICE);
      expect(status).toBe(201);
      expect(result.outcome).toBe('ingested');
      expect(result.item).not.toBeNull();
      expect(result.reviewEntry).toBeNull();

      const item = await permissive.app.inject({
        method: 'GET',
        url: `/api/v1/items/${result.item?.id ?? ''}`,
      });
      expect(item.statusCode).toBe(200);
    } finally {
      await permissive.close();
    }
  });

  it('re-enters bytes that were stored but never filed, rather than calling them a duplicate', async () => {
    const first = await upload(h, INVOICE);
    const second = await upload(h, INVOICE, 'a-different-name.txt');

    // CONCEPT §5.3 stage 2 is "link to the existing document, log, stop" — but only once the
    // document is *filed*. These bytes are in the store and in nobody's library record, so the
    // second arrival goes through the gate again and refreshes the open entry rather than being
    // dismissed as already handled. The entry is the same one, keyed by its dedupe key (P9).
    expect(second.result.outcome).toBe('review');
    expect(second.result.reviewEntry?.id).toBe(first.result.reviewEntry?.id);

    // One document either way: the name is not the identity (P2).
    const documents = h.recueil.connection
      .prepare('select count(*) as n from documents')
      .get() as { n: number };
    expect(documents.n).toBe(1);
  });

  it('reports the second arrival of filed bytes as a duplicate', async () => {
    const first = await upload(h, INVOICE);
    const accepted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/review/${first.result.reviewEntry?.id ?? ''}/accept`,
    });
    expect(accepted.statusCode).toBe(200);

    const second = await upload(h, INVOICE, 'a-different-name.txt');
    expect(second.status).toBe(200);
    expect(second.result.outcome).toBe('duplicate');
    expect(second.result.document?.sha256).toBe(first.result.document?.sha256);
    expect(second.result.item).toBeNull();

    // Still one document and one item: the arrival was recorded and nothing was created twice.
    const counts = h.recueil.connection
      .prepare('select (select count(*) from documents) as documents, (select count(*) from items) as items')
      .get() as { documents: number; items: number };
    expect(counts).toEqual({ documents: 1, items: 1 });
  });

  it('never lets a filename become a path', async () => {
    const { result } = await upload(h, 'traversal attempt', '../../etc/passwd');
    expect(result.outcome).toBe('review');

    const document = h.recueil.connection
      .prepare('select original_filename, source_ref from documents where id = ?')
      .get(result.document?.id) as { original_filename: string | null; source_ref: string | null };
    expect(document.original_filename).toBe('passwd');
    expect(document.source_ref ?? '').not.toContain('..');
  });

  it('leaves nothing of its own in the content store', async () => {
    const { result } = await upload(h, INVOICE);
    expect(result.document).not.toBeNull();

    // `listStoredBlobs` reports everything in the store root that is not ADR-0004's layout, so a
    // spool directory of the upload route's own would show up here — on every backup, for ever.
    const store = await listStoredBlobs(h.config.storagePath);
    expect(store.ignored).toEqual([]);
    expect(store.blobs.length).toBeGreaterThan(0);
  });

  it('refuses a request that is not multipart', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/upload',
      payload: { file: 'nope' },
    });
    expect(response.statusCode).toBe(415);
  });
});

describe('/api/v1/ingestion/queue', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('lists the run an upload created and shows its stage trace', async () => {
    const { result } = await upload(h, INVOICE);

    const listed = body<{ data: { id: string; jobType: string; state: string }[] }>(
      await h.app.inject({ method: 'GET', url: '/api/v1/ingestion/queue' }),
    );
    expect(listed.data.some((job) => job.id === result.jobId)).toBe(true);

    const detail = body<{
      job: { id: string; state: string; result: Record<string, unknown> | null };
      stages: { candidateKey: string; stage: string }[];
      log: { message: string }[];
      reviewEntryIds: string[];
    }>(await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/queue/${result.jobId}` }));

    expect(detail.job.id).toBe(result.jobId);
    // A run that queued something is `waiting_review`, not `failed` and not `succeeded` (IK6).
    expect(detail.job.state).toBe('waiting_review');
    // The trace comes from `ingest_checkpoints`, which is what a resumed run reads.
    expect(detail.stages.length).toBeGreaterThan(0);
    expect(detail.stages.map((stage) => stage.stage)).toContain('commit');
    // And the review ids are queried from the queue rather than counted from the run's own tally.
    expect(detail.reviewEntryIds).toEqual([result.reviewEntry?.id]);
  });

  it('refuses to cancel a run that has already finished', async () => {
    const { result } = await upload(h, INVOICE);
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/queue/${result.jobId}/cancel`,
    });
    expect(response.statusCode).toBe(409);
  });

  it('404s on a job that is not there', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/v1/ingestion/queue/01JXXXXXXXXXXXXXXXXXXXXXXX',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('running a configured source', () => {
  let h: Harness;
  let watched: { path: string; remove: () => void };
  let sourceId: string;

  beforeEach(async () => {
    watched = temporaryDirectory();
    writeFileSync(join(watched.path, 'scan-001.txt'), INVOICE);
    writeFileSync(join(watched.path, 'scan-002.txt'), `${INVOICE}\nZweite Rechnung`);

    h = await harness();
    sourceId = body<{ id: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/ingestion/sources',
        payload: {
          name: 'Scanner drop',
          sourceKind: 'scanner',
          // No stability delay: the fixture files are already written and this is a test, not a
          // scanner still spooling a page.
          config: { kind: 'folder', root: watched.path, minimumAgeMillis: 0 },
        },
      }),
    ).id;
  });

  afterEach(async () => {
    await h.close();
    watched.remove();
  });

  /** Poll the queue until the job leaves `queued`/`running`, or the deadline passes. */
  const settle = async (jobId: string, timeoutMs = 15_000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = body<{ job: Record<string, unknown> }>(
        await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/queue/${jobId}` }),
      ).job;
      if (job.state !== 'queued' && job.state !== 'running') return job;
      if (Date.now() > deadline) throw new Error(`job ${jobId} is still ${String(job.state)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('polls the folder, runs the pipeline and records both jobs', async () => {
    const accepted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/sources/${sourceId}/run`,
      payload: { runLabel: 'first-pass' },
    });
    expect(accepted.statusCode).toBe(202);

    const started = body<{ jobId: string; runLabel: string }>(accepted);
    expect(started.runLabel).toBe('first-pass');
    expect(accepted.headers['location']).toBe(`/api/v1/ingestion/queue/${started.jobId}`);

    const job = await settle(started.jobId);
    // Two text files, no OCR and no resolvers: both reach the gate and both are queued (P3).
    expect(job.state).toBe('waiting_review');

    const result = job.result as { offered: number; pipelineJobId: string; counts: { review: number } };
    expect(result.offered).toBe(2);
    expect(result.counts.review).toBe(2);

    // The pipeline's own run is this job's child (§6.3), and the trace is read through the parent.
    const detail = body<{
      stages: { candidateKey: string; stage: string }[];
      log: { message: string }[];
      reviewEntryIds: string[];
    }>(await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/queue/${started.jobId}` }));

    expect(new Set(detail.stages.map((stage) => stage.candidateKey)).size).toBe(2);
    expect(detail.log.length).toBeGreaterThan(0);
    expect(detail.reviewEntryIds).toHaveLength(2);

    const child = h.recueil.connection
      .prepare(`select id, job_type from jobs where parent_job_id = ?`)
      .all(started.jobId) as { id: string; job_type: string }[];
    expect(child).toHaveLength(1);
    expect(child[0]?.job_type).toBe('ingest.run');

    // The queue lists both, and the source records what it last did.
    const listed = body<{ data: { id: string }[] }>(
      await h.app.inject({ method: 'GET', url: '/api/v1/ingestion/queue' }),
    );
    expect(listed.data.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([started.jobId, child[0]?.id ?? '']),
    );

    const source = body<{ lastRunJobId: string; lastError: string | null }>(
      await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/sources/${sourceId}` }),
    );
    expect(source.lastRunJobId).toBe(started.jobId);
    expect(source.lastError).toBeNull();

    // Nothing was consumed: the default policy leaves the originals where they are.
    const stillThere = body<{ ok: boolean; checks: { detail: string }[] }>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/ingestion/sources/${sourceId}/test-connection`,
      }),
    );
    expect(stillThere.checks[2]?.detail).toContain('2 entr');
  }, 30_000);

  it('resumes under the same label when the run is retried', async () => {
    const first = body<{ jobId: string }>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/ingestion/sources/${sourceId}/run`,
        payload: { runLabel: 'nightly' },
      }),
    );
    await settle(first.jobId);

    const retried = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/queue/${first.jobId}/retry`,
      payload: { reason: 'the operator wanted another pass' },
    });
    expect(retried.statusCode).toBe(202);

    // The same row, not a second one: the key is built from the source and the label (IK1), which
    // is what makes a retry a resume rather than a duplicate scan.
    const again = body<{ id: string; attempts: number }>(retried);
    expect(again.id).toBe(first.jobId);
    expect(again.attempts).toBe(2);

    await settle(first.jobId);

    // Still one document per file: re-running found the bytes at stage 2.
    const documents = h.recueil.connection
      .prepare('select count(*) as n from documents')
      .get() as { n: number };
    expect(documents.n).toBe(2);

    const audit = h.recueil.connection
      .prepare(`select count(*) as n from audit_log where action = 'job.retry_requested'`)
      .get() as { n: number };
    expect(audit.n).toBe(1);
  }, 45_000);

  it('shows the trace of every pass, not the first one, after a retry', async () => {
    const first = body<{ jobId: string }>(
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/ingestion/sources/${sourceId}/run`,
        payload: { runLabel: 'nightly' },
      }),
    );
    await settle(first.jobId);

    // A third scan lands between the passes, so the retried poll has something to offer and mints
    // a second pipeline run rather than returning empty-handed.
    writeFileSync(join(watched.path, 'scan-003.txt'), `${INVOICE}\nDritte Rechnung`);

    const retried = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/queue/${first.jobId}/retry`,
    });
    expect(retried.statusCode).toBe(202);
    await settle(first.jobId);

    // Two polls under one source job, so two pipeline runs beneath it. Read from the table rather
    // than from the response, so the premise of the assertion below is itself checked.
    const children = h.recueil.connection
      .prepare('select id from jobs where parent_job_id = ? order by id')
      .all(first.jobId) as { id: string }[];
    expect(children.length).toBe(2);

    const detail = body<{ stages: { jobId: string; stage: string }[] }>(
      await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/queue/${first.jobId}` }),
    );

    // The trace names both runs. Taking the earliest child alone would answer a question about the
    // job as it stands with the pass before last.
    const traced = new Set(detail.stages.map((stage) => stage.jobId));
    for (const child of children) {
      expect([...traced], `no stage rows for run ${child.id}`).toContain(child.id);
    }
  }, 60_000);

  it('refuses a second run of the same source under the same label while one is in flight', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/sources/${sourceId}/run`,
      payload: { runLabel: 'clash' },
    });
    expect(first.statusCode).toBe(202);

    const second = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/sources/${sourceId}/run`,
      payload: { runLabel: 'clash' },
    });
    expect(second.statusCode).toBe(409);

    await settle(body<{ jobId: string }>(first).jobId);
  }, 30_000);
});

describe('/api/v1/ingestion/review', () => {
  let h: Harness;
  let entryId: string;
  let documentId: string;

  beforeEach(async () => {
    h = await harness();
    const { result } = await upload(h, INVOICE);
    entryId = result.reviewEntry?.id ?? '';
    documentId = result.document?.id ?? '';
  });

  afterEach(async () => {
    await h.close();
  });

  it('lists open entries with their reason and their proposal', async () => {
    const listed = body<{
      data: {
        id: string;
        reasonCode: string;
        explanation: string;
        proposedAction: string;
        proposedPayload: { itemType: string };
        confidence: number | null;
      }[];
    }>(await h.app.inject({ method: 'GET', url: '/api/v1/ingestion/review' }));

    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]?.id).toBe(entryId);
    expect(listed.data[0]?.reasonCode).toBe('low_confidence_metadata');
    expect(listed.data[0]?.explanation.length).toBeGreaterThan(10);
    expect(listed.data[0]?.proposedAction).toBe('create_item');
    expect(listed.data[0]?.proposedPayload.itemType).toBeTypeOf('string');
    expect(listed.data[0]?.confidence).toBeLessThan(0.75);
  });

  it('accepts an entry, creating the item and resolving it in one transaction', async () => {
    const before = h.recueil.connection.prepare('select count(*) as n from items').get() as { n: number };

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/review/${entryId}/accept`,
      payload: { note: 'checked against the paper' },
    });
    expect(response.statusCode).toBe(200);

    const result = body<{
      entry: { status: string; resolutionNote: string; resolutionPayload: { action: string } };
      itemId: string;
      attachmentId: string;
    }>(response);

    expect(result.entry.status).toBe('accepted');
    expect(result.entry.resolutionNote).toBe('checked against the paper');
    expect(result.entry.resolutionPayload.action).toBe('create_item');
    expect(result.itemId).toBeTypeOf('string');

    const after = h.recueil.connection.prepare('select count(*) as n from items').get() as { n: number };
    expect(after.n).toBe(before.n + 1);

    // The item really holds the document, which is the point of accepting.
    const attachments = body<{ data: { documentId: string }[] }>(
      await h.app.inject({ method: 'GET', url: `/api/v1/items/${result.itemId}/attachments` }),
    );
    expect(attachments.data.map((attachment) => attachment.documentId)).toContain(documentId);

    // And it is audited like any other write (RQ1).
    const audit = h.recueil.connection
      .prepare(`select count(*) as n from audit_log where action = 'review_queue.accepted'`)
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it('applies edits and records what was actually executed', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/review/${entryId}/accept`,
      payload: {
        note: 'the extractor got the correspondent wrong',
        edits: {
          itemType: 'invoice',
          fields: { 'office.correspondent': 'Stadtwerke Ulm', 'office.referenceNumber': '2026-0042' },
          tags: ['utilities'],
        },
      },
    });
    expect(response.statusCode).toBe(200);

    const result = body<{
      itemId: string;
      entry: { resolutionPayload: { itemType: string; fields: Record<string, unknown> } };
    }>(response);

    const item = body<{ itemType: string; office: { correspondent: string; referenceNumber: string } }>(
      await h.app.inject({ method: 'GET', url: `/api/v1/items/${result.itemId}` }),
    );
    expect(item.itemType).toBe('invoice');
    expect(item.office.correspondent).toBe('Stadtwerke Ulm');
    expect(item.office.referenceNumber).toBe('2026-0042');

    // `resolution_payload` is what ran, which is not what was proposed — that difference is the
    // most interesting thing in the queue (§6.1).
    expect(result.entry.resolutionPayload.itemType).toBe('invoice');
    expect(result.entry.resolutionPayload.fields['office.correspondent']).toBe('Stadtwerke Ulm');
  });

  it('leaves the entry open and creates nothing when the commit is refused', async () => {
    // Another live item already holds ASN 4711.
    const holder = await h.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      payload: {
        itemType: 'invoice',
        title: 'The invoice that is already filed as 4711',
        office: { correspondent: 'Somebody Else', asn: 4711 },
      },
    });
    expect(holder.statusCode).toBe(201);

    const before = h.recueil.connection.prepare('select count(*) as n from items').get() as { n: number };

    const refused = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/review/${entryId}/accept`,
      payload: { edits: { fields: { 'office.correspondent': 'Stadtwerke Ulm', 'office.asn': 4711 } } },
    });
    expect(refused.statusCode).toBe(409);

    // Nothing was created, and the entry is still waiting for a person. This is the transaction
    // doing its job: the alternative is a library holding an item whose entry says nobody looked.
    const after = h.recueil.connection.prepare('select count(*) as n from items').get() as { n: number };
    expect(after.n).toBe(before.n);

    const entry = body<{ status: string; resolvedAt: string | null }>(
      await h.app.inject({ method: 'GET', url: `/api/v1/ingestion/review/${entryId}` }),
    );
    expect(entry.status).toBe('open');
    expect(entry.resolvedAt).toBeNull();

    const audit = h.recueil.connection
      .prepare(`select count(*) as n from audit_log where action = 'review_queue.accepted'`)
      .get() as { n: number };
    expect(audit.n).toBe(0);
  });

  it('refuses to accept the same entry twice', async () => {
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `/api/v1/ingestion/review/${entryId}/accept`,
        })
      ).statusCode,
    ).toBe(200);

    const again = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/review/${entryId}/accept`,
    });
    expect(again.statusCode).toBe(409);
    expect(body<{ detail: string }>(again).detail).toMatch(/already accepted/iu);
  });

  it('rejects an entry without creating anything', async () => {
    const before = h.recueil.connection.prepare('select count(*) as n from items').get() as { n: number };

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/v1/ingestion/review/${entryId}/reject`,
      payload: { note: 'a duplicate of the paper already filed' },
    });
    expect(response.statusCode).toBe(200);
    expect(body<{ status: string; resolutionNote: string }>(response)).toMatchObject({
      status: 'rejected',
      resolutionNote: 'a duplicate of the paper already filed',
    });

    const after = h.recueil.connection.prepare('select count(*) as n from items').get() as { n: number };
    expect(after.n).toBe(before.n);

    // The document stays: it was ingested before the gate ran, and P5 does not delete.
    expect(
      (await h.app.inject({ method: 'GET', url: `/api/v1/documents/${documentId}` })).statusCode,
    ).toBe(200);
  });

  it('accepts in bulk and names every refusal', async () => {
    const second = await upload(h, `${INVOICE}\nZweite Seite`);
    const secondId = second.result.reviewEntry?.id ?? '';
    expect(secondId).not.toBe('');

    // One id that is not an entry at all, so the refusal path is exercised alongside the happy one.
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/ingestion/review/accept',
      payload: { ids: [entryId, secondId, '01JZZZZZZZZZZZZZZZZZZZZZZZ'], note: 'batch review' },
    });
    expect(response.statusCode).toBe(200);

    const result = body<{
      accepted: { entry: { id: string }; itemId: string }[];
      refused: { id: string; code: string; detail: string }[];
    }>(response);

    expect(result.accepted.map((entry) => entry.entry.id).sort()).toEqual([entryId, secondId].sort());
    expect(result.accepted.every((entry) => typeof entry.itemId === 'string')).toBe(true);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.code).toBe('not_found');

    // Both really landed: one refusal did not roll the others back.
    const open = body<{ data: unknown[] }>(
      await h.app.inject({ method: 'GET', url: '/api/v1/ingestion/review?status=open' }),
    );
    expect(open.data).toHaveLength(0);
  });
});

/* ============================================================================================== */
/* The ingestion lifecycle on the event stream                                                      */
/* ============================================================================================== */

describe('the ingestion lifecycle events', () => {
  let h: Harness;
  let origin: string;

  beforeEach(async () => {
    h = await harness();
    origin = await listen(h);
  });

  afterEach(async () => {
    await h.close();
  });

  it('streams job.started, document.ingested and job.finished for an upload', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${origin}/api/v1/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);

    const frames = readSseFrames(stream, 3);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const form = new FormData();
    form.set('file', new Blob([INVOICE], { type: 'text/plain' }), 'invoice.txt');
    const uploaded = await fetch(`${origin}/api/v1/ingestion/upload`, { method: 'POST', body: form });
    expect(uploaded.status).toBe(200);
    const result = (await uploaded.json()) as UploadResult;

    const received = await frames;
    controller.abort();

    const types = received.map((frame) => frame.event);
    expect(types).toContain('document.ingested');
    expect(types).toContain('job.started');
    expect(types).toContain('job.finished');

    const ingested = received.find((frame) => frame.event === 'document.ingested');
    const payload = ingested?.data.payload as Record<string, unknown>;
    expect(payload.documentId).toBe(result.document?.id);
    expect(payload.sha256).toBe(result.document?.sha256);
    // §7.3: the entry the gate raised is named on the event, which is why the catalogue needs no
    // `ingest.review_queued` of its own.
    expect(payload.reviewQueueEntryId).toBe(result.reviewEntry?.id);
    expect(payload.pipelineRunId).toBe(result.jobId);
    // And the stage list is what really ran: no OCR worker exists in this process.
    expect(payload.stagesRun as string[]).not.toContain('ocr');

    const finished = received.find((frame) => frame.event === 'job.finished');
    expect((finished?.data.payload as Record<string, unknown>).jobId).toBe(result.jobId);
  });
});
