/**
 * `/api/v1/attachments` — the many-to-many between items and documents (`spec/data-model.md` §3.8).
 *
 * Attaching is a POST under the item, because an attachment does not exist without one; everything
 * that addresses an existing attachment lives here.
 *
 * The rule that shapes the whole resource is AT2: **detaching soft-deletes the attachment row and
 * nothing else**. The document survives, because the same bytes may be reachable from another item
 * and because P5 says nothing is deleted. A `DELETE` here is therefore a detach, and the document
 * has its own trash endpoint with its own refusal (D4).
 *
 * Reordering is a `PUT` of the whole order rather than a per-attachment `position` write: positions
 * are dense and total within an item, and letting two clients each set one position is how a list
 * ends up with two attachments at position 3.
 */
import { API_BASE_PATH, AttachmentSchema, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { sendJson, wholeList } from '../http.js';
import { idPath, jsonBody, jsonResponse, operation, problems } from '../openapi-kit.js';
import { attachmentById, reorderAttachments } from '../queries.js';
import { publishAttachmentAdded } from '../publish.js';
import { AttachDocumentSchema, AttachmentOrderSchema, AttachmentPageSchema, TrashRequestSchema } from '../schemas.js';
import { parseOrThrow } from '../validate.js';
import { attachmentToWire } from '../wire.js';

const BASE = `${API_BASE_PATH}/attachments`;
const ITEM_BASE = `${API_BASE_PATH}/items`;

const ATTACHMENT_TAGS = ['Library'] as const;

export const attachmentRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil, events } = app.recueil;

  /* ---- attach ----------------------------------------------------------------------------- */

  app.post(`${ITEM_BASE}/:id/attachments`, { config: { scope: 'attachments:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(AttachDocumentSchema, request.body, 'body');

    const attachmentId = recueil.documents.attachDocument(
      {
        itemId: id,
        documentId: body.documentId,
        ...(body.role === undefined ? {} : { role: body.role }),
        ...(body.title === undefined ? {} : { title: body.title }),
      },
      request.actor,
    );

    const row = attachmentById(recueil.db, attachmentId);
    publishAttachmentAdded(events, row, request.actor, 'api');

    reply.header('location', `${BASE}/${attachmentId}`);
    return sendJson(reply, AttachmentSchema, attachmentToWire(row), 201);
  });

  /* ---- reorder ---------------------------------------------------------------------------- */

  app.put(`${ITEM_BASE}/:id/attachments/order`, { config: { scope: 'attachments:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(AttachmentOrderSchema, request.body, 'body');
    recueil.library.getItem(id, { includeTrashed: true });

    const rows = reorderAttachments(recueil.db, recueil.audit, id, body.attachmentIds, request.actor);
    return sendJson(reply, AttachmentPageSchema, wholeList(rows.map(attachmentToWire)));
  });

  /* ---- read, detach, restore -------------------------------------------------------------- */

  app.get(`${BASE}/:id`, { config: { scope: 'attachments:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, AttachmentSchema, attachmentToWire(attachmentById(recueil.db, id)));
  });

  app.delete(`${BASE}/:id`, { config: { scope: 'attachments:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(TrashRequestSchema, request.body ?? {}, 'body');
    recueil.documents.detachDocument(id, request.actor, {
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      ...(body.reasonDetail === undefined ? {} : { reasonDetail: body.reasonDetail }),
    });
    return sendJson(reply, AttachmentSchema, attachmentToWire(attachmentById(recueil.db, id)));
  });

  app.post(`${BASE}/:id/restore`, { config: { scope: 'attachments:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    recueil.documents.restoreAttachment(id, request.actor);
    return sendJson(reply, AttachmentSchema, attachmentToWire(attachmentById(recueil.db, id)));
  });
};

export const attachmentPaths: ZodOpenApiPathsObject = {
  [`${ITEM_BASE}/{id}/attachments`]: {
    post: operation({
      operationId: 'attachDocument',
      summary: 'Attach a document to an item',
      description:
        'Creates an `attachments` row and no `documents` row (AT1): two items citing the same ' +
        'supplementary dataset share one blob. An item may hold at most one `primary` attachment; ' +
        'a second file offered as primary is filed as a supplement rather than failing the call.',
      tags: ATTACHMENT_TAGS,
      scope: 'attachments:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(AttachDocumentSchema),
      responses: {
        '201': jsonResponse('The attachment.', AttachmentSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${ITEM_BASE}/{id}/attachments/order`]: {
    put: operation({
      operationId: 'reorderAttachments',
      summary: 'Reorder an item’s attachments',
      description:
        'The whole order in one call. Positions become 0..n-1 in the order sent, and any live ' +
        'attachment left out keeps its relative order after the ones named. One transaction: a ' +
        'half-applied reorder is a list that renders differently on every refresh.',
      tags: ATTACHMENT_TAGS,
      scope: 'attachments:write',
      requestParams: { path: idPath() },
      requestBody: jsonBody(AttachmentOrderSchema),
      responses: {
        '200': jsonResponse('The attachments in their new order.', AttachmentPageSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getAttachment',
      summary: 'Fetch one attachment',
      description: 'The row, not the bytes. For those, `GET /api/v1/documents/{documentId}/content`.',
      tags: ATTACHMENT_TAGS,
      scope: 'attachments:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The attachment.', AttachmentSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
    delete: operation({
      operationId: 'detachDocument',
      summary: 'Detach a file from an item',
      description:
        'A soft delete of this row and nothing else (AT2). The document survives — its bytes may ' +
        'be reachable from another item — and reclaiming storage is a separate, explicit ' +
        'operation. The detached attachment can be restored.',
      tags: ATTACHMENT_TAGS,
      scope: 'attachments:write',
      requestParams: { path: idPath() },
      requestBody: { required: false, content: { 'application/json': { schema: TrashRequestSchema } } },
      responses: {
        '200': jsonResponse('The detached attachment.', AttachmentSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/restore`]: {
    post: operation({
      operationId: 'restoreAttachment',
      summary: 'Re-attach a detached file',
      description:
        'Refused for an attachment that went into the bin as part of trashing its item (I4): that ' +
        'one comes back with the item, and putting it back alone would leave a live attachment ' +
        'hanging off a trashed record.',
      tags: ATTACHMENT_TAGS,
      scope: 'attachments:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The restored attachment.', AttachmentSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
};
