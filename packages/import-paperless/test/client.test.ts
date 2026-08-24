/**
 * The client, against a real socket.
 *
 * Everything here goes over loopback HTTP to the fake, because the failures worth catching in an
 * HTTP client — a header parsed wrongly, a redirect followed somewhere it should not be, a
 * paginated walk that stops one page early — do not exist in a stubbed `fetch`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { PaperlessClient, apiRootOf, dispositionFilename, safeBasename } from '../src/client/client.js';
import {
  PaperlessApiVersionError,
  PaperlessAuthError,
  PaperlessProtocolError,
  PaperlessUntrustedUrlError,
  redactUrl,
} from '../src/client/errors.js';
import { FIXTURE_EXPECTATIONS } from '../src/testing/fixtures.js';
import { startFixtureServer } from './helpers.js';
import type { TestServer } from './helpers.js';

let running: TestServer | null = null;

const serve = async (options = {}): Promise<TestServer> => {
  running = await startFixtureServer(options);
  return running;
};

afterEach(async () => {
  if (running !== null) await running.close();
  running = null;
});

const clientFor = (server: TestServer, overrides: Record<string, unknown> = {}): PaperlessClient =>
  new PaperlessClient({
    baseUrl: server.baseUrl,
    token: server.token,
    pageSize: 3,
    retryDelayMs: 1,
    ...overrides,
  });

describe('apiRootOf', () => {
  it('appends /api/ and keeps the trailing slash', () => {
    expect(apiRootOf('https://p.example').toString()).toBe('https://p.example/api/');
    expect(apiRootOf('https://p.example/').toString()).toBe('https://p.example/api/');
    expect(apiRootOf('https://p.example/api').toString()).toBe('https://p.example/api/');
    expect(apiRootOf('https://p.example/api/').toString()).toBe('https://p.example/api/');
    expect(apiRootOf('https://p.example/paperless').toString()).toBe('https://p.example/paperless/api/');
  });

  it('refuses a credential in the URL', () => {
    expect(() => apiRootOf('https://user:secret@p.example')).toThrow(/token/iu);
  });

  it('refuses a scheme it does not speak', () => {
    expect(() => apiRootOf('ftp://p.example')).toThrow();
    expect(() => apiRootOf('not a url')).toThrow();
  });
});

describe('authentication', () => {
  it('sends the Token scheme, not Bearer', async () => {
    const server = await serve();
    await clientFor(server).probe();

    const first = server.server.requests[0];
    expect(first?.authorization).toBe(`Token ${server.token}`);
    expect(first?.accept).toBe('application/json; version=10');
  });

  it('raises PaperlessAuthError on a wrong token, and does not retry it', async () => {
    const server = await serve();
    const client = clientFor(server, { token: 'wrong' });

    await expect(client.probe()).rejects.toBeInstanceOf(PaperlessAuthError);
    expect(server.server.requests).toHaveLength(1);
  });

  it('never puts the token in an error message', async () => {
    const server = await serve();
    const client = clientFor(server, { token: 'super-secret-token' });

    const error = await client.probe().catch((caught: unknown) => caught);
    expect(String(error)).not.toContain('super-secret-token');
    expect(JSON.stringify((error as PaperlessAuthError).context)).not.toContain('super-secret-token');
  });
});

describe('API versioning', () => {
  it('reads the version headers the middleware sets', async () => {
    const server = await serve({ version: '3.0.5' });
    const info = await clientFor(server).probe();

    expect(info.serverVersion).toBe('3.0.5');
    expect(info.apiVersion).toBe('10');
    expect(info.requestedApiVersion).toBe('10');
    expect(info.endpoints).toContain('documents');
  });

  it('reports an absent X-Version rather than inventing one', async () => {
    const server = await serve({ suppressVersionHeaders: true });
    const info = await clientFor(server).probe();

    expect(info.serverVersion).toBeNull();
    expect(info.apiVersion).toBeNull();
  });

  it('raises PaperlessApiVersionError when the server refuses the version', async () => {
    const server = await serve({ allowedApiVersions: ['9'] });
    await expect(clientFor(server).probe()).rejects.toBeInstanceOf(PaperlessApiVersionError);
  });

  it('walks the version 9 envelope, which still carries `all`', async () => {
    const server = await serve({ allowedApiVersions: ['9'], defaultApiVersion: '9' });
    const client = clientFor(server, { apiVersion: '9' });

    const seen: number[] = [];
    for await (const page of client.documents()) seen.push(...page.documents.map((row) => row.id));
    expect(seen).toHaveLength(FIXTURE_EXPECTATIONS.documents);
  });

  it('refuses a version it has not been written against', async () => {
    const server = await serve();
    expect(() => clientFor(server, { apiVersion: '11' })).toThrow(/written against/u);
  });
});

describe('pagination', () => {
  it('walks every page, in ascending id order', async () => {
    const server = await serve();
    const client = clientFor(server);

    const ids: number[] = [];
    let pages = 0;
    let reported = 0;
    for await (const page of client.documents()) {
      pages += 1;
      reported = page.total;
      ids.push(...page.documents.map((row) => row.id));
    }

    expect(pages).toBe(4);
    expect(reported).toBe(FIXTURE_EXPECTATIONS.documents);
    expect(ids).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('asks for ordering=id on every page', async () => {
    const server = await serve();
    for await (const _page of clientFor(server).documents()) {
      /* drain */
    }
    const documentRequests = server.server.requests.filter((row) => row.url.startsWith('/api/documents/?'));
    expect(documentRequests.length).toBeGreaterThan(1);
    for (const request of documentRequests) expect(request.url).toContain('ordering=id');
  });

  it('builds its own page URLs instead of following `next`', async () => {
    const server = await serve({ linkOrigin: 'https://attacker.example' });
    const client = clientFor(server);

    // The link is off-origin, so the walk refuses rather than sending the token to the attacker.
    await expect(async () => {
      for await (const _page of client.documents()) {
        /* drain */
      }
    }).rejects.toBeInstanceOf(PaperlessUntrustedUrlError);

    // Nothing was ever requested from the other host: the only requests are to the fake.
    for (const request of server.server.requests) expect(request.url.startsWith('/api/')).toBe(true);
  });

  it('collects every record of a vocabulary list across pages', async () => {
    const server = await serve();
    const client = clientFor(server, { pageSize: 2 });

    expect(await client.listTags()).toHaveLength(FIXTURE_EXPECTATIONS.tags);
    expect(await client.listCorrespondents()).toHaveLength(FIXTURE_EXPECTATIONS.correspondents);
    expect(await client.listDocumentTypes()).toHaveLength(FIXTURE_EXPECTATIONS.documentTypes);
    expect(await client.listCustomFields()).toHaveLength(FIXTURE_EXPECTATIONS.supportedCustomFields + 1);
  });

  it('rejects a body that is not a paginated object', async () => {
    const server = await serve({
      faults: [{ path: '/api/tags/', status: 200, body: '<html>login</html>' }],
    });
    await expect(clientFor(server).listTags()).rejects.toBeInstanceOf(PaperlessProtocolError);
  });
});

