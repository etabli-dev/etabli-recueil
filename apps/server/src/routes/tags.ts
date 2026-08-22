/**
 * `/api/v1/tags` — flat, free-text labels (`spec/data-model.md` §4.3).
 *
 * Two things distinguish this from a naive label endpoint.
 *
 * **Renaming is an update, not a create-and-remap** (TG1). A tag row has an identity, and every
 * assignment follows the rename, which is why there is a `PATCH` and no "replace tag X with tag Y"
 * dance for the caller to get wrong.
 *
 * **Merging is a first-class operation** (TG2). Two spellings of the same idea are a fact of every
 * real library, and the loser goes to the trash with a merge record rather than being deleted, so
 * the merge is reversible (P5).
 */
import { API_BASE_PATH, IdSchema, TagCreateSchema, TagSchema, TagUpdateSchema } from '@recueil/schemas';
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
  ItemSummaryPageSchema,
  ItemTagWriteSchema,
  ItemTagPageSchema,
  MergeRequestSchema,
  TagMergeResultSchema,
  TagPageSchema,
  TrashRequestSchema,
} from '../schemas.js';
import { itemTagsFor } from '../queries.js';
import { coerceQuery, parseOrThrow } from '../validate.js';
import { tagToWire } from '../wire.js';

const BASE = `${API_BASE_PATH}/tags`;
const ITEM_BASE = `${API_BASE_PATH}/items`;

const TAG_TAGS = ['Library'] as const;

const ListTagsQuerySchema = z.strictObject({
  ...includeTrashedQuery,
  scheme: z.enum(['manual', 'automatic', 'imported']).optional(),
  prefix: z
    .string()
    .max(255)
    .optional()
    .meta({ description: 'Case-insensitive prefix over the normalised name — the autocomplete.' }),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  withCounts: z.coerce.boolean().optional().meta({ description: 'Include how many live items carry each tag.' }),
  ownerUserId: IdSchema.optional(),
});

