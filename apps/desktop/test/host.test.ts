/**
 * The host script against the contract the web client reads (`apps/web/src/host.ts`).
 */
import { describe, expect, it } from 'vitest';

import { clientOptionsFor, embeddingHost } from '../../web/src/host.js';
import { installHost } from '../shell/host.js';
import type { RecueilHost } from '../shell/host.js';

describe('the host script', () => {
  it('installs a host the web client recognises, answering what the shell answers', async () => {
    const scope: { recueilHost?: RecueilHost } = {};
    installHost(scope, async () => ({ baseUrl: 'http://127.0.0.1:3000', token: 'rc_secret' }));

    const host = embeddingHost(scope);
    expect(host).toBeDefined();
    const answer = await host?.connection();
    expect(answer).toEqual({ baseUrl: 'http://127.0.0.1:3000', token: 'rc_secret' });
    expect(clientOptionsFor(answer ?? { baseUrl: '' })).toEqual({ baseUrl: 'http://127.0.0.1:3000', token: 'rc_secret' });
  });

  it('cannot be replaced by a later script', () => {
    const scope: { recueilHost?: RecueilHost } = {};
    installHost(scope, async () => ({ baseUrl: 'http://127.0.0.1:3000' }));
    expect(() => {
      scope.recueilHost = { connection: async () => ({ baseUrl: 'https://attacker.example' }) };
    }).toThrow(TypeError);
    expect(() => installHost(scope, async () => ({ baseUrl: 'https://attacker.example' }))).toThrow(TypeError);
  });
});
