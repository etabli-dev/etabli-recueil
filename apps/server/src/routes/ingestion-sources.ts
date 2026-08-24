/**
 * `/api/v1/ingestion/sources` — the watched folder, the WebDAV share and the mailbox.
 *
 * Four things distinguish this from a settings form.
 *
 * **A credential goes in and never comes out.** `secret` is accepted on a create and an update and
 * is absent from every response shape; what comes back is `secretNames`, the list of which
 * credentials are held. There is no "reveal" endpoint, and adding one would defeat storing them
 * encrypted in the first place.
 *
 * **`test-connection` reaches the far side.** It opens the socket, authenticates and lists, and
 * answers with one row per check. A test that only validated the stored configuration would pass
 * against a server that has been switched off, which is worse than no test because it reads as
 * evidence.
 *
 * **Enable and disable are their own operations**, not a `PATCH` of a boolean, because turning a
 * mailbox off at two in the morning is a distinct act that deserves its own audit line and its own
 * shape in a client.
 *
 * **`run` is asynchronous and answers with a job id.** A folder with four hundred scans is not a
 * request-response operation, so the run continues after the 202 and the queue is where its
 * progress lives.
 */
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { nowTimestamp } from '@recueil/core';

import { sendJson, wholeList } from '../http.js';
import { sourceToWire } from '../ingestion/sources.js';
import {
  idPath,
  jsonBody,
  jsonResponse,
  operation,
  problems,
} from '../openapi-kit.js';
import {
  IngestionSourceCreateSchema,
  IngestionSourcePageSchema,
  IngestionSourceSchema,
  IngestionSourceUpdateSchema,
  SourceRunAcceptedSchema,
  SourceRunRequestSchema,
  TestConnectionResultSchema,
} from '../schemas-ingestion.js';
import { coerceQuery, parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/ingestion/sources`;

const SOURCE_TAGS = ['Ingestion'] as const;

const ListSourcesQuerySchema = z.strictObject({
  kind: z.enum(['folder', 'webdav', 'imap']).optional(),
  enabled: z.coerce.boolean().optional(),
});

/** How long a connection test may take before it is abandoned and reported as a timeout. */
const TEST_TIMEOUT_MS = 20_000;

export const ingestionSourceRoutes: FastifyPluginAsync = async (app) => {
  const { ingestion } = app.recueil;

  app.get(BASE, { config: { scope: 'ingestion:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListSourcesQuerySchema, coerceQuery(request.query), 'query');
    const rows = ingestion.sources.list({
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
    });
    return sendJson(reply, IngestionSourcePageSchema, wholeList(rows.map(sourceToWire)));
  });

  app.post(BASE, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const body = parseOrThrow(IngestionSourceCreateSchema, request.body, 'body');
    const row = await ingestion.sources.create(body, request.actor);
    reply.header('location', `${BASE}/${row.id}`);
    return sendJson(reply, IngestionSourceSchema, sourceToWire(row), 201);
  });

  app.get(`${BASE}/:id`, { config: { scope: 'ingestion:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, IngestionSourceSchema, sourceToWire(ingestion.sources.get(id)));
  });

  app.patch(`${BASE}/:id`, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(IngestionSourceUpdateSchema, request.body, 'body');
    const row = await ingestion.sources.update(id, body, request.actor);
    return sendJson(reply, IngestionSourceSchema, sourceToWire(row));
  });

  app.delete(`${BASE}/:id`, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    ingestion.sources.remove(id, request.actor);
    return reply.code(204).send();
  });

  app.post(`${BASE}/:id/enable`, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(
      reply,
      IngestionSourceSchema,
      sourceToWire(ingestion.sources.setEnabled(id, true, request.actor)),
    );
  });

  app.post(`${BASE}/:id/disable`, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(
      reply,
      IngestionSourceSchema,
      sourceToWire(ingestion.sources.setEnabled(id, false, request.actor)),
    );
  });

  app.post(
    `${BASE}/:id/test-connection`,
    { config: { scope: 'ingestion:write' } },
    async (request, reply) => {
      const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
      const row = ingestion.sources.get(id);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
      const startedAt = Date.now();
      let checks;
      try {
        checks = await ingestion.sources.testConnection(row, controller.signal);
      } finally {
        clearTimeout(timeout);
      }

      const ok = checks.length > 0 && checks.every((check) => check.ok);
      return sendJson(reply, TestConnectionResultSchema, {
        sourceId: row.id,
        kind: row.kind,
        ok,
        checkedAt: nowTimestamp(),
        durationMs: Date.now() - startedAt,
        checks,
        detail: ok
          ? `${String(checks.length)} check(s) passed`
          : checks
              .filter((check) => !check.ok)
              .map((check) => `${check.check}: ${check.detail}`)
              .join('; '),
      });
    },
  );

  app.post(`${BASE}/:id/run`, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(SourceRunRequestSchema, request.body ?? {}, 'body');
    const started = await ingestion.runner.startSourceRun(id, {
      actor: request.actor,
      ...(body.runLabel === undefined ? {} : { runLabel: body.runLabel }),
      ...(body.limit === undefined ? {} : { limit: body.limit }),
    });

    reply.header('location', `${API_BASE_PATH}/ingestion/queue/${started.jobId}`);
    return sendJson(
      reply,
      SourceRunAcceptedSchema,
      { sourceId: id, jobId: started.jobId, runLabel: started.runLabel, startedAt: started.startedAt },
      202,
    );
  });
};

export const ingestionSourcePaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listIngestionSources',
      summary: 'List configured ingestion sources',
      description:
        'Every configured folder, WebDAV share and mailbox. Credentials are not in the response: ' +
        '`secretNames` says which are held and nothing returns their values.',
      tags: SOURCE_TAGS,
      scope: 'ingestion:read',
      requestParams: { query: ListSourcesQuerySchema },
      responses: {
        '200': jsonResponse('The configured sources.', IngestionSourcePageSchema),
        ...problems('401', '403', '422'),
      },
    }),
    post: operation({
      operationId: 'createIngestionSource',
      summary: 'Configure an ingestion source',
      description:
        'A folder root is resolved, symlink-followed and — when `RECUEIL_INGEST_ALLOWED_ROOTS` is ' +
        'set — required to be inside it, because a path in a request body is hostile until it has ' +
        'been checked against something. A `secret` is stored encrypted under `RECUEIL_SECRET_KEY`; ' +
        'a server with no key configured refuses rather than storing a credential it cannot protect.',
      tags: SOURCE_TAGS,
      scope: 'ingestion:write',
      requestBody: jsonBody(IngestionSourceCreateSchema),
      responses: {
        '201': jsonResponse('The configured source.', IngestionSourceSchema),
        ...problems('401', '403', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getIngestionSource',
      summary: 'Fetch one ingestion source',
      description: 'The configuration, without its credentials.',
      tags: SOURCE_TAGS,
      scope: 'ingestion:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The source.', IngestionSourceSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
    patch: operation({
      operationId: 'updateIngestionSource',
      summary: 'Change an ingestion source',
      description:
        'The kind cannot change: the state table that records what has already been consumed is ' +
        'keyed by the source, and reinterpreting it under another protocol would be meaningless. ' +
        'Sending `secret` replaces the stored credentials wholesale; `{}` clears them.',
      tags: SOURCE_TAGS,
      scope: 'ingestion:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(IngestionSourceUpdateSchema),
      responses: {
        '200': jsonResponse('The updated source.', IngestionSourceSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
    delete: operation({
      operationId: 'deleteIngestionSource',
      summary: 'Remove an ingestion source',
      description:
        'The configuration goes; nothing it produced is touched. This is the one place P5 does not ' +
        'reach, because a source is configuration rather than library content — and the audit entry ' +
        'carries the whole configuration, so it is recoverable from the log.',
      tags: SOURCE_TAGS,
      scope: 'ingestion:write',
      requestParams: { path: idPath() },
      responses: {
        '204': { description: 'Removed.' },
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/enable`]: {
    post: operation({
      operationId: 'enableIngestionSource',
      summary: 'Enable a source',
      description: 'A disabled source is never polled and cannot be run.',
      tags: SOURCE_TAGS,
      scope: 'ingestion:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The source.', IngestionSourceSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/disable`]: {
    post: operation({
      operationId: 'disableIngestionSource',
      summary: 'Disable a source',
      description:
        'Nothing in flight is stopped — cancel the run for that — and nothing already ingested is ' +
        'touched.',
      tags: SOURCE_TAGS,
      scope: 'ingestion:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The source.', IngestionSourceSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/test-connection`]: {
    post: operation({
      operationId: 'testIngestionSource',
      summary: 'Try the source and report what happened',
      description:
        'Reaches the far side: a folder is resolved, `stat`ed and read; a WebDAV collection gets an ' +
        '`OPTIONS` and a `PROPFIND`; a mailbox is connected to, logged in to and selected. The ' +
        'response carries one row per check and `ok` is the conjunction of those rows, so a green ' +
        'result names its evidence.\n\n' +
        'Nothing is written and nothing is consumed. A source that holds a credential this server ' +
        'cannot decrypt reports that as a failed `credentials` check rather than as a 500.',
      tags: SOURCE_TAGS,
      scope: 'ingestion:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('What was tried, and what happened.', TestConnectionResultSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/run`]: {
    post: operation({
      operationId: 'runIngestionSource',
      summary: 'Poll a source now',
      description:
        'Starts one poll and returns immediately with the `jobs` row it will write to. The run ' +
        'continues after the response: watch it at `/api/v1/ingestion/queue/{id}`, cancel it there, ' +
        'and read what it decided in `/api/v1/ingestion/review`.\n\n' +
        'The same `runLabel` resumes an unfinished run rather than starting a second one, which is ' +
        'what makes a retried poll safe (P9).',
      tags: SOURCE_TAGS,
      scope: 'ingestion:write',
      requestParams: { path: idPath() },
      requestBody: {
        required: false,
        content: { 'application/json': { schema: SourceRunRequestSchema } },
      },
      responses: {
        '202': jsonResponse('The run has started.', SourceRunAcceptedSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
};
