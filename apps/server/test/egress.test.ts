/**
 * `EgressGuard`: the address rule, and the client that enforces it.
 *
 * Two things are being proved here and they are different in kind. The first is the rule itself —
 * which addresses are refused — and that is a table, because the interesting cases are the ones
 * nobody writes by hand: `127.1`, `::ffff:127.0.0.1`, a 6to4 address tunnelling to 10/8.
 *
 * The second is that the client the guard substitutes for `fetch` is a faithful one. Node's global
 * `fetch` is undici's, and undici's dispatcher — the only place a `lookup` can be installed — is
 * not reachable from the standard library, so the guard speaks `node:http` directly. That is a
 * replacement for the transport every WebDAV request in this application goes over, and a
 * replacement is only safe if it is checked against a real server: the tests below run real
 * requests, with real bodies and real headers, over a real socket on loopback.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EgressBlockedError, EgressGuard, addressRange } from '../src/ingestion/egress.js';

describe('addressRange', () => {
  it('names the range of every address a source must not reach', () => {
    for (const [address, expected] of [
      ['127.0.0.1', /loopback/u],
      ['127.1.2.3', /loopback/u],
      ['0.0.0.0', /unspecified/u],
      ['10.1.2.3', /private/u],
      ['172.16.0.1', /private/u],
      ['172.31.255.255', /private/u],
      ['192.168.1.4', /private/u],
      ['169.254.169.254', /link-local/u],
      ['100.64.0.1', /carrier-grade NAT/u],
      ['198.18.0.1', /benchmarking/u],
      ['203.0.113.9', /documentation/u],
      ['224.0.0.1', /multicast/u],
      ['255.255.255.255', /reserved/u],
      ['::1', /loopback/u],
      ['::', /unspecified/u],
      ['fe80::1', /link-local/u],
      ['fd00::1', /unique-local/u],
      ['ff02::1', /multicast/u],
      ['2001:db8::1', /documentation/u],
      // The same forbidden address, wearing a different notation each time.
      ['::ffff:127.0.0.1', /loopback/u],
      ['::ffff:10.0.0.1', /private/u],
      ['64:ff9b::7f00:1', /loopback/u],
      ['2002:0a00:0001::', /private/u],
    ] as const) {
      expect(`${address}: ${String(addressRange(address))}`).toMatch(expected);
    }
  });

  it('passes an ordinary public address', () => {
    expect(addressRange('93.184.216.34')).toBeNull();
    expect(addressRange('2606:2800:220:1:248:1893:25c8:1946')).toBeNull();
    expect(addressRange('172.32.0.1')).toBeNull(); // just past the private block
    expect(addressRange('172.15.255.255')).toBeNull(); // just before it
    expect(addressRange('100.128.0.1')).toBeNull(); // just past the CGNAT block
  });

  it('treats anything it cannot parse as unroutable rather than as permitted', () => {
    expect(addressRange('not-an-address')).toBe('unparseable');
    expect(addressRange('1.2.3')).toBe('unparseable');
    expect(addressRange('999.1.1.1')).toBe('unparseable');
  });
});

/* -------------------------------------------------------------------------------------------- */

interface Echo {
  readonly origin: string;
  readonly seen: { method: string; url: string; body: string; headers: Record<string, unknown> }[];
  respond: (request: IncomingMessage, response: ServerResponse, body: string) => void;
  close(): Promise<void>;
}

const startEcho = async (): Promise<Echo> => {
  const seen: Echo['seen'] = [];
  const state: { respond: Echo['respond'] } = {
    respond: (request, response, requestBody) => {
      const payload = JSON.stringify({ method: request.method, body: requestBody });
      response.writeHead(200, { 'content-type': 'application/json', dav: '1,2', allow: 'GET,PROPFIND' });
      response.end(payload);
    },
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const requestBody = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: request.method ?? '?',
        url: request.url ?? '?',
        body: requestBody,
        headers: request.headers as unknown as Record<string, unknown>,
      });
      state.respond(request, response, requestBody);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    seen,
    set respond(value: Echo['respond']) {
      state.respond = value;
    },
    get respond(): Echo['respond'] {
      return state.respond;
    },
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};

