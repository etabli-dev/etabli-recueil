/**
 * `/api/v1/annotations` — reading annotations as records (ADR-0009, `spec/data-model.md` §4.9).
 *
 * The target is a document; `itemId` is the reading context, and the server refuses one that does
 * not carry the document (AN2). `POST /annotations/{id}/note` is the "annotate → note → cite" step
 * of the Phase 4 exit: a note that quotes the passage and ends with a Pandoc citation.
 */
import { noteFromAnnotation } from '@recueil/core';
import type { AnnotationSelector } from '@recueil/core';
import {
  API_BASE_PATH,
  AnnotationCreateSchema,
  AnnotationPageSchema,
  AnnotationSchema,
  AnnotationUpdateSchema,
  IdSchema,
  NoteSchema,
} from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { ifMatchVersion, pageInfo, sendJson, versionEtag } from '../http.js';
import { idPath, includeTrashedQuery, jsonBody, jsonResponse, operation, problems } from '../openapi-kit.js';
import { coerceQuery, parseOrThrow, refuse } from '../validate.js';
import { embedAnnotations } from '../annotated-pdf.js';
import { annotationToWire, noteToWire } from '../wire.js';

const BASE = `${API_BASE_PATH}/annotations`;
const TAGS = ['Reading'] as const;

const ListAnnotationsQuerySchema = z.strictObject({
  ...includeTrashedQuery,
  documentId: IdSchema.optional().meta({ description: 'Every annotation on this document.' }),
  itemId: IdSchema.optional().meta({ description: 'Every annotation on every document this item carries (AN3).' }),
});

const NoteFromAnnotationSchema = z
  .strictObject({ itemId: IdSchema.optional().meta({ description: 'Defaults to the annotation’s own reading context.' }) })
  .meta({ id: 'NoteFromAnnotation', title: 'NoteFromAnnotation', unusedIO: 'input' });

