/**
 * `/api/v1/analytics` and `/api/v1/graph` — the library as data for R, Python and the maps
 * (CONCEPT §5.8, §5.12). The R and Python packages are clients of exactly these routes.
 */
import { analyticsTables, describeNetwork, toCsv, toGexf, toGraphml, toVosviewerJson, toWosPlaintext } from '@recueil/analytics';
import type { Network } from '@recueil/core';
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { resolveSelection } from '../export.js';
import { idPath, jsonResponse, operation, problems } from '../openapi-kit.js';
import { coerceQuery, parseOrThrow } from '../validate.js';

const ANALYTICS = `${API_BASE_PATH}/analytics`;
const GRAPH = `${API_BASE_PATH}/graph`;
const TAGS = ['Analytics'] as const;
const TABLES = ['works', 'creators', 'works_creators', 'terms', 'works_terms', 'edges', 'metrics'] as const;
const NETWORKS = ['citations', 'local', 'co-citation', 'coupling'] as const;

const TableParams = z.object({ table: z.enum(TABLES) });
const SelectionQuery = z.strictObject({
  collectionId: IdSchema.optional().meta({ description: 'Only this collection (or saved search).' }),
  q: z.string().max(512).optional().meta({ description: 'Only items matching this full-text query.' }),
  token: z.string().max(256).optional(),
});
const NetworkQuery = z.strictObject({
  network: z.enum(NETWORKS).optional().meta({ description: 'Default `citations`; `local` keeps only citations between library items.' }),
  format: z.enum(['json', 'graphml', 'gexf', 'vosviewer']).optional().meta({ description: 'Default `json`.' }),
  token: z.string().max(256).optional(),
});

const CoverageSchema = z
  .object({
    items: z.number().int(),
    withReferences: z.number().int(),
    bySource: z.array(z.object({ source: z.string(), items: z.number().int(), edges: z.number().int(), lastFetchedAt: z.string().nullable() })),
  })
  .meta({ id: 'GraphCoverage', title: 'GraphCoverage', description: 'How many items have reference data, from which sources, fetched when (P4).' });

const ShadowWorkSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    doi: z.string().nullable(),
    issuedYear: z.number().int().nullable(),
    containerTitle: z.string().nullable(),
    seenCount: z.number().int(),
    citedByCount: z.number().int().nullable(),
  })
  .meta({ id: 'ShadowWork', title: 'ShadowWork', description: 'A work the library cites that is not in it (SW1).' });

const NetworkJsonSchema = z
  .object({
    nodes: z.array(z.object({ id: z.string(), label: z.string(), type: z.string(), year: z.number().nullable(), venue: z.string().nullable(), doi: z.string().nullable(), citedBy: z.number().nullable(), inLibrary: z.boolean() })),
    edges: z.array(z.object({ source: z.string(), target: z.string(), type: z.string(), directed: z.boolean(), weight: z.number(), provenance: z.string() })),
    generatedAt: z.string(),
    description: z.string(),
  })
  .meta({ id: 'GraphNetwork', title: 'GraphNetwork' });

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  app.get(`${ANALYTICS}/tables/:table.csv`, { config: { scope: 'analytics:read' } }, async (request, reply) => {
    const { table } = parseOrThrow(TableParams, request.params, 'path');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${table}.csv"`)
      .send(toCsv(analyticsTables(recueil, table)));
  });

  app.get(`${ANALYTICS}/wos.txt`, { config: { scope: 'analytics:read' } }, async (request, reply) => {
    const query = parseOrThrow(SelectionQuery, coerceQuery(request.query), 'query');
    const ids =
      query.collectionId === undefined && query.q === undefined
        ? recueil.library.listItems({ limit: 10_000 }).data.map((row) => row.id)
        : resolveSelection(recueil, { ...(query.collectionId === undefined ? {} : { collectionId: query.collectionId }), ...(query.q === undefined ? {} : { q: query.q }) });
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', 'attachment; filename="savedrecs.txt"')
      .send(toWosPlaintext(recueil, ids));
  });

  app.get(`${GRAPH}/network`, { config: { scope: 'analytics:read' } }, async (request, reply) => {
    const query = parseOrThrow(NetworkQuery, coerceQuery(request.query), 'query');
    const name = query.network ?? 'citations';
    const raw: Network =
      name === 'citations'
        ? recueil.graph.citationNetwork()
        : name === 'local'
          ? recueil.graph.citationNetwork({ localOnly: true })
          : recueil.graph.derivedNetwork(name === 'co-citation' ? 'co_cited' : 'coupled');
    const network = describeNetwork(recueil, raw, `${name} network`);
    switch (query.format ?? 'json') {
      case 'graphml':
        return reply.header('content-type', 'application/graphml+xml; charset=utf-8').send(toGraphml(network));
      case 'gexf':
        return reply.header('content-type', 'application/gexf+xml; charset=utf-8').send(toGexf(network));
      case 'vosviewer':
        return reply.header('content-type', 'application/json; charset=utf-8').send(toVosviewerJson(network));
      default:
        return reply.send(NetworkJsonSchema.parse(network));
    }
  });

  app.get(`${GRAPH}/coverage`, { config: { scope: 'analytics:read' } }, async (_request, reply) => reply.send(CoverageSchema.parse(recueil.graph.coverage())));

  app.get(`${GRAPH}/shadow-works`, { config: { scope: 'analytics:read' } }, async (request, reply) => {
    const { limit } = parseOrThrow(z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }), coerceQuery(request.query), 'query');
    const rows = recueil.graph.topShadowWorks(limit ?? 50);
    return reply.send({ data: rows.map((row) => ShadowWorkSchema.parse({ id: row.id, title: row.title, doi: row.doi, issuedYear: row.issuedYear, containerTitle: row.containerTitle, seenCount: row.seenCount, citedByCount: row.citedByCount })) });
  });

  app.post(`${GRAPH}/shadow-works/:id/promote`, { config: { scope: 'items:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const itemId = recueil.graph.promoteShadowWork(id, request.actor);
    return reply.code(201).send({ itemId });
  });
};

