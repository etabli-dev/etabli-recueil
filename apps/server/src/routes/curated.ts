/**
 * `/api/v1/curated-networks` — versioned publication figures (CONCEPT §5.9, ADR-0013).
 */
import { curatedToNetwork, curatedToSvg, curatedToTikz, toGexf, toGraphml } from '@recueil/analytics';
import type { CuratedDocument, ResolvedNetwork } from '@recueil/core';
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { ifMatchVersion } from '../http.js';
import { idPath, jsonBody, jsonResponse, operation, problems } from '../openapi-kit.js';
import { coerceQuery, parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/curated-networks`;
const TAGS = ['Curated networks'] as const;

const DocumentSchema = z
  .record(z.string(), z.unknown())
  .meta({ id: 'CuratedNetworkDocument', description: 'A `recueil.curated-network/1` document: nodes, edges, layout, style, annotations (§7.2).' });

const CreateSchema = z
  .strictObject({
    name: z.string().min(1).max(255),
    description: z.string().max(4000).nullish(),
    document: DocumentSchema.optional(),
    fromGraph: z.enum(['citations', 'local', 'co-citation', 'coupling']).optional().meta({ description: 'Start from a graph network instead of an empty document.' }),
  })
  .meta({ id: 'CuratedNetworkCreate', unusedIO: 'input' });

const SaveSchema = z
  .strictObject({ document: DocumentSchema, message: z.string().max(500).optional() })
  .meta({ id: 'CuratedNetworkSave', unusedIO: 'input' });

const ResolvedSchema = z
  .object({
    id: z.string(),
    publicId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    version: z.number().int(),
    isFrozen: z.boolean(),
    frozenAt: z.string().nullable(),
    message: z.string().nullable(),
    document: DocumentSchema,
    items: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'CuratedNetwork', title: 'CuratedNetwork' });

const SummarySchema = z.object({ id: z.string(), name: z.string(), updatedAt: z.string() }).meta({ id: 'CuratedNetworkSummary' });

const toWire = (resolved: ResolvedNetwork) => ({
  id: resolved.network.id,
  publicId: resolved.network.publicId,
  name: resolved.network.name,
  description: resolved.network.description,
  version: resolved.version.version,
  isFrozen: resolved.version.isFrozen,
  frozenAt: resolved.version.frozenAt,
  message: resolved.version.message,
  document: resolved.document as unknown as Record<string, unknown>,
  items: resolved.items as unknown as Record<string, unknown>,
});

const VersionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const ExportQuery = z.object({
  version: z.coerce.number().int().min(1).optional(),
  format: z.enum(['svg', 'tikz', 'graphml', 'gexf', 'json']),
});

export const curatedRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  app.get(BASE, { config: { scope: 'networks:read' } }, async (_request, reply) =>
    reply.send({ data: recueil.curated.list().map((row) => SummarySchema.parse({ id: row.id, name: row.name, updatedAt: row.updatedAt })) }),
  );

  app.post(BASE, { config: { scope: 'networks:write' } }, async (request, reply) => {
    const body = parseOrThrow(CreateSchema, request.body, 'body');
    let document = body.document as CuratedDocument | undefined;
    if (document === undefined && body.fromGraph !== undefined) {
      const network =
        body.fromGraph === 'citations'
          ? recueil.graph.citationNetwork()
          : body.fromGraph === 'local'
            ? recueil.graph.citationNetwork({ localOnly: true })
            : recueil.graph.derivedNetwork(body.fromGraph === 'co-citation' ? 'co_cited' : 'coupled');
      document = recueil.curated.documentFromGraph(network);
    }
    const created = recueil.curated.create({ name: body.name, ...(body.description === undefined ? {} : { description: body.description }), ...(document === undefined ? {} : { document }) }, request.actor);
    return reply.code(201).header('location', `${BASE}/${created.network.id}`).send(ResolvedSchema.parse(toWire(created)));
  });

  app.get(`${BASE}/:id`, { config: { scope: 'networks:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const { version } = parseOrThrow(VersionQuery, coerceQuery(request.query), 'query');
    const resolved = recueil.curated.resolve(id, version);
    return reply.header('etag', `"${resolved.version.version}"`).send(ResolvedSchema.parse(toWire(resolved)));
  });

  app.put(`${BASE}/:id`, { config: { scope: 'networks:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(SaveSchema, request.body, 'body');
    const expectedVersion = ifMatchVersion(request);
    const saved = recueil.curated.save(id, body.document as unknown as CuratedDocument, request.actor, {
      ...(body.message === undefined ? {} : { message: body.message }),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
    return reply.header('etag', `"${saved.version.version}"`).send(ResolvedSchema.parse(toWire(saved)));
  });

  app.post(`${BASE}/:id/freeze`, { config: { scope: 'networks:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const { version } = parseOrThrow(VersionQuery, coerceQuery(request.query), 'query');
    return reply.send(ResolvedSchema.parse(toWire(recueil.curated.freeze(id, request.actor, version))));
  });

  app.get(`${BASE}/:id/export`, { config: { scope: 'networks:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const query = parseOrThrow(ExportQuery, coerceQuery(request.query), 'query');
    const resolved = recueil.curated.resolve(id, query.version);
    const base = resolved.network.name.replace(/[^\w.-]+/gu, '_');
    switch (query.format) {
      case 'svg':
        return reply.header('content-type', 'image/svg+xml; charset=utf-8').header('content-disposition', `attachment; filename="${base}.svg"`).send(curatedToSvg(resolved));
      case 'tikz':
        return reply.header('content-type', 'text/x-tex; charset=utf-8').header('content-disposition', `attachment; filename="${base}.tex"`).send(curatedToTikz(resolved));
      case 'graphml':
        return reply.header('content-type', 'application/graphml+xml; charset=utf-8').send(toGraphml(curatedToNetwork(resolved)));
      case 'gexf':
        return reply.header('content-type', 'application/gexf+xml; charset=utf-8').send(toGexf(curatedToNetwork(resolved)));
      case 'json':
        return reply.send(curatedToNetwork(resolved));
    }
  });
};

export const curatedPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listCuratedNetworks',
      summary: 'List curated networks',
      description: 'Newest first.',
      tags: TAGS,
      scope: 'networks:read',
      responses: { '200': jsonResponse('The networks.', z.object({ data: z.array(SummarySchema) })), ...problems('401', '403') },
    }),
    post: operation({
      operationId: 'createCuratedNetwork',
      summary: 'Create a curated network',
      description: 'Empty, from a document, or from a graph network (`fromGraph`).',
      tags: TAGS,
      scope: 'networks:write',
      requestBody: jsonBody(CreateSchema),
      responses: { '201': jsonResponse('The network at version 1.', ResolvedSchema), ...problems('400', '401', '403', '422') },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getCuratedNetwork',
      summary: 'A curated network, resolved',
      description: 'The head, or `?version=`. Live versions carry current item metadata; frozen ones their snapshot (CN3).',
      tags: TAGS,
      scope: 'networks:read',
      requestParams: { path: idPath(), query: VersionQuery },
      responses: { '200': jsonResponse('The network.', ResolvedSchema), ...problems('401', '403', '404', '422') },
    }),
    put: operation({
      operationId: 'saveCuratedNetwork',
      summary: 'Save a new version',
      description: 'Every save is a new version on top of the head; `If-Match` with the version refuses a stale save (412).',
      tags: TAGS,
      scope: 'networks:write',
      requestParams: { path: idPath(), header: z.object({ 'if-match': z.string().optional() }) },
      requestBody: jsonBody(SaveSchema),
      responses: { '200': jsonResponse('The network at its new version.', ResolvedSchema), ...problems('400', '401', '403', '404', '412', '422') },
    }),
  },
  [`${BASE}/{id}/freeze`]: {
    post: operation({
      operationId: 'freezeCuratedNetwork',
      summary: 'Freeze a version',
      description: 'The document and the item metadata it shows are fixed for good (CN1).',
      tags: TAGS,
      scope: 'networks:write',
      requestParams: { path: idPath(), query: VersionQuery },
      responses: { '200': jsonResponse('The frozen version.', ResolvedSchema), ...problems('401', '403', '404', '422') },
    }),
  },
  [`${BASE}/{id}/export`]: {
    get: operation({
      operationId: 'exportCuratedNetwork',
      summary: 'Export a curated network',
      description: 'SVG (draft quality), TikZ, GraphML or GEXF with positions, or JSON. For publication, read the GraphML into tidygraph and render with ggraph (ADR-0013).',
      tags: TAGS,
      scope: 'networks:read',
      requestParams: { path: idPath(), query: ExportQuery },
      responses: {
        '200': { description: 'The export.', content: { 'image/svg+xml': { schema: z.string() }, 'text/x-tex': { schema: z.string() }, 'application/graphml+xml': { schema: z.string() } } },
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
};
