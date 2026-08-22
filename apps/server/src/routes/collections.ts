/**
 * `/api/v1/collections` — the filing hierarchy, and saved searches (`spec/data-model.md` §4.1).
 *
 * A saved search is a collection whose membership is a query rather than a list. Keeping them one
 * resource is CONCEPT.md §5.7's decision and it pays for itself here: the tree, the item listing,
 * the export selection and the `.bib` feed are one implementation each rather than two.
 *
 * Three rules from the data model are visible in the routes:
 *
 * - **The hierarchy is a forest and a move may not make a cycle** (C1). `POST /{id}/move` is its own
 *   operation rather than a field on the update, because moving rewrites the depth of the whole
 *   subtree (C4) and that is not a field assignment.
 * - **A smart collection has no membership to edit** (C2). Adding items to one is refused, not
 *   ignored.
 * - **Trashing a collection trashes its descendants and never its items** (C3). A collection is
 *   filing, not ownership.
 */
import { API_BASE_PATH, CollectionCreateSchema, CollectionSchema, CollectionUpdateSchema, IdSchema } from '@recueil/schemas';
import type { CollectionNode } from '@recueil/core';
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
  CollectionMembershipChangeSchema,
  CollectionMoveSchema,
  CollectionPageSchema,
  CollectionTreeSchema,
  ItemSummaryPageSchema,
  MembershipResultSchema,
  TrashRequestSchema,
} from '../schemas.js';
import { coerceQuery, parseOrThrow } from '../validate.js';
import { collectionToWire } from '../wire.js';

const BASE = `${API_BASE_PATH}/collections`;

const COLLECTION_TAGS = ['Library'] as const;

const ListCollectionsQuerySchema = z.strictObject({
  ...includeTrashedQuery,
  parentId: IdSchema.optional().meta({ description: 'Only the children of this collection.' }),
  root: z.coerce.boolean().optional().meta({ description: 'Only the roots of the forest.' }),
  kind: z.enum(['manual', 'smart']).optional(),
  ownerUserId: IdSchema.optional(),
});

/** The recursive tree, rendered. Depth is bounded by C4's `depth` column, not by this function. */
const nodeToWire = (node: CollectionNode): { collection: ReturnType<typeof collectionToWire>; children: unknown[] } => ({
  collection: collectionToWire(node.collection),
  children: node.children.map(nodeToWire),
});