const text = (description: string, contentType: string) => ({ description, content: { [contentType]: { schema: z.string() } } });

export const analyticsPaths: ZodOpenApiPathsObject = {
  [`${ANALYTICS}/tables/{table}.csv`]: {
    get: operation({
      operationId: 'getAnalyticsTable',
      summary: 'One analytics table as CSV',
      description: 'works, creators, works_creators, terms, works_terms, edges or metrics — flat, stable columns for R, Python and DuckDB (ADR-0008).',
      tags: TAGS,
      scope: 'analytics:read',
      requestParams: { path: TableParams },
      responses: { '200': text('The table, RFC 4180 CSV with a header row.', 'text/csv'), ...problems('401', '403', '422') },
    }),
  },
  [`${ANALYTICS}/wos.txt`]: {
    get: operation({
      operationId: 'getWosPlaintext',
      summary: 'The library as Web of Science plain text',
      description: 'What bibliometrix `convert2df(dbsource = "wos", format = "plaintext")` and biblioshiny read, with the cited references from the graph.',
      tags: TAGS,
      scope: 'analytics:read',
      requestParams: { query: SelectionQuery },
      responses: { '200': text('Web of Science plain text.', 'text/plain'), ...problems('401', '403', '404', '422') },
    }),
  },
  [`${GRAPH}/network`]: {
    get: operation({
      operationId: 'getGraphNetwork',
      summary: 'A network: citations, local citations, co-citation or coupling',
      description: 'As JSON, GraphML (igraph, tidygraph), GEXF (Gephi) or VOSviewer JSON. Derived networks come from the latest `recueil graph derive` run.',
      tags: TAGS,
      scope: 'analytics:read',
      requestParams: { query: NetworkQuery },
      responses: {
        '200': {
          description: 'The network.',
          content: {
            'application/json': { schema: NetworkJsonSchema },
            'application/graphml+xml': { schema: z.string() },
            'application/gexf+xml': { schema: z.string() },
          },
        },
        ...problems('401', '403', '422'),
      },
    }),
  },
  [`${GRAPH}/coverage`]: {
    get: operation({
      operationId: 'getGraphCoverage',
      summary: 'Reference-data coverage',
      description: 'The statistic every map shows beside it (P4).',
      tags: TAGS,
      scope: 'analytics:read',
      responses: { '200': jsonResponse('Coverage.', CoverageSchema), ...problems('401', '403') },
    }),
  },
  [`${GRAPH}/shadow-works`]: {
    get: operation({
      operationId: 'listShadowWorks',
      summary: 'The most-cited works not in the library',
      description: 'Ranked by how often the library cites them: what to read next.',
      tags: TAGS,
      scope: 'analytics:read',
      requestParams: { query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }) },
      responses: { '200': jsonResponse('Shadow works.', z.object({ data: z.array(ShadowWorkSchema) })), ...problems('401', '403', '422') },
    }),
  },
  [`${GRAPH}/shadow-works/{id}/promote`]: {
    post: operation({
      operationId: 'promoteShadowWork',
      summary: 'Bring a cited work into the library',
      description: 'Creates an item and rewrites the graph node in place, so no citation edge moves (GN1, SW2).',
      tags: TAGS,
      scope: 'items:write',
      requestParams: { path: idPath() },
      responses: { '201': jsonResponse('The new item id.', z.object({ itemId: z.string() })), ...problems('401', '403', '404', '422') },
    }),
  },
};
