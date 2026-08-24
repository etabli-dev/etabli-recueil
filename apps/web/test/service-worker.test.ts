/**
 * @vitest-environment node
 */

/**
 * The service worker's routing table and its share stash.
 *
 * The assertion that matters most is a negative one: the worker must never answer, and never cache,
 * a request to `/api` or `/health`. A document manager whose item list can come out of a week-old
 * cache is lying about the library, and it would do it invisibly.
 *
 * The rest is the share target, which is the feature the worker exists for (CONCEPT.md §7, Phase 2).
 *
 * This file runs in Node's environment rather than jsdom's, and deliberately. A service worker has
 * no DOM: it has `Request`, `Response`, `FormData`, `File`, `Blob` and the Cache API. jsdom supplies
 * its own `FormData` and `File`, which Node's `Response` does not recognise — so a multipart body
 * built in jsdom arrives at `formData()` as the string "[object FormData]". Node's set is the one
 * that behaves like a worker's.
 */
import { describe, expect, it } from 'vitest';

import {
  SHELL_CACHE,
  SHELL_ENTRY,
  handleFetch,
  handleShareTarget,
  isDataPath,
  isImmutableAsset,
  stashShare,
  sweepShares,
} from '../src/pwa/service-worker.js';
import {
  SHARE_CACHE,
  SHARE_FILENAME_HEADER,
  SHARE_STASHED_AT_HEADER,
  newShareId,
  parseShareKey,
  safeShareFilename,
  shareKey,
} from '../src/pwa/share-protocol.js';
import { readShare, clearShare } from '../src/pwa/share-store.js';
import { FakeCache, FakeCacheStorage, asCache, asCacheStorage } from './fake-cache.js';

const ORIGIN = 'https://recueil.test';
const NOW = new Date('2026-08-22T09:15:00.000Z');

/** Deterministic, so the redirect URL is assertable. */
const fixedCrypto = { getRandomValues: <T extends ArrayBufferView>(array: T): T => {
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xab);
  return array;
} };

describe('the share key', () => {
  it('is built from a checked identifier, never from anything received', () => {
    expect(shareKey('ab'.repeat(8), 0)).toBe(`/__recueil-share__/${'ab'.repeat(8)}/0`);
    expect(() => shareKey('../../etc/passwd', 0)).toThrow();
    expect(() => shareKey('ab'.repeat(8), -1)).toThrow();
    expect(() => shareKey('ab'.repeat(8), 1.5)).toThrow();
  });

  it('recognises only its own keys, so the sweep cannot delete anything else', () => {
    expect(parseShareKey(`${ORIGIN}/__recueil-share__/${'ab'.repeat(8)}/2`)).toEqual({ id: 'ab'.repeat(8), index: 2 });
    expect(parseShareKey(`${ORIGIN}/assets/index-abc.js`)).toBeNull();
  });

  it('produces a fresh identifier of the shape the key pattern demands', () => {
    expect(newShareId(crypto)).toMatch(/^[0-9a-f]{32}$/u);
  });
});

describe('safeShareFilename', () => {
  it('keeps an ordinary name', () => {
    expect(safeShareFilename('Rechnung 2026-114.pdf', 'fallback')).toBe('Rechnung 2026-114.pdf');
  });

  it('strips a path, so a traversal never reaches the multipart part', () => {
    expect(safeShareFilename('../../etc/passwd', 'fallback')).toBe('passwd');
    expect(safeShareFilename('C:\\Windows\\system32\\config', 'fallback')).toBe('config');
  });

  it('refuses a name that is only dots or only control characters', () => {
    expect(safeShareFilename('..', 'fallback')).toBe('fallback');
    expect(safeShareFilename('\u0000\u0001', 'fallback')).toBe('fallback');
  });

  it('falls back when there is no name at all', () => {
    expect(safeShareFilename(null, 'fallback')).toBe('fallback');
  });
});

/** A navigation request. `new Request(url, { mode: 'navigate' })` is refused outside a browser. */
const navigation = (path: string): Request =>
  ({ url: `${ORIGIN}${path}`, method: 'GET', mode: 'navigate' }) as unknown as Request;

