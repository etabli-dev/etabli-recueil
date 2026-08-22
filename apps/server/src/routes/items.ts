/**
 * `/api/v1/items` — the library record, and everything that hangs off one.
 *
 * The shape of this module is the shape of the data model. An item is the thing a person thinks of
 * as "an entry" (`spec/data-model.md` §3.4); its facets, creators, tags, collection memberships,
 * attachments, notes and custom-field values are sub-resources of it, and each is addressed under
 * the item rather than in a flat namespace so that a client never has to construct a filter to ask
 * "what is on this record".
 *
 * Four decisions are worth reading before the code.
 *
 * **Lists are summaries; a fetch is the whole record.** `GET /items` returns `ItemSummary` rows —
 * exactly enough to render a library table without joining a facet (I3) — and `GET /items/{id}`
 * returns everything, expanded. A list that returned whole items would fetch six tables per row for
 * a view that shows five columns.
 *
 * **The ETag is the version.** `items.version` is optimistic concurrency (§1.7), so it is what the
 * ETag carries and what `If-Match` checks. A stale conditional write is a 412 with the current
 * version in the problem document, and nothing is merged (P1).
 *
 * **A facet write is its own operation.** `PATCH /items/{id}` is a person editing; `PATCH
 * /items/{id}/bibliographic` is a resolver writing with a stamp, and it returns what the manual
 * locks refused (P4-4). Folding the second into the first would make "did my enrichment run get
 * applied?" unanswerable.
 *
 * **Bulk writes are idempotent by key.** `POST /items/bulk` stores its result against
 * `api:<token>:<key>` in the `jobs` table and replays it verbatim (IK2), which is what makes a
 * retried mobile upload or a flaky CLI run safe (P9).
 */
import { ValidationError } from '@recueil/core';
import type { Actor, CreateItemInput, ItemRecord, Recueil, UpdateItemInput } from '@recueil/core';
import {
  API_BASE_PATH,
  IdSchema,
  ItemCreateSchema,
  ItemSchema,
  ItemUpdateSchema,
  PublicIdSchema,
  bulkOperationOf,
  bulkRequestOf,
  BulkResultSchema,
  IdempotencyKeySchema,
} from '@recueil/schemas';
import type { BulkResult, BulkOperationOutcome } from '@recueil/schemas';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import {
  idempotencyKeyHeader,
  ifMatchVersion,
  pageInfo,
  resolvePageParams,
  sendJson,
  versionEtag,
  wholeList,
} from '../http.js';
import { loadItemView, renderItemView } from '../item-view.js';
import { replayOrRecord } from '../idempotency.js';
import {
  idPath,
  includeTrashedQuery,
  jsonBody,
  jsonResponse,
  operation,
  pageQuery,
  problems,
  publicIdPath,
} from '../openapi-kit.js';
import { toProblem } from '../problem.js';
import { attachmentsFor, itemTagsFor, noteIdsFor, summariseItems } from '../queries.js';
import {
  publishItemCreated,
  publishItemRestored,
  publishItemTrashed,
  publishItemUpdated,
} from '../publish.js';
import {
  AttachmentPageSchema,
  FacetWriteRequestSchema,
  FacetWriteResultSchema,
  FieldLockRequestSchema,
  ItemCreatorPageSchema,
  ItemCreatorWriteSchema,
  ItemProvenanceSchema,
  ItemSummaryPageSchema,
  ItemTagPageSchema,
  NotePageSchema,
  OfficeWriteRequestSchema,
  TrashRequestSchema,
} from '../schemas.js';
import { coerceQuery, parseOrThrow } from '../validate.js';
import { attachmentToWire, itemCreatorToWire, noteToWire, provenanceMapToWire } from '../wire.js';

const BASE = `${API_BASE_PATH}/items`;

/* -------------------------------------------------------------------------------------------- */
/* Query schemas                                                                                   */
/* -------------------------------------------------------------------------------------------- */

const ListItemsQuerySchema = z.strictObject({
  ...pageQuery,
  ...includeTrashedQuery,
  itemType: z.string().max(64).optional().meta({ description: 'Exact match on the item type slug.' }),
  collectionId: IdSchema.optional().meta({ description: 'Only items filed in this collection.' }),
  tagId: IdSchema.optional().meta({ description: 'Only items carrying this tag.' }),
  q: z
    .string()
    .max(2048)
    .optional()
    .meta({
      description:
        "Full-text filter, in Recueil's query syntax (`title:trial -retracted`). Folded into the " +
        'SQL query, so it is a filter rather than a ranked search; use `/search` for ranking.',
    }),
  ownerUserId: IdSchema.optional(),
});

