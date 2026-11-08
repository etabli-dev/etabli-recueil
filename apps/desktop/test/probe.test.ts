/**
 * The connection probe and what the page says about each outcome.
 *
 * The fake stands at the `fetch` boundary and reproduces what a web view does: a cross-origin
 * request the server does not allow rejects with a bare `TypeError`, exactly as a request to a port
 * nobody listens on does, while an opaque `no-cors` request succeeds whenever something answered.
 */
import { describe, expect, it } from 'vitest';

import { diagnose, localServerCommand, shellOrigin } from '../shell/diagnosis.js';
import { isRecueilHealth, probeServer } from '../shell/probe.js';
import type { FetchLike } from '../shell/probe.js';

const BASE = 'http://127.0.0.1:3000';
const ORIGIN = 'tauri://localhost';

const health = (status: 'ok' | 'degraded' | 'error' = 'ok') => ({
  status,
  name: 'recueil',
  version: '0.1.0',
  apiVersion: 'v1',
  checkedAt: '2026-11-08T12:00:00.000Z',
  startedAt: '2026-11-08T11:00:00.000Z',
  uptimeSeconds: 3600,
  mode: 'server',
  components: [],
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Seen {
  url: string;
  mode: RequestMode | undefined;
  authorization: string | null;
}

interface FakeServer {
  /** Nothing listening: every request rejects. */
  listening?: boolean;
  /** The server answers, but not with CORS headers for this origin. */
  allowsOrigin?: boolean;
  health?: () => Response;
  items?: (authorization: string | null) => Response;
}

const fakeServer = (server: FakeServer): { fetch: FetchLike; seen: Seen[] } => {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    const authorization = new Headers(init?.headers).get('authorization');
    seen.push({ url, mode: init?.mode, authorization });
    if (server.listening === false) throw new TypeError('Load failed');
    if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
    if (server.allowsOrigin === false) throw new TypeError('Load failed');
    if (url.endsWith('/health')) return (server.health ?? (() => json(health())))();
    if (url.includes('/api/v1/items')) return (server.items ?? (() => json({ data: [], page: {} })))(authorization);
    return new Response('not found', { status: 404 });
  };
  return { fetch, seen };
};

describe('the connection probe', () => {
  it('connects to a healthy server that allows this origin, with one health and one item request', async () => {
    const { fetch, seen } = fakeServer({});
    await expect(probeServer(BASE, { fetch })).resolves.toEqual({ kind: 'connected', version: '0.1.0', status: 'ok' });
    expect(seen.map((request) => request.url)).toEqual([`${BASE}/health`, `${BASE}/api/v1/items?limit=1`]);
    expect(seen.every((request) => request.mode === 'cors')).toBe(true);
  });

  it('tells an absent server from one that refuses this origin', async () => {
    await expect(probeServer(BASE, { fetch: fakeServer({ listening: false }).fetch })).resolves.toEqual({
      kind: 'unreachable',
    });

    const refusing = fakeServer({ allowsOrigin: false });
    await expect(probeServer(BASE, { fetch: refusing.fetch })).resolves.toEqual({ kind: 'cors-refused' });
    expect(refusing.seen.map((request) => request.mode)).toEqual(['cors', 'no-cors']);
  });

  it('recognises something that is not Recueil, and a Recueil that reports an error', async () => {
    const nginx = fakeServer({ health: () => new Response('<html>Welcome</html>', { status: 200 }) });
    await expect(probeServer(BASE, { fetch: nginx.fetch })).resolves.toEqual({ kind: 'not-recueil', httpStatus: 200 });

    const broken = fakeServer({ health: () => json(health('error'), 503) });
    await expect(probeServer(BASE, { fetch: broken.fetch })).resolves.toEqual({ kind: 'unhealthy', version: '0.1.0' });
  });

  it('asks for a token only when the API refuses without one, and reports a refused token', async () => {
    const requiresAuth = (authorization: string | null) =>
      authorization === 'Bearer rc_good' ? json({ data: [] }) : json({ title: 'Unauthorized' }, 401);

    const anonymous = fakeServer({ items: requiresAuth });
    await expect(probeServer(BASE, { fetch: anonymous.fetch })).resolves.toEqual({ kind: 'token-required' });
    expect(anonymous.seen[1]?.authorization).toBeNull();

    const wrong = fakeServer({ items: requiresAuth });
    await expect(probeServer(BASE, { fetch: wrong.fetch, token: 'rc_bad' })).resolves.toEqual({
      kind: 'token-refused',
      httpStatus: 401,
    });

    const right = fakeServer({ items: requiresAuth });
    await expect(probeServer(BASE, { fetch: right.fetch, token: 'rc_good' })).resolves.toMatchObject({ kind: 'connected' });
    expect(right.seen[1]?.authorization).toBe('Bearer rc_good');
    // `/health` is public and is never sent the token.
    expect(right.seen[0]?.authorization).toBeNull();
  });

  it('accepts only the health document fields it relies on', () => {
    expect(isRecueilHealth(health())).toBe(true);
    expect(isRecueilHealth({ ...health(), name: 'paperless' })).toBe(false);
    expect(isRecueilHealth({ status: 'ok' })).toBe(false);
    expect(isRecueilHealth(null)).toBe(false);
  });
});

describe('what the connection page says', () => {
  it('names the exact origin the server has to allow', () => {
    expect(shellOrigin({ protocol: 'tauri:', host: 'localhost' })).toBe('tauri://localhost');
    expect(shellOrigin({ protocol: 'http:', host: 'tauri.localhost' })).toBe('http://tauri.localhost');

    const refused = diagnose({ kind: 'cors-refused' }, BASE, ORIGIN);
    expect(refused.tone).toBe('error');
    expect(refused.code).toBe('RECUEIL_CORS_ORIGIN=tauri://localhost');
    expect(refused.detail).toContain(ORIGIN);
  });

  it('explains how to start a server when none answers', () => {
    const absent = diagnose({ kind: 'unreachable' }, BASE, ORIGIN);
    expect(absent.title).toBe('No Recueil server is reachable');
    expect(absent.detail).toContain(BASE);
    expect(absent.code).toBe(localServerCommand(ORIGIN));
    expect(absent.code).toContain('RECUEIL_CORS_ORIGIN=tauri://localhost');
    expect(absent.code).toContain('serve --host 127.0.0.1 --port 3000');
  });

  it('has a message for every outcome', () => {
    const outcomes = [
      { kind: 'connected', version: '0.1.0', status: 'ok' },
      { kind: 'connected', version: '0.1.0', status: 'degraded' },
      { kind: 'unreachable' },
      { kind: 'cors-refused' },
      { kind: 'not-recueil', httpStatus: 404 },
      { kind: 'unhealthy', version: '0.1.0' },
      { kind: 'token-required' },
      { kind: 'token-refused', httpStatus: 401 },
      { kind: 'token-refused', httpStatus: 403 },
      { kind: 'api-error', httpStatus: 500 },
    ] as const;
    for (const outcome of outcomes) {
      const said = diagnose(outcome, BASE, ORIGIN);
      expect(said.title.length).toBeGreaterThan(10);
      expect(said.detail.length).toBeGreaterThan(20);
    }
    expect(diagnose(outcomes[0], BASE, ORIGIN).tone).toBe('ok');
    expect(diagnose(outcomes[1], BASE, ORIGIN).tone).toBe('warning');
  });
});