describe("the guard's fetch, over a real socket", () => {
  let echo: Echo;
  let guard: EgressGuard;

  beforeEach(async () => {
    echo = await startEcho();
    // Loopback is the target on purpose, so the opt-in is what makes these requests legal — the
    // same opt-in an operator sets for a NAS.
    guard = new EgressGuard({ allowPrivateTargets: true });
  });

  afterEach(async () => {
    await echo.close();
  });

  it('carries the method, the path, the headers and the body, and reads the answer back', async () => {
    const response = await guard.fetch(`${echo.origin}/dav/inbox/`, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop/></d:propfind>',
      redirect: 'manual',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('dav')).toBe('1,2');
    expect(await response.json()).toEqual({
      method: 'PROPFIND',
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop/></d:propfind>',
    });

    const sent = echo.seen[0];
    expect(sent?.method).toBe('PROPFIND');
    expect(sent?.url).toBe('/dav/inbox/');
    expect(sent?.headers['depth']).toBe('1');
  });

  it('reads bytes back exactly, which is what a document download is', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe, 0x0a]);
    echo.respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end(bytes);
    };
    const response = await guard.fetch(`${echo.origin}/dav/a.pdf`);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('answers a HEAD with the headers and no body', async () => {
    echo.respond = (_request, response) => {
      response.writeHead(200, { etag: '"abc"', 'content-length': '4096' });
      response.end();
    };
    const response = await guard.fetch(`${echo.origin}/dav/a.pdf`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"abc"');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('reports a 404 and a 412 as statuses rather than throwing', async () => {
    for (const status of [404, 412, 500]) {
      echo.respond = (_request, response) => {
        response.writeHead(status);
        response.end('nope');
      };
      const response = await guard.fetch(`${echo.origin}/dav/gone`, { method: 'DELETE' });
      expect(response.status).toBe(status);
    }
  });

  it('does not follow a redirect, so a 302 to somewhere internal is the caller\'s problem', async () => {
    echo.respond = (_request, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
    };
    const response = await guard.fetch(`${echo.origin}/dav/`);
    expect(response.status).toBe(302);
    // One request, to the address that was checked. The redirect was not chased.
    expect(echo.seen).toHaveLength(1);
  });

  it('reads a gzipped answer under an explicit ceiling (ADR-0022)', async () => {
    echo.respond = (_request, response) => {
      const payload = gzipSync(Buffer.from('x'.repeat(100_000), 'utf8'));
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.end(payload);
    };
    const generous = new EgressGuard({ allowPrivateTargets: true, maxResponseBytes: 1_000_000 });
    expect((await (await generous.fetch(`${echo.origin}/dav/`)).text()).length).toBe(100_000);

    // The same answer against a ceiling it does not fit under. The wire body is a few hundred
    // bytes, so nothing the stream counted would have caught it: `maxOutputLength` on the inflate
    // is what refuses, before the 100 kB buffer exists at all.
    const tight = new EgressGuard({ allowPrivateTargets: true, maxResponseBytes: 4096 });
    await expect(tight.fetch(`${echo.origin}/dav/`)).rejects.toThrow(/4096/u);
  });

  it('stops reading an oversized answer rather than buffering it (ADR-0022)', async () => {
    echo.respond = (_request, response) => {
      response.writeHead(200);
      // Written in chunks, so the abort can happen part way through rather than after the fact.
      for (let index = 0; index < 200; index += 1) response.write('y'.repeat(4096));
      response.end();
    };
    const tight = new EgressGuard({ allowPrivateTargets: true, maxResponseBytes: 8192 });
    await expect(tight.fetch(`${echo.origin}/dav/`)).rejects.toThrow(/8192/u);
  });
});

describe('the guard refuses, by default', () => {
  it('refuses to fetch loopback at all', async () => {
    const guard = new EgressGuard();
    await expect(guard.fetch('http://127.0.0.1:1/dav/')).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(guard.fetch('http://[::1]:1/dav/')).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('refuses a scheme that is not http or https', async () => {
    const guard = new EgressGuard({ allowPrivateTargets: true });
    await expect(guard.fetch('file:///etc/passwd')).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('checks the address the request actually carries, not the one it was configured with', async () => {
    // The guarded fetch is handed to a client that builds its own request URLs from a base. A
    // client walked onto a different host by a hostile `href` is refused here as well.
    const guard = new EgressGuard({
      resolve: async () => [{ address: '10.0.0.1', family: 4 }],
    });
    await expect(guard.fetch('http://share.example/dav/')).rejects.toThrow(/private/u);
  });

  it('lets an ordinary public name through the address check', async () => {
    const guard = new EgressGuard({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      // The address check passes and the request is then made by this, so the test does not need
      // to reach the internet to prove the check did not refuse.
      fetch: async () => new Response('ok', { status: 200 }),
    });
    expect((await guard.fetch('http://share.example/dav/')).status).toBe(200);
  });

  it('refuses when any one of several answers is internal', async () => {
    // A name with two A records, one of them loopback: taking the first would admit it half the
    // time, which is a rule an attacker can simply retry against.
    const guard = new EgressGuard({
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      fetch: async () => new Response('ok', { status: 200 }),
    });
    await expect(guard.fetch('http://share.example/dav/')).rejects.toThrow(/loopback/u);
  });
});

describe('checkAtConfigTime', () => {
  it('refuses an internal address and names the range', async () => {
    const guard = new EgressGuard();
    await expect(guard.checkAtConfigTime('http://127.0.0.1/dav/', 'config.url')).rejects.toThrow(
      /loopback/u,
    );
  });

  it('does not refuse a name that simply will not resolve today', async () => {
    // A NAS whose DNS is down is an ordinary thing to be configuring. The connection is where
    // admission is decided, so this must not become the place a legitimate source is refused.
    const guard = new EgressGuard({
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    const url = await guard.checkAtConfigTime('http://nas.local/dav/', 'config.url');
    expect(url.hostname).toBe('nas.local');
  });

  it('refuses a scheme that is not http or https', async () => {
    const guard = new EgressGuard();
    await expect(guard.checkAtConfigTime('ftp://example.com/dav/', 'config.url')).rejects.toThrow(
      /http or https/u,
    );
  });
});
