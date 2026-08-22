/**
 * `/api/v1/notes` — Markdown attached to an item, or standalone (`spec/data-model.md` §4.8).
 *
 * `contentMarkdown` is always populated, including for an HTML import, so the search index and the
 * export path read one field (N1); the original HTML is kept beside it so a Zotero note
 * round-trips losslessly (P10). A caller may therefore send either, and the server converts.
 *
 * Notes carry a `version` and honour `If-Match` for the same reason items do: two browser tabs
 * editing the same note is the ordinary case, and the second write should be refused rather than
 * quietly winning (P1).
 */
import { API_BASE_PATH, IdSchema, NoteCreateSchema, NoteSchema, NoteUpdateSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { ifMatchVersion, pageInfo, resolvePageParams, sendJson, versionEtag } from '../http.js';
import {
  idPath,
  includeTrashedQuery,
  jsonBody,
  jsonResponse,
  operation,
  pageQuery,
  problems,
} from '../openapi-kit.js';
import { NotePageSchema, TrashRequestSchema } from '../schemas.js';
import { coerceQuery, parseOrThrow, refuse } from '../validate.js';
import { noteToWire } from '../wire.js';

const BASE = `${API_BASE_PATH}/notes`;

const NOTE_TAGS = ['Library'] as const;

const ListNotesQuerySchema = z.strictObject({
  ...pageQuery,
  ...includeTrashedQuery,
  itemId: IdSchema.optional().meta({ description: 'Only notes on this item.' }),
  standalone: z.coerce.boolean().optional().meta({ description: 'Only notes attached to no item.' }),
  noteKind: z.enum(['note', 'quote', 'thought', 'summary', 'email_body']).optional(),
  ownerUserId: IdSchema.optional(),
});

export const noteRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  app.get(BASE, { config: { scope: 'notes:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListNotesQuerySchema, coerceQuery(request.query), 'query');
    const page = resolvePageParams(request.query);

    const result = recueil.notes.list({
      ...page,
      ...(query.standalone === true ? { itemId: null } : query.itemId === undefined ? {} : { itemId: query.itemId }),
      ...(query.noteKind === undefined ? {} : { noteKind: query.noteKind }),
      ...(query.ownerUserId === undefined ? {} : { ownerUserId: query.ownerUserId }),
      ...(query.includeTrashed === undefined ? {} : { includeTrashed: query.includeTrashed }),
    });

    return sendJson(reply, NotePageSchema, {
      data: result.data.map(noteToWire),
      page: pageInfo(result.page),
    });
  });

  app.post(BASE, { config: { scope: 'notes:write' } }, async (request, reply) => {
    const body = parseOrThrow(NoteCreateSchema, request.body, 'body');

    // N1 in the one place a caller can break it: a note with no content at all is not a note.
    const html = body.sourceFormat === 'html' ? (body.contentOriginal ?? body.contentMarkdown) : undefined;
    if ((body.contentMarkdown ?? '') === '' && (html ?? '') === '') {
      refuse('body.contentMarkdown', 'is required: a note needs content.');
    }

    const row = recueil.notes.create(
      {
        ownerUserId: request.principal.userId,
        ...(html === undefined ? { contentMarkdown: body.contentMarkdown } : { contentHtml: html }),
        ...(body.itemId === undefined ? {} : { itemId: body.itemId }),
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.noteKind === undefined ? {} : { noteKind: body.noteKind }),
        ...(body.parentAnnotationId === undefined ? {} : { parentAnnotationId: body.parentAnnotationId }),
      },
      request.actor,
    );

    reply.header('etag', versionEtag(row.version));
    reply.header('location', `${BASE}/${row.id}`);
    return sendJson(reply, NoteSchema, noteToWire(row), 201);
  });

  app.get(`${BASE}/:id`, { config: { scope: 'notes:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const row = recueil.notes.get(id, { includeTrashed: true });
    reply.header('etag', versionEtag(row.version));
    return sendJson(reply, NoteSchema, noteToWire(row));
  });

  app.patch(`${BASE}/:id`, { config: { scope: 'notes:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(NoteUpdateSchema, request.body, 'body');
    const expectedVersion = ifMatchVersion(request);

    const html = body.sourceFormat === 'html' ? (body.contentOriginal ?? undefined) : undefined;
    const row = recueil.notes.update(
      id,
      {
        ...(body.itemId === undefined ? {} : { itemId: body.itemId }),
        ...(body.contentMarkdown === undefined ? {} : { contentMarkdown: body.contentMarkdown }),
        ...(html === undefined ? {} : { contentHtml: html }),
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.noteKind === undefined ? {} : { noteKind: body.noteKind }),
      },
      request.actor,
      { ...(expectedVersion === undefined ? {} : { expectedVersion }) },
    );

    reply.header('etag', versionEtag(row.version));
    return sendJson(reply, NoteSchema, noteToWire(row));
  });

  app.post(`${BASE}/:id/trash`, { config: { scope: 'notes:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(TrashRequestSchema, request.body ?? {}, 'body');
    return sendJson(
      reply,
      NoteSchema,
      noteToWire(
        recueil.notes.trash(id, request.actor, {
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          ...(body.reasonDetail === undefined ? {} : { reasonDetail: body.reasonDetail }),
        }),
      ),
    );
  });

  app.post(`${BASE}/:id/restore`, { config: { scope: 'notes:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, NoteSchema, noteToWire(recueil.notes.restore(id, request.actor)));
  });
};

export const notePaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listNotes',
      summary: 'List notes',
      description: '`standalone=true` asks for the notes attached to no item.',
      tags: NOTE_TAGS,
      scope: 'notes:read',
      requestParams: { query: ListNotesQuerySchema },
      responses: { '200': jsonResponse('A page of notes.', NotePageSchema), ...problems('401', '403', '422') },
    }),
    post: operation({
      operationId: 'createNote',
      summary: 'Create a note',
      description:
        'Send `contentMarkdown`, or `sourceFormat: "html"` with the HTML in `contentOriginal` and ' +
        'the server converts. Markdown is always populated so the index and the exporters read one ' +
        'field (N1); the HTML is kept verbatim so a Zotero note round-trips (P10). The title is ' +
        'derived from the first heading when it is not given.',
      tags: NOTE_TAGS,
      scope: 'notes:write',
      requestBody: jsonBody(NoteCreateSchema),
      responses: { '201': jsonResponse('The note.', NoteSchema), ...problems('401', '403', '404', '422') },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getNote',
      summary: 'Fetch one note',
      description: 'The `ETag` is the version; send it back as `If-Match` to write.',
      tags: NOTE_TAGS,
      scope: 'notes:read',
      requestParams: { path: idPath() },
      responses: { '200': jsonResponse('The note.', NoteSchema), ...problems('401', '403', '404', '422') },
    }),
    patch: operation({
      operationId: 'updateNote',
      summary: 'Update a note',
      description: 'A stale `If-Match` is refused with 412 rather than merged (P1).',
      tags: NOTE_TAGS,
      scope: 'notes:write',
      requestParams: { path: idPath(), header: z.object({ 'if-match': z.string().optional() }) },
      requestBody: jsonBody(NoteUpdateSchema),
      responses: {
        '200': jsonResponse('The updated note.', NoteSchema),
        ...problems('400', '401', '403', '404', '412', '422'),
      },
    }),
  },
  [`${BASE}/{id}/trash`]: {
    post: operation({
      operationId: 'trashNote',
      summary: 'Move a note to the trash',
      description: 'Nothing is deleted (P5).',
      tags: NOTE_TAGS,
      scope: 'notes:write',
      requestParams: { path: idPath() },
      requestBody: { required: false, content: { 'application/json': { schema: TrashRequestSchema } } },
      responses: {
        '200': jsonResponse('The trashed note.', NoteSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/restore`]: {
    post: operation({
      operationId: 'restoreNote',
      summary: 'Restore a note from the trash',
      description: 'Refused when the note went into the bin with its item; restore the item instead.',
      tags: NOTE_TAGS,
      scope: 'notes:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The restored note.', NoteSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
};
