/**
 * Tokens, scopes and audit attribution.
 *
 * Three claims are tested here and each is a promise the rest of the system rests on:
 *
 * 1. **The secret is never stored.** The database holds a SHA-256 and a twelve-character prefix, so
 *    a copy of the database is not a copy of the credentials (`spec/data-model.md` §3.2).
 * 2. **Scopes are enforced by the route table, not by the handler.** Every `/api/v1` route declares
 *    the scope it needs; the last test in this file walks Fastify's own routes and fails on one
 *    that declares none, because a route that forgets is a hole nothing else would notice.
 * 3. **A write through a token is attributable** (P4, AL2, AL3): the `audit_log` row carries
 *    `actor_type = 'token'`, the token id, the request id and the route.
 */
import { schema } from '@recueil/core';
import { desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { hashTokenSecret } from '../src/tokens.js';
import { body, harness, itemPayload } from './helpers.js';

describe('POST /api/v1/tokens', () => {
  it('returns the secret once and stores only its hash', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/tokens',
        payload: { name: 'laptop CLI', client: 'cli', scopes: ['items:read', 'items:write'] },
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');

      const created = body(response);
      const secret = created.secret as string;
      const token = created.token as Record<string, unknown>;

      expect(secret.startsWith('rcu_')).toBe(true);
      expect(token.tokenPrefix).toBe(secret.slice(0, 12));
      expect(token.scopes).toEqual(['items:read', 'items:write']);
      // The response document has no field for the hash, and no other endpoint returns the secret.
      expect(Object.keys(token)).not.toContain('tokenHash');

      const row = h.recueil.db
        .select()
        .from(schema.apiTokens)
        .where(eq(schema.apiTokens.id, token.id as string))
        .get();
      expect(row?.tokenHash).toBe(hashTokenSecret(secret));
      expect(row?.tokenHash).not.toContain(secret);

      const fetched = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/tokens/${token.id as string}` }),
      );
      expect(Object.values(fetched)).not.toContain(secret);
    } finally {
      await h.close();
    }
  });

  it('refuses a write scope on a bib_feed token (A2)', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/tokens',
        payload: { name: 'Overleaf', client: 'bib_feed', scopes: ['items:write'] },
      });
      expect(response.statusCode).toBe(409);
      expect(body(response).detail).toContain('A2');
    } finally {
      await h.close();
    }
  });

  it('refuses a scope that is not a resource:verb pair', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/tokens',
        payload: { name: 'Bad', scopes: ['everything'] },
      });
      expect(response.statusCode).toBe(422);
    } finally {
      await h.close();
    }
  });

  it('revokes without deleting, so the audit log still resolves (A3)', async () => {
    const h = await harness();
    try {
      const created = body(
        await h.app.inject({ method: 'POST', url: '/api/v1/tokens', payload: { name: 'Temp' } }),
      );
      const id = (created.token as { id: string }).id;

      const revoked = await h.app.inject({ method: 'DELETE', url: `/api/v1/tokens/${id}` });
      expect(revoked.statusCode).toBe(200);
      expect(body(revoked).revokedAt).toBeTypeOf('string');

      const row = h.recueil.db
        .select()
        .from(schema.apiTokens)
        .where(eq(schema.apiTokens.id, id))
        .get();
      expect(row).toBeDefined();

      // And it no longer authenticates.
      const withRevoked = await h.app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { authorization: `Bearer ${created.secret as string}` },
      });
      expect(withRevoked.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });
});

describe('authentication', () => {
  it('admits an unauthenticated request when no token is required', async () => {
    const h = await harness();
    try {
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/items' })).statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('refuses one when RECUEIL_REQUIRE_AUTH is set, and names the scheme', async () => {
    const h = await harness({ env: { RECUEIL_REQUIRE_AUTH: 'true' } });
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/items' });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer realm="recueil"');
      expect(body(response).type).toBe('https://recueil.org/problems/unauthenticated');

      // The probe and the contract stay reachable: a health check has no token, and a client that
      // cannot read the contract cannot work out how to authenticate.
      expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await h.app.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('rejects a token that never existed', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { authorization: 'Bearer rcu_definitelynotatoken' },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('rejects an expired token (A1)', async () => {
    const h = await harness();
    try {
      const created = h.app.recueil.tokens.create(
        { name: 'Yesterday', expiresAt: new Date(Date.now() - 60_000).toISOString() },
        h.recueil.actor,
      );
      const response = await h.app.inject({
        method: 'GET',
        url: '/api/v1/items',
        headers: { authorization: `Bearer ${created.secret}` },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('accepts the query token only where the route allows it', async () => {
    const h = await harness({ env: { RECUEIL_REQUIRE_AUTH: 'true' } });
    try {
      const created = h.app.recueil.tokens.create(
        { name: 'Feed', client: 'bib_feed', scopes: ['export:read', 'collections:read'] },
        h.recueil.actor,
      );

      // `/items` does not opt in, so the query parameter is not a credential there.
      const items = await h.app.inject({ method: 'GET', url: `/api/v1/items?token=${created.secret}` });
      expect(items.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });
});

describe('scopes', () => {
  it('refuses a call the token has no scope for, and names the scope', async () => {
    const h = await harness();
    try {
      const created = h.app.recueil.tokens.create(
        { name: 'Read only', scopes: ['items:read'] },
        h.recueil.actor,
      );
      const headers = { authorization: `Bearer ${created.secret}` };

      expect((await h.app.inject({ method: 'GET', url: '/api/v1/items', headers })).statusCode).toBe(200);

      const write = await h.app.inject({
        method: 'POST',
        url: '/api/v1/items',
        headers,
        payload: itemPayload(),
      });
      expect(write.statusCode).toBe(403);
      expect(body(write).type).toBe('https://recueil.org/problems/scope-required');
      expect(body(write).detail).toContain('items:write');
    } finally {
      await h.close();
    }
  });

  it('treats write as implying read on the same resource', async () => {
    const h = await harness();
    try {
      const created = h.app.recueil.tokens.create(
        { name: 'Writer', scopes: ['items:write'] },
        h.recueil.actor,
      );
      const headers = { authorization: `Bearer ${created.secret}` };
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/items', headers })).statusCode).toBe(200);
      // …and not on a different one.
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/tags', headers })).statusCode).toBe(403);
    } finally {
      await h.close();
    }
  });

  it('declares a scope on every /api/v1 route', async () => {
    const h = await harness();
    try {
      const missing = h.routes
        .filter((route) => route.url.startsWith('/api/v1/'))
        .filter((route) => route.method !== 'HEAD' && route.method !== 'OPTIONS')
        .filter((route) => route.scope === undefined && route.public !== true)
        .map((route) => `${route.method} ${route.url}`);

      expect(missing).toEqual([]);
      expect(h.routes.length).toBeGreaterThan(40);
    } finally {
      await h.close();
    }
  });

  it('accepts a URL token on the feed endpoints and nowhere else', async () => {
    const h = await harness();
    try {
      const opted = h.routes
        .filter((route) => route.allowQueryToken === true)
        .map((route) => route.url)
        .sort();
      expect([...new Set(opted)]).toEqual([
        '/api/v1/collections/:id/bibliography.bib',
        '/api/v1/saved-searches/:id/bibliography.bib',
      ]);
    } finally {
      await h.close();
    }
  });
});

describe('audit attribution (P4, AL2)', () => {
  it('records the token, the request id and the route on a write', async () => {
    const h = await harness();
    try {
      const created = h.app.recueil.tokens.create({ name: 'Writer' }, h.recueil.actor);

      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/items',
        headers: { authorization: `Bearer ${created.secret}`, 'user-agent': 'recueil-test/1.0' },
        payload: itemPayload(),
      });
      expect(response.statusCode).toBe(201);

      const row = h.recueil.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, body(response).id as string))
        .orderBy(desc(schema.auditLog.id))
        .get();

      expect(row?.action).toBe('item.created');
      expect(row?.actorType).toBe('token');
      expect(row?.actorTokenId).toBe(created.row.id);
      // AL2: exactly one actor column is populated.
      expect(row?.actorUserId).toBeNull();
      expect(row?.requestId).toBe(response.headers['x-request-id']);
      expect(row?.apiRoute).toBe('POST /api/v1/items');
      expect(row?.userAgent).toBe('recueil-test/1.0');
    } finally {
      await h.close();
    }
  });

  it('records the local user when there is no token', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'POST', url: '/api/v1/items', payload: itemPayload() });
      const row = h.recueil.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityId, body(response).id as string))
        .get();

      expect(row?.actorType).toBe('user');
      expect(row?.actorUserId).toBe(h.recueil.user.id);
      expect(row?.actorTokenId).toBeNull();
    } finally {
      await h.close();
    }
  });
});