export const collectionRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  /* ---- list and tree ---------------------------------------------------------------------- */

  app.get(BASE, { config: { scope: 'collections:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListCollectionsQuerySchema, coerceQuery(request.query), 'query');
    const rows = recueil.collections.list({
      ...(query.root === true ? { parentId: null } : query.parentId === undefined ? {} : { parentId: query.parentId }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.ownerUserId === undefined ? {} : { ownerUserId: query.ownerUserId }),
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    });
    return sendJson(
      reply,
      CollectionPageSchema,
      wholeList(rows.map((row) => collectionToWire(row, { itemCount: recueil.collections.countItems(row.id) }))),
    );
  });

  app.get(`${BASE}/tree`, { config: { scope: 'collections:read' } }, async (request, reply) => {
    const query = parseOrThrow(
      z.object({ ...includeTrashedQuery, kind: z.enum(['manual', 'smart']).optional() }),
      coerceQuery(request.query),
      'query',
    );
    const tree = recueil.collections.tree({
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    });
    return sendJson(reply, CollectionTreeSchema, { data: tree.map(nodeToWire) });
  });

  /* ---- create, read, update --------------------------------------------------------------- */

  app.post(BASE, { config: { scope: 'collections:write' } }, async (request, reply) => {
    const body = parseOrThrow(CollectionCreateSchema, request.body, 'body');
    const row = recueil.collections.create(
      {
        name: body.name,
        ownerUserId: request.principal.userId,
        ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
        ...(body.kind === undefined ? {} : { kind: body.kind }),
        ...(body.query === undefined ? {} : { query: body.query as Record<string, unknown> | null }),
        ...(body.queryBackend === undefined ? {} : { queryBackend: body.queryBackend }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.colour === undefined ? {} : { colour: body.colour }),
        ...(body.position === undefined ? {} : { position: body.position }),
      },
      request.actor,
    );
    reply.header('location', `${BASE}/${row.id}`);
    return sendJson(reply, CollectionSchema, collectionToWire(row), 201);
  });

  app.get(`${BASE}/:id`, { config: { scope: 'collections:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const row = recueil.collections.get(id, { includeTrashed: true });
    return sendJson(
      reply,
      CollectionSchema,
      collectionToWire(row, { itemCount: recueil.collections.countItems(id) }),
    );
  });

  app.patch(`${BASE}/:id`, { config: { scope: 'collections:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(CollectionUpdateSchema, request.body, 'body');
    const row = recueil.collections.update(
      id,
      {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.colour === undefined ? {} : { colour: body.colour }),
        ...(body.position === undefined ? {} : { position: body.position }),
        ...(body.query === undefined ? {} : { query: body.query as Record<string, unknown> | null }),
        ...(body.queryBackend === undefined ? {} : { queryBackend: body.queryBackend }),
      },
      request.actor,
    );
    return sendJson(reply, CollectionSchema, collectionToWire(row));
  });

  app.post(`${BASE}/:id/move`, { config: { scope: 'collections:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(CollectionMoveSchema, request.body, 'body');
    return sendJson(
      reply,
      CollectionSchema,
      collectionToWire(recueil.collections.move(id, body.parentId, request.actor)),
    );
  });

  /* ---- membership -------------------------------------------------------------------------- */

  app.get(`${BASE}/:id/items`, { config: { scope: 'collections:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const query = parseOrThrow(z.object(includeTrashedQuery), coerceQuery(request.query), 'query');
    const page = resolvePageParams(request.query);
    recueil.collections.get(id, { includeTrashed: true });

    const result = recueil.collections.listItems(id, {
      ...page,
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    });
    return sendJson(reply, ItemSummaryPageSchema, {
      data: summariseItems(recueil.db, result.data),
      page: pageInfo(result.page, recueil.collections.countItems(id)),
    });
  });

  app.post(`${BASE}/:id/items`, { config: { scope: 'collections:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(CollectionMembershipChangeSchema, request.body, 'body');
    const changed = recueil.collections.addItems(id, body.itemIds, request.actor, {
      ...(body.source === undefined ? {} : { source: body.source }),
    });
    return sendJson(reply, MembershipResultSchema, { collectionId: id, changed });
  });

  app.delete(`${BASE}/:id/items`, { config: { scope: 'collections:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(CollectionMembershipChangeSchema, request.body, 'body');
    const changed = recueil.collections.removeItems(id, body.itemIds, request.actor);
    return sendJson(reply, MembershipResultSchema, { collectionId: id, changed });
  });

  /* ---- trash and restore -------------------------------------------------------------------- */

  app.post(`${BASE}/:id/trash`, { config: { scope: 'collections:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(TrashRequestSchema, request.body ?? {}, 'body');
    return sendJson(
      reply,
      CollectionSchema,
      collectionToWire(
        recueil.collections.trash(id, request.actor, {
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          ...(body.reasonDetail === undefined ? {} : { reasonDetail: body.reasonDetail }),
        }),
      ),
    );
  });

  app.post(`${BASE}/:id/restore`, { config: { scope: 'collections:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(
      reply,
      CollectionSchema,
      collectionToWire(recueil.collections.restore(id, request.actor)),
    );
  });
};

export const collectionPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listCollections',
      summary: 'List collections',
      description:
        'Flat, with `itemCount` on each. `root=true` gives the top of the forest; `parentId` gives ' +
        'one level of children. For the whole shape at once use `GET /collections/tree`.',
      tags: COLLECTION_TAGS,
      scope: 'collections:read',
      requestParams: { query: ListCollectionsQuerySchema },
      responses: {
        '200': jsonResponse('The collections.', CollectionPageSchema),
        ...problems('401', '403', '422'),
      },
    }),
    post: operation({
      operationId: 'createCollection',
      summary: 'Create a collection or a saved search',
      description:
        'A saved search is `kind: "smart"` plus a `query`; a manual collection is a list and must ' +
        'carry no query (C2, `ck_collections_smart`). Sibling names are unique among live ' +
        'collections under the same parent.',
      tags: COLLECTION_TAGS,
      scope: 'collections:write',
      requestBody: jsonBody(CollectionCreateSchema),
      responses: {
        '201': jsonResponse('The collection.', CollectionSchema),
        ...problems('401', '403', '409', '422'),
      },
    }),
  },
  [`${BASE}/tree`]: {
    get: operation({
      operationId: 'getCollectionTree',
      summary: 'The whole hierarchy',
      description: 'Roots with their children nested — the shape a sidebar renders, in one request.',
      tags: COLLECTION_TAGS,
      scope: 'collections:read',
      requestParams: {
        query: z.object({ ...includeTrashedQuery, kind: z.enum(['manual', 'smart']).optional() }),
      },
      responses: {
        '200': jsonResponse('The tree.', CollectionTreeSchema),
        ...problems('401', '403', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getCollection',
      summary: 'Fetch one collection',
      description: 'With its live member count.',
      tags: COLLECTION_TAGS,
      scope: 'collections:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The collection.', CollectionSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
    patch: operation({
      operationId: 'updateCollection',
      summary: 'Rename or restyle a collection',
      description: 'The parent is not here: moving rewrites the subtree depth and is `POST /{id}/move` (C4).',
      tags: COLLECTION_TAGS,
      scope: 'collections:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(CollectionUpdateSchema),
      responses: {
        '200': jsonResponse('The updated collection.', CollectionSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/move`]: {
    post: operation({
      operationId: 'moveCollection',
      summary: 'Re-parent a collection',
      description:
        'Rewrites the denormalised depth of the whole subtree (C4). A move that would make a cycle ' +
        '— into itself or into one of its own descendants — is refused with 409 (C1).',
      tags: COLLECTION_TAGS,
      scope: 'collections:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(CollectionMoveSchema),
      responses: {
        '200': jsonResponse('The moved collection.', CollectionSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/items`]: {
    get: operation({
      operationId: 'listCollectionItems',
      summary: 'The items in a collection',
      description: 'Cursor-paged, like every other item listing.',
      tags: COLLECTION_TAGS,
      scope: 'collections:read',
      requestParams: { path: idPath(), query: z.object({ ...pageQuery, ...includeTrashedQuery }) },
      responses: {
        '200': jsonResponse('A page of item summaries.', ItemSummaryPageSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
    post: operation({
      operationId: 'addCollectionItems',
      summary: 'File items into a collection',
      description:
        'Idempotent: an item already filed here is not added twice and is not counted as changed. ' +
        'Refused on a smart collection, whose membership is its query (C2).',
      tags: COLLECTION_TAGS,
      scope: 'collections:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(CollectionMembershipChangeSchema),
      responses: {
        '200': jsonResponse('How many memberships moved.', MembershipResultSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
    delete: operation({
      operationId: 'removeCollectionItems',
      summary: 'Remove items from a collection',
      description: 'Unfiles them. The items themselves are untouched — a collection is filing, not ownership (C3).',
      tags: COLLECTION_TAGS,
      scope: 'collections:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(CollectionMembershipChangeSchema),
      responses: {
        '200': jsonResponse('How many memberships moved.', MembershipResultSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/trash`]: {
    post: operation({
      operationId: 'trashCollection',
      summary: 'Move a collection to the trash',
      description: 'Its descendants go with it, in one trash group. Its items do not (C3).',
      tags: COLLECTION_TAGS,
      scope: 'collections:write',
      requestParams: { path: idPath() },
      requestBody: { required: false, content: { 'application/json': { schema: TrashRequestSchema } } },
      responses: {
        '200': jsonResponse('The trashed collection.', CollectionSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/restore`]: {
    post: operation({
      operationId: 'restoreCollection',
      summary: 'Restore a collection from the trash',
      description: 'Brings back the subtree that went into the bin with it.',
      tags: COLLECTION_TAGS,
      scope: 'collections:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The restored collection.', CollectionSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
};