/* -------------------------------------------------------------------------------------------- */
/* Helpers                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * Turn a contract-shaped create into the service's input.
 *
 * The two shapes are nearly the same and deliberately not identical: `ItemCreate` carries
 * `tagNames` and `collectionIds`, which are separate tables and therefore separate service calls,
 * and the facets arrive as `Partial<...>` objects the service takes verbatim.
 */
const toCreateInput = (body: z.infer<typeof ItemCreateSchema>, ownerUserId: string): CreateItemInput => ({
  itemType: body.itemType,
  ownerUserId,
  ...(body.title === undefined ? {} : { title: body.title }),
  ...(body.extra === undefined ? {} : { extra: body.extra }),
  ...(body.sourceSystem === undefined ? {} : { sourceSystem: body.sourceSystem }),
  ...(body.sourceId === undefined ? {} : { sourceId: body.sourceId }),
  ...(body.dateAdded === undefined ? {} : { dateAdded: body.dateAdded }),
  ...(body.bibliographic === undefined ? {} : { bibliographic: body.bibliographic as CreateItemInput['bibliographic'] }),
  ...(body.office === undefined ? {} : { office: body.office as CreateItemInput['office'] }),
});

/**
 * Keep `items.title` and `item_bibliographic.title` the same value (I3).
 *
 * The mirror is one-directional in `packages/core`: when the facet exists, the item title *is* the
 * facet title, so a patch that sets `title` and nothing else would be silently overwritten by the
 * facet's own value. A caller who writes the display title of a scholarly item means to change its
 * title, so the write is carried into the facet — which also means it takes provenance and a lock,
 * exactly as typing in the title field should (P4-1).
 */
const withMirroredTitle = (
  recueil: Recueil,
  id: string,
  body: z.infer<typeof ItemUpdateSchema>,
): UpdateItemInput => {
  const patch = toUpdateInput(body);
  if (body.title === undefined || body.bibliographic?.title !== undefined) return patch;

  const record = recueil.library.getItem(id, { includeTrashed: true });
  if (record.bibliographic === null) return patch;

  return { ...patch, bibliographic: { ...(patch.bibliographic ?? {}), title: body.title ?? null } };
};

const toUpdateInput = (body: z.infer<typeof ItemUpdateSchema>): UpdateItemInput => ({
  ...(body.itemType === undefined ? {} : { itemType: body.itemType }),
  ...(body.title === undefined ? {} : { title: body.title }),
  ...(body.extra === undefined ? {} : { extra: body.extra }),
  ...(body.sourceSystem === undefined ? {} : { sourceSystem: body.sourceSystem }),
  ...(body.sourceId === undefined ? {} : { sourceId: body.sourceId }),
  ...(body.bibliographic === undefined ? {} : { bibliographic: body.bibliographic as UpdateItemInput['bibliographic'] }),
  ...(body.office === undefined ? {} : { office: body.office as UpdateItemInput['office'] }),
});

/**
 * The parts of a create that are not the item row: tags by name, and collection membership.
 *
 * Done after the item exists rather than inside `createItem`, because both are many-to-many tables
 * with their own services and their own audit rows. The item is created either way; a tag that
 * cannot be applied does not un-create it.
 */
const applyItemAssociations = (
  recueil: Recueil,
  itemId: string,
  body: { tagNames?: readonly string[]; collectionIds?: readonly string[]; creators?: readonly unknown[] },
  actor: Actor,
): void => {
  for (const name of body.tagNames ?? []) {
    recueil.tags.assignByName(itemId, name, actor);
  }
  for (const collectionId of body.collectionIds ?? []) {
    recueil.collections.addItems(collectionId, [itemId], actor);
  }
  const creators = (body.creators ?? []) as { creatorId?: string }[];
  const resolvable = creators.filter((entry): entry is { creatorId: string } => typeof entry.creatorId === 'string');
  if (resolvable.length !== creators.length) {
    // `ItemCreatorInput` allows an inline creator to be resolved or created. Resolving a person
    // from a name is identity resolution (CONCEPT.md §5.2), which belongs to the creator service
    // and does not exist yet; refusing is honest, silently dropping the entry would not be.
    throw new ValidationError(
      'Inline creators are not resolved yet: send `creatorId`, creating the creator first with ' +
        'POST /api/v1/creators.',
      { itemId },
    );
  }
  if (resolvable.length > 0) {
    recueil.creators.setItemCreators(
      itemId,
      resolvable.map((entry) => entry as Parameters<Recueil['creators']['setItemCreators']>[1][number]),
      actor,
    );
  }
};

