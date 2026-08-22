/**
 * `/api/v1/tokens` — scoped API tokens (`spec/data-model.md` §3.2, CONCEPT.md §5.12).
 *
 * The secret is returned by `POST` and by nothing else, ever. That is not a UX choice: the server
 * stores its SHA-256 and cannot reproduce it, so a "show me that token again" endpoint could only
 * exist by storing the secret, which is the thing §3.2 forbids.
 *
 * Revocation is a `DELETE` that sets `revoked_at` (A3). The row survives, because
 * `audit_log.actor_token_id` has to keep resolving for as long as the log does — a write attributed
 * to a token that no longer exists is a write attributed to nothing.
 */
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { sendJson, wholeList } from '../http.js';
import { idPath, jsonBody, jsonResponse, operation, problems } from '../openapi-kit.js';
import { ApiTokenCreateSchema, ApiTokenCreatedSchema, ApiTokenPageSchema, ApiTokenSchema } from '../schemas.js';
import { parseScopes } from '../tokens.js';
import type { schema } from '@recueil/core';
import { coerceQuery, parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/tokens`;

const tokenToWire = (row: schema.ApiTokenRow): z.infer<typeof ApiTokenSchema> => ({
  id: row.id,
  userId: row.userId,
  name: row.name,
  tokenPrefix: row.tokenPrefix,
  scopes: parseScopes(row),
  client: row.client,
  createdAt: row.createdAt,
  createdByUserId: row.createdByUserId,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  note: row.note,
});

export const tokenRoutes: FastifyPluginAsync = async (app) => {
  const { tokens } = app.recueil;

  app.get(BASE, { config: { scope: 'tokens:read' } }, async (request, reply) => {
    const query = parseOrThrow(
      z.object({ includeRevoked: z.coerce.boolean().optional() }),
      coerceQuery(request.query),
      'query',
    );
    const rows = tokens.list({
      ...(query.includeRevoked === undefined ? {} : { includeRevoked: query.includeRevoked }),
    });
    return sendJson(reply, ApiTokenPageSchema, wholeList(rows.map(tokenToWire)));
  });

  app.post(BASE, { config: { scope: 'tokens:write' } }, async (request, reply) => {
    const body = parseOrThrow(ApiTokenCreateSchema, request.body, 'body');
    const created = tokens.create(
      {
        name: body.name,
        userId: request.principal.userId,
        ...(body.client === undefined ? {} : { client: body.client }),
        ...(body.scopes === undefined ? {} : { scopes: body.scopes }),
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
        ...(body.note === undefined ? {} : { note: body.note }),
      },
      request.actor,
    );

    reply.header('location', `${BASE}/${created.row.id}`);
    // Never cached and never stored by an intermediary: the body carries a bearer credential.
    reply.header('cache-control', 'no-store');
    return sendJson(
      reply,
      ApiTokenCreatedSchema,
      { token: tokenToWire(created.row), secret: created.secret },
      201,
    );
  });

  app.get(`${BASE}/:id`, { config: { scope: 'tokens:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, ApiTokenSchema, tokenToWire(tokens.get(id)));
  });

  app.delete(`${BASE}/:id`, { config: { scope: 'tokens:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, ApiTokenSchema, tokenToWire(tokens.revoke(id, request.actor)));
  });
};

export const tokenPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listTokens',
      summary: 'List API tokens',
      description:
        'The rows, without the secrets — which the server does not have. `tokenPrefix` is enough ' +
        'to identify a credential and not enough to use one.',
      tags: ['Platform'],
      scope: 'tokens:read',
      requestParams: { query: z.object({ includeRevoked: z.coerce.boolean().optional() }) },
      responses: { '200': jsonResponse('The tokens.', ApiTokenPageSchema), ...problems('401', '403', '422') },
    }),
    post: operation({
      operationId: 'createToken',
      summary: 'Mint an API token',
      description:
        '**The response is the only time the secret exists outside the client.** The server keeps ' +
        'its SHA-256 and cannot reproduce it (§3.2).\n\n' +
        "Scopes are `resource:verb` pairs, either half of which may be `*`; `write` implies " +
        '`read` on the same resource. A `bib_feed` token — the credential that goes in an Overleaf ' +
        'URL — may hold read scopes only, and one with a write scope is refused (A2).',
      tags: ['Platform'],
      scope: 'tokens:write',
      requestBody: jsonBody(ApiTokenCreateSchema),
      responses: {
        '201': jsonResponse('The token, and its secret, once.', ApiTokenCreatedSchema),
        ...problems('401', '403', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getToken',
      summary: 'Fetch one token',
      description: 'Without its secret, which cannot be recovered.',
      tags: ['Platform'],
      scope: 'tokens:read',
      requestParams: { path: idPath() },
      responses: { '200': jsonResponse('The token.', ApiTokenSchema), ...problems('401', '403', '404', '422') },
    }),
    delete: operation({
      operationId: 'revokeToken',
      summary: 'Revoke a token',
      description:
        'Sets `revokedAt`. The row is never deleted (A3): `audit_log.actor_token_id` has to keep ' +
        'resolving for as long as the log does.',
      tags: ['Platform'],
      scope: 'tokens:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The revoked token.', ApiTokenSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
};