describe('the routing table', () => {
  const context = {
    caches: asCacheStorage(new FakeCacheStorage()),
    // Never reached by the assertions in this block, and a stub rather than the real `fetch` so
    // that a mistake in one shows up as a failed assertion and not as a DNS lookup.
    fetch: async () => new Response('the network was not supposed to be asked'),
    origin: ORIGIN,
  };

  it('names the data paths it must never touch', () => {
    expect(isDataPath('/api/v1/items')).toBe(true);
    expect(isDataPath('/health')).toBe(true);
    expect(isDataPath('/assets/index.js')).toBe(false);
  });

  it('declines every API request, so a stale library can never be served from a cache', () => {
    for (const path of ['/api/v1/items', '/api/v1/review-queue', '/health']) {
      expect(handleFetch(new Request(`${ORIGIN}${path}`), context)).toBeNull();
    }
  });

  it('declines a request to another origin', () => {
    expect(handleFetch(new Request('https://elsewhere.test/assets/x.js'), context)).toBeNull();
  });

  it('declines anything that is not a GET', () => {
    expect(handleFetch(new Request(`${ORIGIN}/assets/x.js`, { method: 'POST' }), context)).toBeNull();
  });

  it('takes the content-hashed build output', () => {
    expect(isImmutableAsset('/assets/index-abc123.js')).toBe(true);
    expect(isImmutableAsset('/icons/icon-192.png')).toBe(true);
    expect(isImmutableAsset('/manifest.webmanifest')).toBe(true);
    expect(handleFetch(new Request(`${ORIGIN}/assets/index-abc123.js`), context)).not.toBeNull();
  });

  it('serves a content-hashed asset out of the cache without asking the network', async () => {
    const storage = new FakeCacheStorage();
    const shell = await storage.open(SHELL_CACHE);
    await shell.put(`${ORIGIN}/assets/index-abc123.js`, new Response('cached bytes'));

    let networkCalls = 0;
    const response = await handleFetch(new Request(`${ORIGIN}/assets/index-abc123.js`), {
      caches: asCacheStorage(storage),
      fetch: async () => {
        networkCalls += 1;
        return new Response('from the network');
      },
      origin: ORIGIN,
    })!;

    expect(await response.text()).toBe('cached bytes');
    expect(networkCalls).toBe(0);
  });

  it('serves a navigation from the network and keeps the shell for when there is none', async () => {
    const storage = new FakeCacheStorage();
    const request = navigation('/review');

    const live = await handleFetch(request, {
      caches: asCacheStorage(storage),
      fetch: async () => new Response('<!doctype html>fresh', { status: 200 }),
      origin: ORIGIN,
    })!;
    expect(await live.text()).toBe('<!doctype html>fresh');

    const offline = await handleFetch(request, {
      caches: asCacheStorage(storage),
      fetch: async () => {
        throw new TypeError('offline');
      },
      origin: ORIGIN,
    })!;
    expect(await offline.text()).toBe('<!doctype html>fresh');
    expect((await storage.open(SHELL_CACHE)).entries.has(`${ORIGIN}${SHELL_ENTRY}`)).toBe(true);
  });
});

describe('the share target', () => {
  const shareForm = (): FormData => {
    const form = new FormData();
    form.append('title', 'Rechnung');
    form.append('text', 'from the scanner app');
    form.append('file', new File([new Uint8Array([1, 2, 3])], '../Rechnung 114.pdf', { type: 'application/pdf' }));
    return form;
  };

  it('stashes each file with its cleaned name and its type', async () => {
    const cache = new FakeCache();
    const result = await stashShare(asCache(cache), shareForm(), { id: 'ab'.repeat(8), now: NOW });

    expect(result.fileCount).toBe(1);
    expect(result.location).toBe(`/share?share=${'ab'.repeat(8)}`);

    const stored = await cache.match(shareKey('ab'.repeat(8), 0));
    expect(stored?.headers.get('content-type')).toBe('application/pdf');
    expect(decodeURIComponent(stored?.headers.get(SHARE_FILENAME_HEADER) ?? '')).toBe('Rechnung 114.pdf');
    expect(stored?.headers.get(SHARE_STASHED_AT_HEADER)).toBe(NOW.toISOString());
  });

  it('answers the POST with a 303 to a GET, so the share is not left in the history as a POST', async () => {
    const storage = new FakeCacheStorage();
    const response = await handleShareTarget(
      new Request(`${ORIGIN}/share`, { method: 'POST', body: shareForm() }),
      { caches: asCacheStorage(storage), crypto: fixedCrypto, now: () => NOW },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/share?share=${'ab'.repeat(16)}`);
  });

  it('redirects with an error rather than letting the operating system report the failure', async () => {
    const response = await handleShareTarget(
      // A body that is not multipart: `formData()` rejects.
      new Request(`${ORIGIN}/share`, { method: 'POST', body: 'not a form', headers: { 'content-type': 'text/plain' } }),
      { caches: asCacheStorage(new FakeCacheStorage()), crypto: fixedCrypto, now: () => NOW },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/share?error=stash`);
  });

  it('is read back by the page with the name, the type and the note', async () => {
    const storage = new FakeCacheStorage();
    const cache = await storage.open(SHARE_CACHE);
    await stashShare(asCache(cache), shareForm(), { id: 'cd'.repeat(8), now: NOW });

    const shares = await readShare(asCacheStorage(storage), 'cd'.repeat(8));
    expect(shares).toHaveLength(1);
    expect(shares[0]?.filename).toBe('Rechnung 114.pdf');
    expect(shares[0]?.mediaType).toBe('application/pdf');
    expect(shares[0]?.note).toBe('from the scanner app');
    expect(await shares[0]?.blob.text()).toHaveLength(3);
  });

  it('is emptied once the page has it, so a reload does not upload it twice', async () => {
    const storage = new FakeCacheStorage();
    const cache = await storage.open(SHARE_CACHE);
    await stashShare(asCache(cache), shareForm(), { id: 'ef'.repeat(8), now: NOW });

    expect(await clearShare(asCacheStorage(storage), 'ef'.repeat(8))).toBe(1);
    expect(await readShare(asCacheStorage(storage), 'ef'.repeat(8))).toEqual([]);
  });

  it('sweeps an uncollected share, and nothing else', async () => {
    const cache = new FakeCache();
    await stashShare(asCache(cache), shareForm(), { id: 'ab'.repeat(8), now: new Date('2026-08-22T08:00:00.000Z') });
    await stashShare(asCache(cache), shareForm(), { id: 'cd'.repeat(8), now: NOW });
    await cache.put(`${ORIGIN}/assets/not-a-share.js`, new Response('keep me'));

    const removed = await sweepShares(asCache(cache), NOW);
    expect(removed).toBe(1);
    expect(await cache.match(shareKey('cd'.repeat(8), 0))).toBeDefined();
    expect(await cache.match(`${ORIGIN}/assets/not-a-share.js`)).toBeDefined();
  });
});