/** The ids that went into the trash alongside an item, for the `item.trashed` cascade block. */
const cascadeOf = (
  recueil: Recueil,
  itemId: string,
): { attachmentIds: string[]; noteIds: string[]; annotationIds: string[] } => ({
  attachmentIds: attachmentsFor(recueil.db, itemId, { includeTrashed: true }).map((row) => row.id),
  noteIds: noteIdsFor(recueil.db, itemId),
  // Annotations arrive with the reader in Phase 4; an empty list is the truth today.
  annotationIds: [],
});

const itemIdParam = (request: FastifyRequest): string =>
  parseOrThrow(z.object({ id: IdSchema }), request.params, 'path').id;

/* -------------------------------------------------------------------------------------------- */
/* Routes                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export const itemRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil, events } = app.recueil;

  /* ---- list ---------------------------------------------------------------------------- */

  app.get(BASE, { config: { scope: 'items:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListItemsQuerySchema, coerceQuery(request.query), 'query');
    const page = resolvePageParams(request.query);

    const filters = {
      ...(query.itemType === undefined ? {} : { itemType: query.itemType }),
      ...(query.collectionId === undefined ? {} : { collectionId: query.collectionId }),
      ...(query.tagId === undefined ? {} : { tagId: query.tagId }),
      ...(query.q === undefined ? {} : { text: query.q }),
      ...(query.ownerUserId === undefined ? {} : { ownerUserId: query.ownerUserId }),
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    };

    const result = recueil.library.listItems({ ...filters, ...page });

    return sendJson(reply, ItemSummaryPageSchema, {
      data: summariseItems(recueil.db, result.data),
      page: pageInfo(result.page, recueil.library.countItems(filters)),
    });
  });

  /* ---- create -------------------------------------------------------------------------- */

  app.post(BASE, { config: { scope: 'items:write' } }, async (request, reply) => {
    const body = parseOrThrow(ItemCreateSchema, request.body, 'body');
    const record = recueil.library.createItem(
      toCreateInput(body, request.principal.userId),
      request.actor,
    );
    applyItemAssociations(recueil, record.item.id, body, request.actor);

    const fresh = recueil.library.getItem(record.item.id);
    publishItemCreated(events, recueil, fresh, request.actor, 'api');

    reply.header('etag', versionEtag(fresh.item.version));
    reply.header('location', `${BASE}/${fresh.item.id}`);
    return sendJson(reply, ItemSchema, renderItemView(recueil, fresh), 201);
  });

  /* ---- bulk ---------------------------------------------------------------------------- */

  /**
   * The envelope, with a permissive payload.
   *
   * The *documented* payload is the create/update union — that is what a valid operation carries —
   * but the envelope must not reject the whole batch because operation seventeen has a typo in it.
   * Each payload is parsed against its real schema inside the loop, and a failure there becomes
   * that operation's problem document rather than the batch's.
   */
  const BulkItemRequestSchema = bulkRequestOf(bulkOperationOf(z.unknown()));

  app.post(`${BASE}/bulk`, { config: { scope: 'items:write' } }, async (request, reply) => {
    const body = parseOrThrow(BulkItemRequestSchema, request.body, 'body');
    const key = idempotencyKeyHeader(request) ?? body.idempotencyKey;

    const { result, replayed } = replayOrRecord<BulkResult>({
      db: recueil.db,
      audit: recueil.audit,
      actor: request.actor,
      jobType: 'api.items.bulk',
      tokenId: request.principal.token?.id ?? null,
      key,
      force: body.force === true,
      run: (batchId) => runItemBulk(recueil, events, request.actor, body.operations, batchId, key),
    });

    return sendJson(reply, BulkResultSchema, { ...result, replayed }, replayed ? 200 : 207);
  });

  /* ---- read ---------------------------------------------------------------------------- */

  app.get(`${BASE}/by-key/:key`, { config: { scope: 'items:read' } }, async (request, reply) => {
    const { key } = parseOrThrow(z.object({ key: PublicIdSchema }), request.params, 'path');
    const record = recueil.library.getItemByPublicId(key);
    reply.header('etag', versionEtag(record.item.version));
    return sendJson(reply, ItemSchema, renderItemView(recueil, record, { withProvenance: true }));
  });

  app.get(`${BASE}/:id`, { config: { scope: 'items:read' } }, async (request, reply) => {
    const id = itemIdParam(request);
    const query = parseOrThrow(z.object({ ...includeTrashedQuery }), coerceQuery(request.query), 'query');
    const view = loadItemView(recueil, id, {
      withProvenance: true,
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    });
    reply.header('etag', versionEtag(view.version));
    return sendJson(reply, ItemSchema, view);
  });

  /* ---- update -------------------------------------------------------------------------- */

  app.patch(`${BASE}/:id`, { config: { scope: 'items:write' } }, async (request, reply) => {
    const id = itemIdParam(request);
    const body = parseOrThrow(ItemUpdateSchema, request.body, 'body');
    const expectedVersion = ifMatchVersion(request);

    const record = recueil.library.updateItem(id, withMirroredTitle(recueil, id, body), request.actor, {
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });

    if (body.tagNames !== undefined) setItemTags(recueil, id, body.tagNames, request.actor);
    if (body.collectionIds !== undefined) setItemCollections(recueil, id, body.collectionIds, request.actor);

    const fresh = recueil.library.getItem(id);
    publishItemUpdated(events, recueil, fresh, request.actor, Object.keys(body));

    reply.header('etag', versionEtag(fresh.item.version));
    return sendJson(reply, ItemSchema, renderItemView(recueil, fresh, { withProvenance: true }));
  });

  /* ---- facet writes -------------------------------------------------------------------- */

  app.patch(`${BASE}/:id/bibliographic`, { config: { scope: 'items:write' } }, async (request, reply) => {
    const id = itemIdParam(request);
    const body = parseOrThrow(FacetWriteRequestSchema, request.body, 'body');
    const expectedVersion = ifMatchVersion(request);

    const written = recueil.library.writeBibliographic(
      id,
      body.values as Parameters<Recueil['library']['writeBibliographic']>[1],
      request.actor,
      {
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ...(body.provenance === undefined
          ? {}
          : { provenance: { ...body.provenance, ...(body.provenance.locked === undefined ? {} : { lock: body.provenance.locked }) } }),
      },
    );

    publishItemUpdated(events, recueil, written.record, request.actor, written.applied);
    reply.header('etag', versionEtag(written.record.item.version));
    return sendJson(reply, FacetWriteResultSchema, {
      item: renderItemView(recueil, written.record, { withProvenance: true }),
      applied: written.applied,
      skipped: written.skipped,
    });
  });

  app.patch(`${BASE}/:id/office`, { config: { scope: 'items:write' } }, async (request, reply) => {
    const id = itemIdParam(request);
    const body = parseOrThrow(OfficeWriteRequestSchema, request.body, 'body');
    const expectedVersion = ifMatchVersion(request);

    const written = recueil.library.writeOffice(
      id,
      body.values as Parameters<Recueil['library']['writeOffice']>[1],
      request.actor,
      {
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ...(body.provenance === undefined
          ? {}
          : { provenance: { ...body.provenance, ...(body.provenance.locked === undefined ? {} : { lock: body.provenance.locked }) } }),
      },
    );

    publishItemUpdated(events, recueil, written.record, request.actor, written.applied);
    reply.header('etag', versionEtag(written.record.item.version));
    return sendJson(reply, FacetWriteResultSchema, {
      item: renderItemView(recueil, written.record, { withProvenance: true }),
      applied: written.applied,
      skipped: written.skipped,
    });
  });

  /* ---- provenance and locks ------------------------------------------------------------ */

  app.get(`${BASE}/:id/provenance`, { config: { scope: 'items:read' } }, async (request, reply) => {
    const id = itemIdParam(request);
    recueil.library.getItem(id, { includeTrashed: true });
    return sendJson(reply, ItemProvenanceSchema, {
      itemId: id,
      bibliographic: provenanceMapToWire(recueil.provenance.map('item_bibliographic', id)),
      office: provenanceMapToWire(recueil.provenance.map('item_office', id)),
      lockedFields: [
        ...recueil.provenance.lockedFields('item_bibliographic', id),
        ...recueil.provenance.lockedFields('item_office', id),
      ],
    });
  });

  app.post(`${BASE}/:id/locks`, { config: { scope: 'items:write' } }, async (request, reply) => {
    const id = itemIdParam(request);
    const body = parseOrThrow(FieldLockRequestSchema, request.body, 'body');
    const entity = body.facet === 'office' ? 'item_office' : 'item_bibliographic';
    recueil.provenance.lock(entity, id, body.fieldPath, request.actor);
    return sendJson(reply, ItemProvenanceSchema, {
      itemId: id,
      bibliographic: provenanceMapToWire(recueil.provenance.map('item_bibliographic', id)),
      office: provenanceMapToWire(recueil.provenance.map('item_office', id)),
      lockedFields: [
        ...recueil.provenance.lockedFields('item_bibliographic', id),
        ...recueil.provenance.lockedFields('item_office', id),
      ],
    });
  });

  app.delete(`${BASE}/:id/locks/:fieldPath`, { config: { scope: 'items:write' } }, async (request, reply) => {
    const { id, fieldPath } = parseOrThrow(
      z.object({ id: IdSchema, fieldPath: z.string().min(1).max(128) }),
      request.params,
      'path',
    );
    const query = parseOrThrow(
      z.object({ facet: z.enum(['bibliographic', 'office']).optional() }),
      coerceQuery(request.query),
      'query',
    );
    const entity = query.facet === 'office' ? 'item_office' : 'item_bibliographic';
    recueil.provenance.unlock(entity, id, fieldPath, request.actor);
    return reply.code(204).send();
  });

  /* ---- trash and restore ---------------------------------------------------------------- */

  app.post(`${BASE}/:id/trash`, { config: { scope: 'items:write' } }, async (request, reply) => {
    const id = itemIdParam(request);
    const body = parseOrThrow(TrashRequestSchema, request.body ?? {}, 'body');
    const cascade = cascadeOf(recueil, id);
    const record = recueil.library.trashItem(id, request.actor, {
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      ...(body.reasonDetail === undefined ? {} : { reasonDetail: body.reasonDetail }),
    });
    publishItemTrashed(events, record, request.actor, cascade, body.reason);
    return sendJson(reply, ItemSchema, renderItemView(recueil, record, { includeTrashed: true }));
  });

  app.post(`${BASE}/:id/restore`, { config: { scope: 'items:write' } }, async (request, reply) => {
    const id = itemIdParam(request);
    const record = recueil.library.restoreItem(id, request.actor);
    publishItemRestored(events, record, request.actor, cascadeOf(recueil, id));
    return sendJson(reply, ItemSchema, renderItemView(recueil, record));
  });

  /* ---- sub-resources -------------------------------------------------------------------- */

  app.get(`${BASE}/:id/attachments`, { config: { scope: 'attachments:read' } }, async (request, reply) => {
    const id = itemIdParam(request);
    recueil.library.getItem(id, { includeTrashed: true });
    const query = parseOrThrow(z.object({ ...includeTrashedQuery }), coerceQuery(request.query), 'query');
    const rows = attachmentsFor(recueil.db, id, {
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    });
    return sendJson(reply, AttachmentPageSchema, wholeList(rows.map(attachmentToWire)));
  });

  app.get(`${BASE}/:id/creators`, { config: { scope: 'creators:read' } }, async (request, reply) => {
    const id = itemIdParam(request);
    recueil.library.getItem(id, { includeTrashed: true });
    return sendJson(
      reply,
      ItemCreatorPageSchema,
      wholeList(recueil.creators.forItem(id).map(itemCreatorToWire)),
    );
  });

  app.put(`${BASE}/:id/creators`, { config: { scope: 'creators:write' } }, async (request, reply) => {
    const id = itemIdParam(request);
    const body = parseOrThrow(ItemCreatorWriteSchema, request.body, 'body');
    const written = recueil.creators.setItemCreators(
      id,
      body.creators as Parameters<Recueil['creators']['setItemCreators']>[1],
      request.actor,
    );
    publishItemUpdated(events, recueil, recueil.library.getItem(id), request.actor, ['creators']);
    return sendJson(reply, ItemCreatorPageSchema, wholeList(written.map(itemCreatorToWire)));
  });

  app.get(`${BASE}/:id/tags`, { config: { scope: 'tags:read' } }, async (request, reply) => {
    const id = itemIdParam(request);
    recueil.library.getItem(id, { includeTrashed: true });
    return sendJson(reply, ItemTagPageSchema, wholeList(itemTagsFor(recueil.db, id)));
  });

  app.get(`${BASE}/:id/notes`, { config: { scope: 'notes:read' } }, async (request, reply) => {
    const id = itemIdParam(request);
    recueil.library.getItem(id, { includeTrashed: true });
    return sendJson(reply, NotePageSchema, wholeList(recueil.notes.forItem(id).map(noteToWire)));
  });
};

