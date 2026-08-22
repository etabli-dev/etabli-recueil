/**
 * `/api/v1/creators` — people and organisations as entities (`spec/data-model.md` §5.1).
 *
 * A creator is a record, not a string on an item. That is what makes "everything by this author" a
 * query rather than a fuzzy match, and it is what the disambiguation state exists for.
 *
 * The merge endpoint carries the rule worth knowing: **two creators with different non-null ORCIDs
 * are never merged** (CR2, P3). Two ORCIDs are two claims by two registries that these are
 * different people, and an automatic merge over that is precisely the "guess" P3 forbids — the
 * `author_consistency` check flags the conflict instead.
 */
import { API_BASE_PATH, CreatorCreateSchema, CreatorSchema, CreatorUpdateSchema, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { pageInfo, resolvePageParams, sendJson, wholeList } from '../http.js';
import {
  idPath,
  includeTrashedQuery,
  jsonBody,
  jsonResponse,
  operation,
  pageQuery,
  problems,
} from '../openapi-kit.js';
import { summariseItems } from '../queries.js';
import {
  CreatorMergeResultSchema,
  CreatorPageSchema,
  ItemSummaryPageSchema,
  MergeRequestSchema,
  TrashRequestSchema,
} from '../schemas.js';
import { coerceQuery, parseOrThrow } from '../validate.js';
import { creatorToWire } from '../wire.js';

const BASE = `${API_BASE_PATH}/creators`;

const CREATOR_TAGS = ['Library'] as const;

const ListCreatorsQuerySchema = z.strictObject({
  ...includeTrashedQuery,
  kind: z.enum(['person', 'organisation']).optional(),
  prefix: z
    .string()
    .max(255)
    .optional()
    .meta({ description: 'Case-insensitive prefix over the sort name — the creator autocomplete.' }),
  disambiguationStatus: z.enum(['unreviewed', 'confirmed', 'ambiguous', 'merged']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const CREATOR_WRITABLE = [
  'kind',
  'familyName',
  'givenName',
  'namePrefix',
  'nameSuffix',
  'literalName',
  'initials',
  'orcid',
  'openalexAuthorId',
  'semanticScholarAuthorId',
  'scopusAuthorId',
  'researcherId',
  'isni',
  'viaf',
  'ror',
  'wikidataId',
] as const;

/** Pick the fields the service takes, dropping anything the contract carries and it does not. */
const toCreatorInput = (body: Record<string, unknown>): Record<string, unknown> => {
  const input: Record<string, unknown> = {};
  for (const key of CREATOR_WRITABLE) {
    if (body[key] !== undefined) input[key] = body[key];
  }
  if (Array.isArray(body.nameVariants)) input.nameVariants = body.nameVariants;
  return input;
};

export const creatorRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  app.get(BASE, { config: { scope: 'creators:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListCreatorsQuerySchema, coerceQuery(request.query), 'query');
    const rows = recueil.creators.list({
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.prefix === undefined ? {} : { prefix: query.prefix }),
      ...(query.disambiguationStatus === undefined ? {} : { disambiguationStatus: query.disambiguationStatus }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    });
    return sendJson(reply, CreatorPageSchema, wholeList(rows.map(creatorToWire)));
  });

  app.post(BASE, { config: { scope: 'creators:write' } }, async (request, reply) => {
    const body = parseOrThrow(CreatorCreateSchema, request.body, 'body');
    const row = recueil.creators.create(
      toCreatorInput(body as Record<string, unknown>) as Parameters<typeof recueil.creators.create>[0],
      request.actor,
    );
    reply.header('location', `${BASE}/${row.id}`);
    return sendJson(reply, CreatorSchema, creatorToWire(row), 201);
  });

  app.get(`${BASE}/:id`, { config: { scope: 'creators:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, CreatorSchema, creatorToWire(recueil.creators.get(id, { includeTrashed: true })));
  });

  app.patch(`${BASE}/:id`, { config: { scope: 'creators:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(CreatorUpdateSchema, request.body, 'body');
    const row = recueil.creators.update(
      id,
      toCreatorInput(body as Record<string, unknown>) as Parameters<typeof recueil.creators.update>[1],
      request.actor,
    );
    return sendJson(reply, CreatorSchema, creatorToWire(row));
  });

  app.get(`${BASE}/:id/works`, { config: { scope: 'creators:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const query = parseOrThrow(
      z.object({ ...includeTrashedQuery, role: z.string().max(32).optional() }),
      coerceQuery(request.query),
      'query',
    );
    const page = resolvePageParams(request.query);
    recueil.creators.get(id, { includeTrashed: true });

    const listOptions: Parameters<typeof recueil.creators.listWorks>[1] = {
      ...page,
      ...(query.role === undefined ? {} : { role: query.role as NonNullable<typeof listOptions>['role'] }),
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    };
    const result = recueil.creators.listWorks(id, listOptions);
    return sendJson(reply, ItemSummaryPageSchema, {
      data: summariseItems(recueil.db, result.data),
      page: pageInfo(result.page),
    });
  });

  app.post(`${BASE}/:id/merge`, { config: { scope: 'creators:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(MergeRequestSchema, request.body, 'body');
    const result = recueil.creators.merge(body.loserId, id, request.actor);
    return sendJson(reply, CreatorMergeResultSchema, {
      winner: creatorToWire(result.winner),
      movedAppearances: result.movedAppearances,
    });
  });

  app.post(`${BASE}/:id/trash`, { config: { scope: 'creators:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(TrashRequestSchema, request.body ?? {}, 'body');
    return sendJson(
      reply,
      CreatorSchema,
      creatorToWire(
        recueil.creators.trash(id, request.actor, {
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          ...(body.reasonDetail === undefined ? {} : { reasonDetail: body.reasonDetail }),
        }),
      ),
    );
  });

  app.post(`${BASE}/:id/restore`, { config: { scope: 'creators:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, CreatorSchema, creatorToWire(recueil.creators.restore(id, request.actor)));
  });
};

export const creatorPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listCreators',
      summary: 'List creators',
      description:
        '`prefix` matches the sort name (`family, given`, normalised), which is both the ' +
        'autocomplete and the deduplication blocking key.',
      tags: CREATOR_TAGS,
      scope: 'creators:read',
      requestParams: { query: ListCreatorsQuerySchema },
      responses: { '200': jsonResponse('The creators.', CreatorPageSchema), ...problems('401', '403', '422') },
    }),
    post: operation({
      operationId: 'createCreator',
      summary: 'Create a creator',
      description:
        'A person needs a `familyName` or a `literalName`; an organisation is named by its ' +
        '`literalName`. The display name, sort name and initials are rendered once, on write.',
      tags: CREATOR_TAGS,
      scope: 'creators:write',
      requestBody: jsonBody(CreatorCreateSchema),
      responses: { '201': jsonResponse('The creator.', CreatorSchema), ...problems('401', '403', '409', '422') },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getCreator',
      summary: 'Fetch one creator',
      description: 'With every external identifier and the disambiguation state.',
      tags: CREATOR_TAGS,
      scope: 'creators:read',
      requestParams: { path: idPath() },
      responses: { '200': jsonResponse('The creator.', CreatorSchema), ...problems('401', '403', '404', '422') },
    }),
    patch: operation({
      operationId: 'updateCreator',
      summary: 'Update a creator',
      description: 'The rendered display name, sort name and initials are recomputed from the parts.',
      tags: CREATOR_TAGS,
      scope: 'creators:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(CreatorUpdateSchema),
      responses: {
        '200': jsonResponse('The updated creator.', CreatorSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/works`]: {
    get: operation({
      operationId: 'listCreatorWorks',
      summary: 'Everything by this creator',
      description: 'Cursor-paged; `role` narrows to one kind of appearance (author, editor, …).',
      tags: CREATOR_TAGS,
      scope: 'creators:read',
      requestParams: {
        path: idPath(),
        query: z.object({ ...pageQuery, ...includeTrashedQuery, role: z.string().max(32).optional() }),
      },
      responses: {
        '200': jsonResponse('A page of item summaries.', ItemSummaryPageSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/merge`]: {
    post: operation({
      operationId: 'mergeCreator',
      summary: 'Merge another creator into this one',
      description:
        'Every appearance moves to this creator and the loser goes to the trash, reversibly. ' +
        '**Refused when both carry different non-null ORCIDs** (CR2): that is two registries ' +
        'saying these are two people, and merging over it would be a guess (P3).',
      tags: CREATOR_TAGS,
      scope: 'creators:write',
      requestParams: { path: idPath('id', 'The winner: the creator that survives.') },
      requestBody: jsonBody(MergeRequestSchema),
      responses: {
        '200': jsonResponse('The winner and how many appearances moved.', CreatorMergeResultSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/trash`]: {
    post: operation({
      operationId: 'trashCreator',
      summary: 'Move a creator to the trash',
      description: 'Refused while the creator still appears on a live item: the appearance would dangle.',
      tags: CREATOR_TAGS,
      scope: 'creators:write',
      requestParams: { path: idPath() },
      requestBody: { required: false, content: { 'application/json': { schema: TrashRequestSchema } } },
      responses: {
        '200': jsonResponse('The trashed creator.', CreatorSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/restore`]: {
    post: operation({
      operationId: 'restoreCreator',
      summary: 'Restore a creator from the trash',
      description: 'A row update and an audit row.',
      tags: CREATOR_TAGS,
      scope: 'creators:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The restored creator.', CreatorSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
};