export const tagRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  app.get(BASE, { config: { scope: 'tags:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListTagsQuerySchema, coerceQuery(request.query), 'query');
    const options = {
      ...(query.scheme === undefined ? {} : { scheme: query.scheme }),
      ...(query.prefix === undefined ? {} : { prefix: query.prefix }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.ownerUserId === undefined ? {} : { ownerUserId: query.ownerUserId }),
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    };

    // `listWithCounts` is a second query per tag's worth of work; a plain list is the common case.
    const rows = query.withCounts === true
      ? recueil.tags.listWithCounts(options).map((entry) => tagToWire(entry.tag))
      : recueil.tags.list(options).map(tagToWire);

    return sendJson(reply, TagPageSchema, wholeList(rows));
  });

  app.post(BASE, { config: { scope: 'tags:write' } }, async (request, reply) => {
    const body = parseOrThrow(TagCreateSchema, request.body, 'body');
    const row = recueil.tags.create(
      {
        name: body.name,
        ownerUserId: request.principal.userId,
        ...(body.colour === undefined ? {} : { colour: body.colour }),
        ...(body.scheme === undefined ? {} : { scheme: body.scheme }),
        ...(body.position === undefined ? {} : { position: body.position }),
      },
      request.actor,
    );
    reply.header('location', `${BASE}/${row.id}`);
    return sendJson(reply, TagSchema, tagToWire(row), 201);
  });

  app.get(`${BASE}/:id`, { config: { scope: 'tags:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, TagSchema, tagToWire(recueil.tags.get(id, { includeTrashed: true })));
  });

  app.patch(`${BASE}/:id`, { config: { scope: 'tags:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(TagUpdateSchema, request.body, 'body');
    const row = recueil.tags.update(
      id,
      {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.colour === undefined ? {} : { colour: body.colour }),
        ...(body.scheme === undefined ? {} : { scheme: body.scheme }),
        ...(body.position === undefined ? {} : { position: body.position }),
      },
      request.actor,
    );
    return sendJson(reply, TagSchema, tagToWire(row));
  });

  app.get(`${BASE}/:id/items`, { config: { scope: 'tags:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const query = parseOrThrow(z.object(includeTrashedQuery), coerceQuery(request.query), 'query');
    const page = resolvePageParams(request.query);
    recueil.tags.get(id, { includeTrashed: true });

    const result = recueil.tags.listItems(id, {
      ...page,
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    });
    return sendJson(reply, ItemSummaryPageSchema, {
      data: summariseItems(recueil.db, result.data),
      page: pageInfo(result.page),
    });
  });

  app.post(`${BASE}/:id/merge`, { config: { scope: 'tags:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(MergeRequestSchema, request.body, 'body');
    const result = recueil.tags.merge(body.loserId, id, request.actor);
    return sendJson(reply, TagMergeResultSchema, {
      winner: tagToWire(result.winner),
      moved: result.moved,
    });
  });

  app.post(`${BASE}/:id/trash`, { config: { scope: 'tags:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(TrashRequestSchema, request.body ?? {}, 'body');
    return sendJson(
      reply,
      TagSchema,
      tagToWire(
        recueil.tags.trash(id, request.actor, {
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          ...(body.reasonDetail === undefined ? {} : { reasonDetail: body.reasonDetail }),
        }),
      ),
    );
  });

  app.post(`${BASE}/:id/restore`, { config: { scope: 'tags:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, TagSchema, tagToWire(recueil.tags.restore(id, request.actor)));
  });

  /* ---- the tag set of one item ------------------------------------------------------------- */

  app.put(`${ITEM_BASE}/:id/tags`, { config: { scope: 'tags:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(ItemTagWriteSchema, request.body, 'body');
    recueil.library.getItem(id, { includeTrashed: true });

    const wanted = new Set(body.tagNames.map((name) => name.trim()).filter((name) => name !== ''));
    const current = recueil.tags.forItem(id);

    for (const tag of current) {
      if (!wanted.has(tag.name)) recueil.tags.unassign(id, tag.id, request.actor);
    }
    const have = new Set(current.map((tag) => tag.name));
    for (const name of wanted) {
      if (have.has(name)) continue;
      recueil.tags.assignByName(id, name, request.actor, {
        ...(body.source === undefined ? {} : { source: body.source }),
      });
    }

    return sendJson(reply, ItemTagPageSchema, wholeList(itemTagsFor(recueil.db, id)));
  });
};

export const tagPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listTags',
      summary: 'List tags',
      description:
        '`prefix` is the autocomplete: a case-insensitive match over the normalised name. ' +
        '`withCounts=true` adds how many live items carry each tag, at the cost of a second query.',
      tags: TAG_TAGS,
      scope: 'tags:read',
      requestParams: { query: ListTagsQuerySchema },
      responses: { '200': jsonResponse('The tags.', TagPageSchema), ...problems('401', '403', '422') },
    }),
    post: operation({
      operationId: 'createTag',
      summary: 'Create a tag',
      description:
        'Names are unique among live tags per owner, compared after NFKC, casefolding and ' +
        'whitespace collapse. `scheme: "automatic"` is a tag a rule or a resolver added — Zotero ' +
        'tag type 1.',
      tags: TAG_TAGS,
      scope: 'tags:write',
      requestBody: jsonBody(TagCreateSchema),
      responses: { '201': jsonResponse('The tag.', TagSchema), ...problems('401', '403', '409', '422') },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getTag',
      summary: 'Fetch one tag',
      description: 'The row.',
      tags: TAG_TAGS,
      scope: 'tags:read',
      requestParams: { path: idPath() },
      responses: { '200': jsonResponse('The tag.', TagSchema), ...problems('401', '403', '404', '422') },
    }),
    patch: operation({
      operationId: 'updateTag',
      summary: 'Rename or restyle a tag',
      description: 'A rename is an update and the assignments follow it — never a create-and-remap (TG1).',
      tags: TAG_TAGS,
      scope: 'tags:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(TagUpdateSchema),
      responses: {
        '200': jsonResponse('The updated tag.', TagSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/items`]: {
    get: operation({
      operationId: 'listTagItems',
      summary: 'The items carrying a tag',
      description: 'Cursor-paged.',
      tags: TAG_TAGS,
      scope: 'tags:read',
      requestParams: { path: idPath(), query: z.object({ ...pageQuery, ...includeTrashedQuery }) },
      responses: {
        '200': jsonResponse('A page of item summaries.', ItemSummaryPageSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/merge`]: {
    post: operation({
      operationId: 'mergeTag',
      summary: 'Merge another tag into this one',
      description:
        'Every assignment of the loser moves to this tag, and the loser goes to the trash with a ' +
        'merge record rather than being deleted, so the merge is reversible (TG2, P5).',
      tags: TAG_TAGS,
      scope: 'tags:write',
      requestParams: { path: idPath('id', 'The winner: the tag that survives.') },
      requestBody: jsonBody(MergeRequestSchema),
      responses: {
        '200': jsonResponse('The winner and how many assignments moved.', TagMergeResultSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/trash`]: {
    post: operation({
      operationId: 'trashTag',
      summary: 'Move a tag to the trash',
      description: 'The assignments are recorded in the restore payload so a restore puts them back.',
      tags: TAG_TAGS,
      scope: 'tags:write',
      requestParams: { path: idPath() },
      requestBody: { required: false, content: { 'application/json': { schema: TrashRequestSchema } } },
      responses: {
        '200': jsonResponse('The trashed tag.', TagSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/restore`]: {
    post: operation({
      operationId: 'restoreTag',
      summary: 'Restore a tag from the trash',
      description: 'With the assignments it had when it went in.',
      tags: TAG_TAGS,
      scope: 'tags:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The restored tag.', TagSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${ITEM_BASE}/{id}/tags`]: {
    put: operation({
      operationId: 'setItemTags',
      summary: 'Replace the tags on an item',
      description:
        'The list sent is the tag set afterwards: unknown names are created, named tags are ' +
        'assigned, and anything not named is unassigned. `source` records why (P4).',
      tags: TAG_TAGS,
      scope: 'tags:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(ItemTagWriteSchema),
      responses: {
        '200': jsonResponse('The tags as they now stand.', ItemTagPageSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
};