/* -------------------------------------------------------------------------------------------- */
/* Association helpers                                                                             */
/* -------------------------------------------------------------------------------------------- */

/** Make the item's tag set exactly `names`: add what is missing, remove what is no longer named. */
const setItemTags = (recueil: Recueil, itemId: string, names: readonly string[], actor: Actor): void => {
  const wanted = new Set(names.map((name) => name.trim()).filter((name) => name !== ''));
  const current = recueil.tags.forItem(itemId);

  for (const tag of current) {
    if (!wanted.has(tag.name)) recueil.tags.unassign(itemId, tag.id, actor);
  }
  const have = new Set(current.map((tag) => tag.name));
  for (const name of wanted) {
    if (!have.has(name)) recueil.tags.assignByName(itemId, name, actor);
  }
};

/** The same for collection membership: the list sent is the membership afterwards. */
const setItemCollections = (
  recueil: Recueil,
  itemId: string,
  collectionIds: readonly string[],
  actor: Actor,
): void => {
  const wanted = new Set(collectionIds);
  const current = recueil.collections.forItem(itemId);

  for (const collection of current) {
    if (!wanted.has(collection.id)) recueil.collections.removeItems(collection.id, [itemId], actor);
  }
  const have = new Set(current.map((collection) => collection.id));
  for (const collectionId of wanted) {
    if (!have.has(collectionId)) recueil.collections.addItems(collectionId, [itemId], actor);
  }
};