describe('retries', () => {
  it('retries a 500 and succeeds', async () => {
    const server = await serve({ faults: [{ path: '/api/tags/', status: 500, times: 2 }] });
    const tags = await clientFor(server, { attempts: 4 }).listTags();

    expect(tags).toHaveLength(FIXTURE_EXPECTATIONS.tags);
    // Two refusals, then page one, then page two: four tags at a page size of three.
    expect(server.server.requests.filter((row) => row.url.startsWith('/api/tags/'))).toHaveLength(4);
  });

  it('honours Retry-After on a 429', async () => {
    const server = await serve({
      faults: [{ path: '/api/tags/', status: 429, headers: { 'retry-after': '0' }, times: 1 }],
    });
    const tags = await clientFor(server, { attempts: 3 }).listTags();
    expect(tags).toHaveLength(FIXTURE_EXPECTATIONS.tags);
  });

  it('gives up after the configured attempts', async () => {
    const server = await serve({ faults: [{ path: '/api/tags/', status: 503, times: 10 }] });
    await expect(clientFor(server, { attempts: 2 }).listTags()).rejects.toThrow(/503/u);
  });

  it('does not retry a 4xx that is not 429', async () => {
    const server = await serve({ faults: [{ path: '/api/tags/', status: 400, times: 5 }] });
    await expect(clientFor(server, { attempts: 4 }).listTags()).rejects.toThrow(/400/u);
    expect(server.server.requests.filter((row) => row.url.startsWith('/api/tags/'))).toHaveLength(1);
  });
});