export const annotationRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  app.get(BASE, { config: { scope: 'annotations:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListAnnotationsQuerySchema, coerceQuery(request.query), 'query');
    const rows = recueil.annotations.list({
      ...(query.documentId === undefined ? {} : { documentId: query.documentId }),
      ...(query.itemId === undefined ? {} : { itemId: query.itemId }),
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    });
    // One page: a document's annotations are read whole, in reading order.
    return sendJson(reply, AnnotationPageSchema, {
      data: rows.map(annotationToWire),
      page: pageInfo({ nextCursor: null, hasMore: false, limit: Math.max(1, rows.length) }, rows.length),
    });
  });

  app.post(BASE, { config: { scope: 'annotations:write' } }, async (request, reply) => {
    const body = parseOrThrow(AnnotationCreateSchema, request.body, 'body');
    const row = recueil.annotations.create(
      {
        documentId: body.documentId,
        ...(body.itemId === undefined ? {} : { itemId: body.itemId }),
        ...(body.attachmentId === undefined ? {} : { attachmentId: body.attachmentId }),
        annotationType: body.annotationType,
        motivation: body.motivation,
        selector: body.selector as AnnotationSelector[],
        ...(body.bodyText === undefined ? {} : { bodyText: body.bodyText }),
        ...(body.bodyFormat === undefined ? {} : { bodyFormat: body.bodyFormat }),
        ...(body.colour === undefined ? {} : { colour: body.colour }),
        ...(body.pageIndex === undefined ? {} : { pageIndex: body.pageIndex }),
        ...(body.pageLabel === undefined ? {} : { pageLabel: body.pageLabel }),
        ...(body.authorName === undefined ? {} : { authorName: body.authorName }),
        ...(body.isExternal === undefined ? {} : { isExternal: body.isExternal }),
        ...(body.externalRef === undefined ? {} : { externalRef: body.externalRef }),
      },
      request.actor,
    );
    reply.header('etag', versionEtag(row.version));
    reply.header('location', `${BASE}/${row.id}`);
    return sendJson(reply, AnnotationSchema, annotationToWire(row), 201);
  });

  app.get(`${BASE}/:id`, { config: { scope: 'annotations:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const row = recueil.annotations.get(id);
    reply.header('etag', versionEtag(row.version));
    return sendJson(reply, AnnotationSchema, annotationToWire(row));
  });

  app.patch(`${BASE}/:id`, { config: { scope: 'annotations:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(AnnotationUpdateSchema, request.body, 'body');
    const expectedVersion = ifMatchVersion(request);
    const row = recueil.annotations.update(
      id,
      {
        ...(body.annotationType === undefined ? {} : { annotationType: body.annotationType }),
        ...(body.motivation === undefined ? {} : { motivation: body.motivation }),
        ...(body.selector === undefined ? {} : { selector: body.selector as AnnotationSelector[] }),
        ...(body.bodyText === undefined ? {} : { bodyText: body.bodyText }),
        ...(body.bodyFormat === undefined ? {} : { bodyFormat: body.bodyFormat }),
        ...(body.colour === undefined ? {} : { colour: body.colour }),
        ...(body.pageLabel === undefined ? {} : { pageLabel: body.pageLabel }),
      },
      request.actor,
      expectedVersion === undefined ? {} : { expectedVersion },
    );
    reply.header('etag', versionEtag(row.version));
    return sendJson(reply, AnnotationSchema, annotationToWire(row));
  });

  app.post(`${BASE}/:id/trash`, { config: { scope: 'annotations:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, AnnotationSchema, annotationToWire(recueil.annotations.trash(id, request.actor)));
  });

  app.get(`${API_BASE_PATH}/documents/:id/annotated.pdf`, { config: { scope: 'documents:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const document = recueil.documents.getDocument(id);
    if (document.mimeType !== 'application/pdf') {
      refuse('path.id', `is a ${document.mimeType ?? 'file of unknown type'}, not a PDF.`);
    }
    const original = await recueil.documents.readBuffer(id);
    const result = await embedAnnotations(new Uint8Array(original), recueil.annotations.list({ documentId: id }));
    const name = (document.originalFilename ?? `${document.sha256.slice(0, 12)}.pdf`).replace(/\.pdf$/iu, '');
    return reply
      .code(200)
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${name.replace(/[^\w.-]+/gu, '_')}-annotated.pdf"`)
      .header('x-recueil-embedded', String(result.embedded))
      .header('x-recueil-skipped', String(result.skipped.length))
      .send(Buffer.from(result.bytes));
  });

  app.post(`${BASE}/:id/note`, { config: { scope: 'notes:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(NoteFromAnnotationSchema, request.body ?? {}, 'body');
    const note = noteFromAnnotation(recueil, id, request.actor, body.itemId === undefined ? {} : { itemId: body.itemId });
    reply.header('location', `${API_BASE_PATH}/notes/${note.id}`);
    return sendJson(reply, NoteSchema, noteToWire(note), 201);
  });
};

export const annotationPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listAnnotations',
      summary: 'List annotations',
      description: 'By document, or by item (every document the item carries, AN3), in reading order.',
      tags: TAGS,
      scope: 'annotations:read',
      requestParams: { query: ListAnnotationsQuerySchema },
      responses: { '200': jsonResponse('The annotations, in reading order.', AnnotationPageSchema), ...problems('401', '403', '422') },
    }),
    post: operation({
      operationId: 'createAnnotation',
      summary: 'Create an annotation',
      description: 'One selector must resolve without the text layer (AN4); an `itemId` must carry the document (AN2).',
      tags: TAGS,
      scope: 'annotations:write',
      requestBody: jsonBody(AnnotationCreateSchema),
      responses: { '201': jsonResponse('The annotation.', AnnotationSchema), ...problems('401', '403', '404', '409', '422') },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getAnnotation',
      summary: 'Fetch one annotation',
      description: 'The `ETag` is the version; send it back as `If-Match` to write.',
      tags: TAGS,
      scope: 'annotations:read',
      requestParams: { path: idPath() },
      responses: { '200': jsonResponse('The annotation.', AnnotationSchema), ...problems('401', '403', '404', '422') },
    }),
    patch: operation({
      operationId: 'updateAnnotation',
      summary: 'Update an annotation',
      description: 'The target never moves. A stale `If-Match` is refused with 412.',
      tags: TAGS,
      scope: 'annotations:write',
      requestParams: { path: idPath(), header: z.object({ 'if-match': z.string().optional() }) },
      requestBody: jsonBody(AnnotationUpdateSchema),
      responses: { '200': jsonResponse('The annotation.', AnnotationSchema), ...problems('400', '401', '403', '404', '412', '422') },
    }),
  },
  [`${BASE}/{id}/trash`]: {
    post: operation({
      operationId: 'trashAnnotation',
      summary: 'Move an annotation to the trash',
      description: 'Nothing is deleted (P5); the trash restores it.',
      tags: TAGS,
      scope: 'annotations:write',
      requestParams: { path: idPath() },
      responses: { '200': jsonResponse('The trashed annotation.', AnnotationSchema), ...problems('401', '403', '404', '422') },
    }),
  },
  [`${API_BASE_PATH}/documents/{id}/annotated.pdf`]: {
    get: operation({
      operationId: 'getAnnotatedPdf',
      summary: 'Download a PDF with its annotations embedded',
      description:
        'A new PDF carrying every live annotation as a standard PDF annotation, readable in any viewer. ' +
        'The stored document is not modified (AN1). `X-Recueil-Embedded` and `X-Recueil-Skipped` count them.',
      tags: TAGS,
      scope: 'documents:read',
      requestParams: { path: idPath() },
      responses: {
        '200': { description: 'The annotated PDF.', content: { 'application/pdf': { schema: z.string().meta({ format: 'binary' }) } } },
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/note`]: {
    post: operation({
      operationId: 'noteFromAnnotation',
      summary: 'Make a note from an annotation',
      description: 'The note quotes the passage, carries the comment, and ends with a Pandoc citation such as `[@key, p. 12]`.',
      tags: TAGS,
      scope: 'notes:write',
      requestParams: { path: idPath() },
      requestBody: { required: false, content: { 'application/json': { schema: NoteFromAnnotationSchema } } },
      responses: { '201': jsonResponse('The note.', NoteSchema), ...problems('400', '401', '403', '404', '422') },
    }),
  },
};