/* -------------------------------------------------------------------------------------------- */
/* Bulk                                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * Run one bulk batch.
 *
 * Per-operation failure rather than all-or-nothing: a client queueing writes offline wants to know
 * which three of two hundred were refused, not to have the whole batch rejected because one item
 * had a duplicate DOI. The refusal is a full problem document in the outcome, so the client sees
 * the same `type` it would have seen from the single-record endpoint.
 */
const runItemBulk = (
  recueil: Recueil,
  events: import('../events.js').EventBus,
  actor: Actor,
  operations: readonly {
    op: 'create' | 'update' | 'replace' | 'delete' | 'restore';
    id?: string;
    payload?: unknown;
    ref?: string;
  }[],
  batchId: string,
  key: string | undefined,
): BulkResult => {
  const results: BulkOperationOutcome[] = [];

  operations.forEach((entry, index) => {
    const base = { index, ...(entry.ref === undefined ? {} : { ref: entry.ref }) };
    try {
      switch (entry.op) {
        case 'create': {
          const payload = parseOrThrow(ItemCreateSchema, entry.payload, 'body');
          const record = recueil.library.createItem(
            toCreateInput(payload, actor.userId ?? recueil.user.id),
            actor,
          );
          applyItemAssociations(recueil, record.item.id, payload, actor);
          publishItemCreated(events, recueil, recueil.library.getItem(record.item.id), actor, 'api');
          results.push({ ...base, status: 'created', id: record.item.id });
          break;
        }
        case 'update':
        case 'replace': {
          if (entry.id === undefined) throw new ValidationError('An update needs an id.');
          const payload = parseOrThrow(ItemUpdateSchema, entry.payload ?? {}, 'body');
          const record = recueil.library.updateItem(entry.id, toUpdateInput(payload), actor);
          if (payload.tagNames !== undefined) setItemTags(recueil, entry.id, payload.tagNames, actor);
          if (payload.collectionIds !== undefined) {
            setItemCollections(recueil, entry.id, payload.collectionIds, actor);
          }
          publishItemUpdated(events, recueil, record, actor, Object.keys(payload));
          results.push({ ...base, status: 'updated', id: record.item.id });
          break;
        }
        case 'delete': {
          if (entry.id === undefined) throw new ValidationError('A delete needs an id.');
          const cascade = cascadeOf(recueil, entry.id);
          const record = recueil.library.trashItem(entry.id, actor);
          publishItemTrashed(events, record, actor, cascade);
          results.push({ ...base, status: 'deleted', id: entry.id });
          break;
        }
        case 'restore': {
          if (entry.id === undefined) throw new ValidationError('A restore needs an id.');
          const record: ItemRecord = recueil.library.restoreItem(entry.id, actor);
          publishItemRestored(events, record, actor, cascadeOf(recueil, entry.id));
          results.push({ ...base, status: 'restored', id: entry.id });
          break;
        }
        default: {
          throw new ValidationError(`Unsupported bulk operation '${String(entry.op)}'.`);
        }
      }
    } catch (error) {
      // Anything thrown — expected or not — becomes this operation's problem document rather than
      // the batch's, through the same mapper the single-record endpoints use, so the client sees
      // the same `type` it would have seen from `POST /items`.
      results.push({
        ...base,
        status: 'failed',
        ...(entry.id === undefined ? {} : { id: entry.id }),
        problem: toProblem(error, { instance: `${BASE}/bulk` }),
      });
    }
  });

  return {
    batchId,
    ...(key === undefined ? {} : { idempotencyKey: key }),
    replayed: false,
    succeeded: results.filter((entry) => entry.status !== 'failed').length,
    failed: results.filter((entry) => entry.status === 'failed').length,
    results,
  };
};