describe('redirects', () => {
  it('refuses a redirect to another host', async () => {
    const server = await serve({
      faults: [
        {
          path: '/api/tags/',
          status: 302,
          headers: { location: 'https://attacker.example/api/tags/' },
          times: 1,
        },
      ],
    });
    await expect(clientFor(server).listTags()).rejects.toBeInstanceOf(PaperlessUntrustedUrlError);
  });

  it('follows a redirect within the same server', async () => {
    const server = await serve();
    server.server.fail({
      path: '/api/tags/?page=1',
      status: 302,
      headers: { location: '/api/tags/?page=1&page_size=100&ordering=id&redirected=1' },
      times: 1,
    });
    const tags = await clientFor(server, { pageSize: 100 }).listTags();
    expect(tags).toHaveLength(FIXTURE_EXPECTATIONS.tags);
  });
});

describe('downloading originals', () => {
  it('always asks for the original, never the archive', async () => {
    const server = await serve();
    await clientFor(server).downloadOriginal(1);

    const download = server.server.requests.find((row) => row.url.includes('/download/'));
    expect(download?.url).toContain('original=true');
  });

  it('reduces a hostile Content-Disposition filename to a basename', async () => {
    const server = await serve();
    const file = await clientFor(server).downloadOriginal(3);

    expect(file.filename).toBe('passwd');
    expect(file.bytes.length).toBeGreaterThan(0);
    expect(file.contentType).toBe('image/png');
  });

  it('raises PaperlessNotFoundError for a document whose file is gone', async () => {
    const server = await serve();
    await expect(clientFor(server).downloadOriginal(5)).rejects.toThrow(/404/u);
  });

  it('reads the metadata endpoint, checksum and all', async () => {
    const server = await serve();
    const metadata = await clientFor(server).documentMetadata(1);

    expect(metadata.original_checksum).toMatch(/^[0-9a-f]{32}$/u);
    expect(metadata.original_size).toBeGreaterThan(0);
  });

  it('refuses an id that is not one', async () => {
    const server = await serve();
    await expect(clientFor(server).documentMetadata(-1)).rejects.toThrow(/object id/u);
    await expect(clientFor(server).documentMetadata(1.5)).rejects.toThrow(/object id/u);
  });
});

describe('filename hygiene', () => {
  it('strips directories, traversal and control characters', () => {
    expect(safeBasename('../../etc/passwd')).toBe('passwd');
    expect(safeBasename('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
    expect(safeBasename('..')).toBeNull();
    expect(safeBasename('/')).toBeNull();
    expect(safeBasename('a\u0000b.pdf')).toBe('ab.pdf');
  });

  it('reads both Content-Disposition filename forms', () => {
    expect(dispositionFilename('attachment; filename="Rechnung 2024.pdf"')).toBe('Rechnung 2024.pdf');
    expect(dispositionFilename("attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf")).toBe(
      'Rechnung März.pdf',
    );
    expect(dispositionFilename('attachment; filename=plain.pdf')).toBe('plain.pdf');
    expect(dispositionFilename(null)).toBeNull();
    expect(dispositionFilename('attachment')).toBeNull();
  });
});

describe('redactUrl', () => {
  it('removes userinfo and anything credential-shaped', () => {
    expect(redactUrl('https://u:p@host/api/?token=abc&page=1')).toBe(
      'https://host/api/?token=REDACTED&page=1',
    );
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
