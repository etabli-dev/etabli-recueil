/**
 * `/api/v1/trash` — the bin, across every entity (`spec/data-model.md` §6.6, P5).
 *
 * "Never delete" is only a promise if there is somewhere to look. Each entity has its own trash and
 * restore endpoints, because that is where a client already is when it wants them; this resource is
 * the other view — everything currently in the bin, in one list, with the reason it is there and
 * what it went in with.
 *
 * Purging is here and nowhere else, deliberately. It is the one operation in Recueil that destroys
 * data (TR2), so it is a single, explicit, separately-scoped endpoint rather than a flag on a
 * delete somebody might set by accident.
 */
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { pageInfo, resolvePageParams, sendJson } from '../http.js';
import { idPath, jsonResponse, operation, pageQuery, problems } from '../openapi-kit.js';
import { TrashEntrySchema, TrashPageSchema, TrashSummarySchema } from '../schemas.js';
import { coerceQuery, parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/trash`;

const TRASH_ENTITY_TYPES = [
  'item',
  'document',
  'attachment',
  'collection',
  'note',
  'annotation',
  'tag',
  'creator',
  'review',
  'curated_network',
] as const;

const ListTrashQuerySchema = z.strictObject({
  ...pageQuery,
  entityType: z.enum(TRASH_ENTITY_TYPES).optional(),
  includeClosed: z.coerce
    .boolean()
    .optional()
    .meta({ description: 'Include records already restored or purged. Off by default.' }),
});

/** The trash row, with its two JSON columns left where they are: they are restore mechanics. */
const trashToWire = (row: import('@recueil/core').schema.TrashRow): z.infer<typeof TrashEntrySchema> => ({
  id: row.id,
  entityType: row.entityType,
  entityId: row.entityId,
  groupId: row.groupId,
  trashedAt: row.trashedAt,
  trashedByUserId: row.trashedByUserId,
  reason: row.reason,
  reasonDetail: row.reasonDetail,
  mergeTargetItemId: row.mergeTargetItemId,
  expiresAt: row.expiresAt,
  restoredAt: row.restoredAt,
  purgedAt: row.purgedAt,
});

export const trashRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  app.get(BASE, { config: { scope: 'trash:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListTrashQuerySchema, coerceQuery(request.query), 'query');
    const page = resolvePageParams(request.query);
    const result = recueil.trash.list({
      ...page,
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      ...(query.includeClosed === undefined ? {} : { includeClosed: query.includeClosed }),
    });
    return sendJson(reply, TrashPageSchema, {
      data: result.data.map(trashToWire),
      page: pageInfo(result.page),
    });
  });

  app.get(`${BASE}/summary`, { config: { scope: 'trash:read' } }, async (_request, reply) =>
    sendJson(reply, TrashSummarySchema, { counts: recueil.trash.summary() }),
  );

  app.post(`${BASE}/:id/restore`, { config: { scope: 'trash:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    recueil.trash.restoreRecord(id, request.actor);
    return reply.code(204).send();
  });

  app.delete(`${BASE}/:id`, { config: { scope: 'trash:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const query = parseOrThrow(
      z.object({ reason: z.string().max(1024).optional() }),
      coerceQuery(request.query),
      'query',
    );
    const row = recueil.trash.purge(id, request.actor, query.reason);
    return sendJson(reply, TrashEntrySchema, trashToWire(row));
  });
};

export const trashPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listTrash',
      summary: 'What is in the bin',
      description:
        'Every open trash record, newest first, with the reason it is there and the group it went ' +
        'in with. Nothing here has been deleted (P5).',
      tags: ['Platform'],
      scope: 'trash:read',
      requestParams: { query: ListTrashQuerySchema },
      responses: { '200': jsonResponse('A page of trash records.', TrashPageSchema), ...problems('401', '403', '422') },
    }),
  },
  [`${BASE}/summary`]: {
    get: operation({
      operationId: 'getTrashSummary',
      summary: 'How much is in the bin, by entity type',
      description: 'One count per entity type. What a "Trash (12)" badge reads.',
      tags: ['Platform'],
      scope: 'trash:read',
      responses: { '200': jsonResponse('The counts.', TrashSummarySchema), ...problems('401', '403') },
    }),
  },
  [`${BASE}/{id}/restore`]: {
    post: operation({
      operationId: 'restoreTrashRecord',
      summary: 'Restore whatever this record refers to',
      description:
        'Dispatches to the owning service, so restoring an item brings back its cascade and ' +
        'restoring a collection brings back its subtree.',
      tags: ['Platform'],
      scope: 'trash:write',
      requestParams: { path: idPath() },
      responses: { '204': { description: 'Restored.' }, ...problems('401', '403', '404', '409', '422') },
    }),
  },
  [`${BASE}/{id}`]: {
    delete: operation({
      operationId: 'purgeTrashRecord',
      summary: 'Purge a trashed record permanently',
      description:
        'The one operation in Recueil that destroys data (TR2). It is here, on its own, behind its ' +
        'own scope, rather than being a flag on a delete — because P5 means every other path can ' +
        'be undone and this one cannot.',
      tags: ['Platform'],
      scope: 'trash:write',
      requestParams: {
        path: idPath(),
        query: z.object({ reason: z.string().max(1024).optional() }),
      },
      responses: {
        '200': jsonResponse('The purged record.', TrashEntrySchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
};
