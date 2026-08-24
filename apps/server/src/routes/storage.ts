/**
 * `/api/v1/storage/backends` — the WebDAV and S3 configurations, and a health check that touches
 * them.
 *
 * The thing to be clear about before reading the handlers: **configuring a backend here does not
 * rebind the running library.** The store a process writes through is chosen at boot from
 * `RECUEIL_STORAGE_*`, and it has to be, because a content-addressed store is only addressable if
 * every blob is in it — swapping it under a live library would strand every blob written before the
 * swap behind a `documents.storage_backend` that no longer resolves. So this surface is where an
 * operator writes a configuration, proves it works, and then points the environment at it.
 * `active` says which configured backend, if any, matches what the process is using.
 *
 * The health check has two modes and both report their evidence. `read` asks the store for a digest
 * of random bytes: a full round trip through DNS, TLS, authentication and addressing that writes
 * nothing, and whose correct answer is "no". `roundtrip` writes a probe blob, reads it back,
 * compares the digest and deletes it — the only check that proves the store can hold a document,
 * and the only one that catches a server that accepts a `PUT` and stores something else.
 */
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import { nowTimestamp } from '@recueil/core';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { sendJson, wholeList } from '../http.js';
import { backendToWire } from '../ingestion/storage.js';
import {
  idPath,
  jsonBody,
  jsonResponse,
  operation,
  problems,
} from '../openapi-kit.js';
import {
  StorageBackendCreateSchema,
  StorageBackendPageSchema,
  StorageBackendSchema,
  StorageBackendUpdateSchema,
  StorageHealthRequestSchema,
  StorageHealthResultSchema,
} from '../schemas-ingestion.js';
import { parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/storage/backends`;

const STORAGE_TAGS = ['Storage'] as const;

export const storageBackendRoutes: FastifyPluginAsync = async (app) => {
  const { ingestion } = app.recueil;

  app.get(BASE, { config: { scope: 'storage:read' } }, async (_request, reply) => {
    const rows = ingestion.storage.list();
    return sendJson(
      reply,
      StorageBackendPageSchema,
      wholeList(rows.map((row) => backendToWire(row, ingestion.storage.isActive(row)))),
    );
  });

  app.post(BASE, { config: { scope: 'storage:write' } }, async (request, reply) => {
    const body = parseOrThrow(StorageBackendCreateSchema, request.body, 'body');
    const row = ingestion.storage.create(body, request.actor);
    reply.header('location', `${BASE}/${row.id}`);
    return sendJson(
      reply,
      StorageBackendSchema,
      backendToWire(row, ingestion.storage.isActive(row)),
      201,
    );
  });

  app.get(`${BASE}/:id`, { config: { scope: 'storage:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const row = ingestion.storage.get(id);
    return sendJson(reply, StorageBackendSchema, backendToWire(row, ingestion.storage.isActive(row)));
  });

  app.patch(`${BASE}/:id`, { config: { scope: 'storage:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(StorageBackendUpdateSchema, request.body, 'body');
    const row = ingestion.storage.update(id, body, request.actor);
    return sendJson(reply, StorageBackendSchema, backendToWire(row, ingestion.storage.isActive(row)));
  });

  app.delete(`${BASE}/:id`, { config: { scope: 'storage:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    ingestion.storage.remove(id, request.actor);
    return reply.code(204).send();
  });

  app.post(`${BASE}/:id/health`, { config: { scope: 'storage:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(StorageHealthRequestSchema, request.body ?? {}, 'body');
    const row = ingestion.storage.get(id);
    const mode = body.mode ?? 'read';

    const startedAt = Date.now();
    const result = await ingestion.storage.probe(row, mode);
    ingestion.storage.recordProbe(id, result);

    return sendJson(reply, StorageHealthResultSchema, {
      backendId: row.id,
      kind: row.kind,
      status: result.status,
      checkedAt: nowTimestamp(),
      durationMs: Date.now() - startedAt,
      mode,
      checks: result.checks,
      detail: result.detail,
    });
  });
};

export const storageBackendPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listStorageBackends',
      summary: 'List configured storage backends',
      description:
        'Every configured WebDAV and S3 store, with the last health check\'s verdict and whether ' +
        'the running process is writing through one of this kind. Credentials are not returned: ' +
        '`secretNames` says which are held.',
      tags: STORAGE_TAGS,
      scope: 'storage:read',
      responses: {
        '200': jsonResponse('The configured backends.', StorageBackendPageSchema),
        ...problems('401', '403'),
      },
    }),
    post: operation({
      operationId: 'createStorageBackend',
      summary: 'Configure a storage backend',
      description:
        'Writes the configuration. It does **not** rebind the running library: the store a process ' +
        'writes through is chosen at boot, because swapping it mid-life would strand every blob ' +
        'written before the swap. Verify with `POST {id}/health`, then point `RECUEIL_STORAGE_*` at ' +
        'it and restart.',
      tags: STORAGE_TAGS,
      scope: 'storage:write',
      requestBody: jsonBody(StorageBackendCreateSchema),
      responses: {
        '201': jsonResponse('The configuration.', StorageBackendSchema),
        ...problems('401', '403', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getStorageBackend',
      summary: 'Fetch one storage backend',
      description: 'The configuration, without its credentials.',
      tags: STORAGE_TAGS,
      scope: 'storage:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The backend.', StorageBackendSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
    patch: operation({
      operationId: 'updateStorageBackend',
      summary: 'Change a storage backend',
      description: 'The kind cannot change. Sending `secret` replaces the stored credentials wholesale.',
      tags: STORAGE_TAGS,
      scope: 'storage:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(StorageBackendUpdateSchema),
      responses: {
        '200': jsonResponse('The updated backend.', StorageBackendSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
    delete: operation({
      operationId: 'deleteStorageBackend',
      summary: 'Remove a storage backend configuration',
      description:
        'Refused with a 409 while the running process is writing through a backend of this kind: ' +
        'removing the configuration of the live store would leave nobody able to say where the ' +
        'blobs are. Nothing in the store is touched either way.',
      tags: STORAGE_TAGS,
      scope: 'storage:write',
      requestParams: { path: idPath() },
      responses: {
        '204': { description: 'Removed.' },
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/health`]: {
    post: operation({
      operationId: 'checkStorageBackend',
      summary: 'Probe a storage backend',
      description:
        '`read` (the default) asks the store for the digest of some random bytes: a complete round ' +
        'trip through authentication and addressing that writes nothing, and whose correct answer ' +
        'is "absent".\n\n' +
        '`roundtrip` additionally writes a 64-byte probe blob, reads it back through the store\'s ' +
        'own reader, compares the digest of what came back with the digest of what went in, and ' +
        'deletes it in a `finally`. It is the only mode that proves the store can hold a document ' +
        'and the only one that catches a server that accepts a `PUT` and stores something else.\n\n' +
        '`status` is the conjunction of the individual checks; `degraded` is reserved for the case ' +
        'where the store worked and the probe blob could not be removed.',
      tags: STORAGE_TAGS,
      scope: 'storage:write',
      requestParams: { path: idPath() },
      requestBody: {
        required: false,
        content: { 'application/json': { schema: StorageHealthRequestSchema } },
      },
      responses: {
        '200': jsonResponse('What was tried, and what happened.', StorageHealthResultSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
};
