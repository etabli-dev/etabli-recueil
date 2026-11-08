/**
 * The embedding host: how the desktop shell tells the client where its server is.
 */
import { describe, expect, it } from 'vitest';

import { RecueilClient } from '../src/api/client.js';
import { clientOptionsFor, embeddingHost } from '../src/host.js';
import type { RecueilHost } from '../src/host.js';

describe('the embedding host', () => {
  it('is absent in a plain browser, which keeps the same-origin client', () => {
    expect(embeddingHost({})).toBeUndefined();
    expect(embeddingHost(globalThis)).toBeUndefined();
  });

  it('ignores anything that is not shaped like a host', () => {
    expect(embeddingHost({ recueilHost: null })).toBeUndefined();
    expect(embeddingHost({ recueilHost: 'http://127.0.0.1:3000' })).toBeUndefined();
    expect(embeddingHost({ recueilHost: { connection: 'nope' } })).toBeUndefined();
  });

  it('is found when a shell has installed one', async () => {
    const host: RecueilHost = { connection: async () => ({ baseUrl: 'http://127.0.0.1:3000' }) };
    const found = embeddingHost({ recueilHost: host });
    expect(found).toBe(host);
    await expect(found?.connection()).resolves.toEqual({ baseUrl: 'http://127.0.0.1:3000' });
  });

  it('turns the answer into client options, dropping a trailing slash and an empty token', () => {
    expect(clientOptionsFor({ baseUrl: 'http://127.0.0.1:3000/' })).toEqual({ baseUrl: 'http://127.0.0.1:3000' });
    expect(clientOptionsFor({ baseUrl: 'https://example.org/recueil', token: '' })).toEqual({
      baseUrl: 'https://example.org/recueil',
    });
    expect(clientOptionsFor({ baseUrl: 'https://example.org', token: 'rc_secret' })).toEqual({
      baseUrl: 'https://example.org',
      token: 'rc_secret',
    });
  });

  it('gives a client that addresses the server absolutely and presents the token', async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const client = new RecueilClient({
      ...clientOptionsFor({ baseUrl: 'https://example.org/recueil/', token: 'rc_secret' }),
      fetch: async (input, init) => {
        seen.push({ url: input, authorization: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify({ data: [], page: { nextCursor: null, hasMore: false, limit: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await client.listItems({ limit: 1 });
    expect(seen).toEqual([{ url: 'https://example.org/recueil/api/v1/items?limit=1', authorization: 'Bearer rc_secret' }]);
    expect(client.documentContentUrl('d1')).toBe('https://example.org/recueil/api/v1/documents/d1/content');
  });
});