/* -------------------------------------------------------------------------------------------- */
/* The contract                                                                                    */
/* -------------------------------------------------------------------------------------------- */

const ITEM_TAGS = ['Library'] as const;

export const itemPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listItems',
      summary: 'List items',
      description:
        'A page of library rows, newest first. Every filter combines with `AND`; `q` is a ' +
        "full-text filter in Recueil's query syntax, folded into the SQL query rather than ranked " +
        '— for ranking use `GET /api/v1/search`.',
      tags: ITEM_TAGS,
      scope: 'items:read',
      requestParams: { query: ListItemsQuerySchema },
      responses: {
        '200': jsonResponse('A page of item summaries.', ItemSummaryPageSchema),
        ...problems('401', '403', '422'),
      },
    }),
    post: operation({
      operationId: 'createItem',
      summary: 'Create an item',
      description:
        'Creates the item, its facets, its tags by name and its collection memberships in one ' +
        'call. Facet values are written with `manual` provenance and are therefore locked against ' +
        'later enrichment (P4-1).',
      tags: ITEM_TAGS,
      scope: 'items:write',
      requestBody: jsonBody(ItemCreateSchema),
      responses: {
        '201': jsonResponse('The created item, expanded.', ItemSchema),
        ...problems('401', '403', '409', '422'),
      },
    }),
  },
  [`${BASE}/bulk`]: {
    post: operation({
      operationId: 'bulkItems',
      summary: 'Create, update, trash or restore many items',
      description:
        'Each operation succeeds or fails on its own and the outcome names which. Send an ' +
        '`Idempotency-Key` and a replay of the same key returns the original result rather than ' +
        'acting twice (IK2, P9) — which is what makes a client-side write queue safe.',
      tags: ITEM_TAGS,
      scope: 'items:write',
      requestParams: { header: z.object({ 'idempotency-key': IdempotencyKeySchema.optional() }) },
      requestBody: jsonBody(
        bulkRequestOf(bulkOperationOf(z.union([ItemCreateSchema, ItemUpdateSchema]), { id: 'ItemBulkOperation' }), {
          id: 'ItemBulkRequest',
        }),
        'An operation whose payload is not valid fails that operation, not the batch.',
      ),
      responses: {
        '200': jsonResponse('The stored result of an earlier identical call (IK2).', BulkResultSchema),
        '207': jsonResponse('The per-operation outcome of this batch.', BulkResultSchema),
        ...problems('401', '403', '409', '422'),
      },
    }),
  },
  [`${BASE}/by-key/{key}`]: {
    get: operation({
      operationId: 'getItemByKey',
      summary: 'Fetch an item by its public key',
      description:
        'The eight-character Zotero-shaped key that appears in URLs and in `recueil://item/<key>` ' +
        'deep links (`spec/data-model.md` §1.3).',
      tags: ITEM_TAGS,
      scope: 'items:read',
      requestParams: { path: publicIdPath('key') },
      responses: {
        '200': jsonResponse('The item, expanded.', ItemSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getItem',
      summary: 'Fetch one item',
      description:
        'The whole record: both facets with their per-field provenance and locks, the creators in ' +
        'order, the tags with the reason each is there, the collection ids, the attachments and ' +
        'the ids of the notes. The `ETag` is the version — send it back as `If-Match` to write.',
      tags: ITEM_TAGS,
      scope: 'items:read',
      requestParams: { path: idPath(), query: z.object(includeTrashedQuery) },
      responses: {
        '200': jsonResponse('The item.', ItemSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
    patch: operation({
      operationId: 'updateItem',
      summary: 'Update an item',
      description:
        'A partial write. Send `If-Match` with the version from the `ETag` and a stale write is ' +
        'refused with 412 rather than merged (P1, §1.7). Facet fields written here take `manual` ' +
        'provenance and lock (P4-1).',
      tags: ITEM_TAGS,
      scope: 'items:write',
      requestParams: {
        path: idPath(),
        header: z.object({ 'if-match': z.string().optional().meta({ description: 'The quoted version, e.g. `"3"`.' }) }),
      },
      requestBody: jsonBody(ItemUpdateSchema),
      responses: {
        '200': jsonResponse('The updated item.', ItemSchema),
        ...problems('400', '401', '403', '404', '409', '412', '422'),
      },
    }),
  },
  [`${BASE}/{id}/bibliographic`]: {
    patch: operation({
      operationId: 'writeBibliographicFacet',
      summary: 'Write bibliographic fields with provenance',
      description:
        'The call an enrichment run makes. Send the resolver in `provenance` and every field a ' +
        'human has locked is left alone and returned in `skipped`, while the rest are written with ' +
        'their source, confidence and timestamp (P4-2, P4-4). Omit `provenance` and the write is ' +
        '`manual`, which outranks every lock and takes one of its own.',
      tags: ITEM_TAGS,
      scope: 'items:write',
      requestParams: { path: idPath(), header: z.object({ 'if-match': z.string().optional() }) },
      requestBody: jsonBody(FacetWriteRequestSchema),
      responses: {
        '200': jsonResponse('What was written, and what the locks refused.', FacetWriteResultSchema),
        ...problems('400', '401', '403', '404', '409', '412', '422'),
      },
    }),
  },
  [`${BASE}/{id}/office`]: {
    patch: operation({
      operationId: 'writeOfficeFacet',
      summary: 'Write office fields with provenance',
      description: 'The office facet counterpart of `PATCH /items/{id}/bibliographic` (§3.7).',
      tags: ITEM_TAGS,
      scope: 'items:write',
      requestParams: { path: idPath(), header: z.object({ 'if-match': z.string().optional() }) },
      requestBody: jsonBody(OfficeWriteRequestSchema),
      responses: {
        '200': jsonResponse('What was written, and what the locks refused.', FacetWriteResultSchema),
        ...problems('400', '401', '403', '404', '409', '412', '422'),
      },
    }),
  },
  [`${BASE}/{id}/provenance`]: {
    get: operation({
      operationId: 'getItemProvenance',
      summary: 'Per-field provenance and locks',
      description: 'One current row per (facet, field): where the value came from, when, and whether it is locked (§3.6).',
      tags: ITEM_TAGS,
      scope: 'items:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The provenance of both facets.', ItemProvenanceSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/locks`]: {
    post: operation({
      operationId: 'lockItemField',
      summary: 'Lock a field against enrichment',
      description:
        'Locks one field without changing its value. A locked field is never overwritten by a ' +
        'resolver, and that is not overridable by configuration (P4-2).',
      tags: ITEM_TAGS,
      scope: 'items:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(FieldLockRequestSchema),
      responses: {
        '200': jsonResponse('The provenance after the lock.', ItemProvenanceSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/locks/{fieldPath}`]: {
    delete: operation({
      operationId: 'unlockItemField',
      summary: 'Unlock a field',
      description: 'An explicit action, audited, because it re-exposes a hand-made value to enrichment (P4-3).',
      tags: ITEM_TAGS,
      scope: 'items:write',
      requestParams: {
        path: z.object({ id: IdSchema, fieldPath: z.string().max(128) }),
        query: z.object({ facet: z.enum(['bibliographic', 'office']).optional() }),
      },
      responses: { '204': { description: 'Unlocked.' }, ...problems('401', '403', '404', '422') },
    }),
  },
  [`${BASE}/{id}/trash`]: {
    post: operation({
      operationId: 'trashItem',
      summary: 'Move an item to the trash',
      description:
        'Soft-deletes the item and, in the same transaction, its attachments, notes and ' +
        'annotations, all sharing one trash group so a restore puts back exactly what went ' +
        'together (I4, P5). Nothing is deleted.',
      tags: ITEM_TAGS,
      scope: 'items:write',
      requestParams: { path: idPath() },
      requestBody: { required: false, content: { 'application/json': { schema: TrashRequestSchema } } },
      responses: {
        '200': jsonResponse('The trashed item.', ItemSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/restore`]: {
    post: operation({
      operationId: 'restoreItem',
      summary: 'Restore an item from the trash',
      description: 'Brings back the item and everything that went into the bin with it.',
      tags: ITEM_TAGS,
      scope: 'items:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The restored item.', ItemSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/attachments`]: {
    get: operation({
      operationId: 'listItemAttachments',
      summary: 'The files attached to an item',
      description: 'In position order. Detaching soft-deletes the attachment and never the document (AT2).',
      tags: ITEM_TAGS,
      scope: 'attachments:read',
      requestParams: { path: idPath(), query: z.object(includeTrashedQuery) },
      responses: {
        '200': jsonResponse('The attachments.', AttachmentPageSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/creators`]: {
    get: operation({
      operationId: 'listItemCreators',
      summary: 'The author list of an item',
      description: 'In `ordinal` order, each appearance joined to the creator behind it (§5.2).',
      tags: ITEM_TAGS,
      scope: 'creators:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The creators.', ItemCreatorPageSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
    put: operation({
      operationId: 'setItemCreators',
      summary: 'Replace the author list',
      description:
        'The array order is the author order; the server assigns the dense ordinal block in one ' +
        'transaction, so a client never computes positions (IC1). A duplicate creator in the same ' +
        'role is refused (IC2).',
      tags: ITEM_TAGS,
      scope: 'creators:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(ItemCreatorWriteSchema),
      responses: {
        '200': jsonResponse('The author list as it now stands.', ItemCreatorPageSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/tags`]: {
    get: operation({
      operationId: 'listItemTags',
      summary: 'The tags on an item',
      description: 'Each with the reason it is there: manual, a rule, a resolver, an import (P4).',
      tags: ITEM_TAGS,
      scope: 'tags:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The tags.', ItemTagPageSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/notes`]: {
    get: operation({
      operationId: 'listItemNotes',
      summary: 'The notes on an item',
      description: 'Oldest first. Markdown is canonical; imported HTML is kept beside it (N1, P10).',
      tags: ITEM_TAGS,
      scope: 'notes:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The notes.', NotePageSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
};
