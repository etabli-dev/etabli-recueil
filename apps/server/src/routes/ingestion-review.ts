/**
 * `/api/v1/ingestion/review` — the review queue (P3, `spec/data-model.md` §6.1).
 *
 * "Flag, never guess" only means something if the flags are actionable, and that is what this
 * surface is for: every entry carries a machine-readable reason, a stored human-readable sentence
 * and, where there is one, the exact payload that accepting will execute.
 *
 * **Accept is atomic.** The item and the resolution commit in one transaction (see
 * `ingestion/review.ts`), so there is no window in which the library holds an item whose entry
 * still says nobody has looked at it — and a duplicate ASN, a bad collection id or a constraint
 * anywhere in the commit leaves the entry open and no item created.
 *
 * **Accept-with-edits is the same endpoint.** A person who corrects the correspondent before
 * accepting is doing one thing, not two, and splitting it into an edit and an accept would make the
 * audit trail read as though the machine's proposal had been executed. `resolution_payload` holds
 * what was actually run.
 *
 * **Bulk accept is per-entry.** Each entry gets its own transaction, so the fiftieth scan hitting a
 * duplicate ASN does not roll back the forty-nine before it, and the response names every refusal.
 */
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { pageInfo, sendJson } from '../http.js';
import { reviewEntryToWire } from '../ingestion/review.js';
import type { AcceptResult } from '../ingestion/review.js';
import {
  idPath,
  jsonBody,
  jsonResponse,
  operation,
  problems,
} from '../openapi-kit.js';
import {
  ReviewAcceptRequestSchema,
  ReviewAcceptResultSchema,
  ReviewBulkAcceptRequestSchema,
  ReviewBulkAcceptResultSchema,
  ReviewEntryPageSchema,
  ReviewEntrySchema,
  ReviewRejectRequestSchema,
  ReviewStatusSchema,
  ReviewSubjectTypeSchema,
} from '../schemas-ingestion.js';
import { coerceQuery, parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/ingestion/review`;

const REVIEW_TAGS = ['Ingestion'] as const;

const ListReviewQuerySchema = z.strictObject({
  status: ReviewStatusSchema.optional().meta({ description: 'Defaults to `open`: the queue is the open entries.' }),
  reasonCode: z.string().max(64).optional(),
  subjectType: ReviewSubjectTypeSchema.optional(),
  subjectId: z.string().max(64).optional(),
  jobId: IdSchema.optional(),
  severity: z.enum(['info', 'warning', 'blocker']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const acceptToWire = (result: AcceptResult): z.input<typeof ReviewAcceptResultSchema> => ({
  entry: reviewEntryToWire(result.entry),
  itemId: result.itemId,
  attachmentId: result.attachmentId,
  warnings: result.warnings,
});

export const ingestionReviewRoutes: FastifyPluginAsync = async (app) => {
  const { ingestion } = app.recueil;

  app.get(BASE, { config: { scope: 'ingestion:read' } }, async (request, reply) => {
    const query = parseOrThrow(ListReviewQuerySchema, coerceQuery(request.query), 'query');
    const limit = query.limit ?? 50;
    const rows = ingestion.review.list({
      status: query.status ?? 'open',
      limit,
      order: query.order ?? 'desc',
      ...(query.reasonCode === undefined ? {} : { reasonCode: query.reasonCode }),
      ...(query.subjectType === undefined ? {} : { subjectType: query.subjectType }),
      ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
      ...(query.jobId === undefined ? {} : { jobId: query.jobId }),
      ...(query.severity === undefined ? {} : { severity: query.severity }),
    });

    return sendJson(reply, ReviewEntryPageSchema, {
      data: rows.map(reviewEntryToWire),
      // `hasMore` is derived from the page being full rather than from a second count query: an
      // operator paging a review queue wants the next page, not a total that is stale by the time
      // it renders.
      page: pageInfo({ nextCursor: null, hasMore: rows.length === limit, limit }),
    });
  });

  app.get(`${BASE}/:id`, { config: { scope: 'ingestion:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, ReviewEntrySchema, reviewEntryToWire(ingestion.review.get(id)));
  });

  app.post(`${BASE}/:id/accept`, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(ReviewAcceptRequestSchema, request.body ?? {}, 'body');
    const result = ingestion.review.accept(id, {
      actor: request.actor,
      ...(body.note === undefined ? {} : { note: body.note }),
      ...(body.edits === undefined ? {} : { edits: body.edits }),
    });
    return sendJson(reply, ReviewAcceptResultSchema, acceptToWire(result));
  });

  app.post(`${BASE}/:id/reject`, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(ReviewRejectRequestSchema, request.body ?? {}, 'body');
    const row = ingestion.review.reject(id, {
      actor: request.actor,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
    return sendJson(reply, ReviewEntrySchema, reviewEntryToWire(row));
  });

  app.post(`${BASE}/accept`, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    const body = parseOrThrow(ReviewBulkAcceptRequestSchema, request.body, 'body');
    const result = ingestion.review.bulkAccept(body.ids, {
      actor: request.actor,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
    return sendJson(reply, ReviewBulkAcceptResultSchema, {
      accepted: result.accepted.map(acceptToWire),
      refused: result.refused,
    });
  });
};

export const ingestionReviewPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'listReviewEntries',
      summary: 'The review queue',
      description:
        'Open entries by default, newest first. Each carries the reason code, the sentence stored ' +
        'when it was raised — not generated at render time, so it still reads correctly in 2029 — ' +
        'the proposed action and the exact payload accepting will execute.',
      tags: REVIEW_TAGS,
      scope: 'ingestion:read',
      requestParams: { query: ListReviewQuerySchema },
      responses: {
        '200': jsonResponse('A page of entries.', ReviewEntryPageSchema),
        ...problems('401', '403', '422'),
      },
    }),
  },
  [`${BASE}/accept`]: {
    post: operation({
      operationId: 'bulkAcceptReviewEntries',
      summary: 'Accept several entries',
      description:
        'Each entry is accepted in its own transaction, so one refusal does not roll back the rest ' +
        'and the response says exactly which landed and why each of the others did not. Nothing is ' +
        'silently skipped.',
      tags: REVIEW_TAGS,
      scope: 'ingestion:write',
      requestBody: jsonBody(ReviewBulkAcceptRequestSchema),
      responses: {
        '200': jsonResponse('What landed, and what did not.', ReviewBulkAcceptResultSchema),
        ...problems('401', '403', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getReviewEntry',
      summary: 'One review entry',
      description: 'With its proposal and, once resolved, what was actually executed.',
      tags: REVIEW_TAGS,
      scope: 'ingestion:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The entry.', ReviewEntrySchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/accept`]: {
    post: operation({
      operationId: 'acceptReviewEntry',
      summary: 'Accept an entry, optionally with edits',
      description:
        'Executes `proposedPayload` (RQ1) in one transaction with the resolution, so a failure ' +
        'anywhere leaves the entry open and nothing created. `edits` changes the proposal before it ' +
        'runs: `fields` and `customFields` are patches where `null` removes a key, everything else ' +
        'replaces wholesale. What actually ran is stored as the resolution payload, so the ' +
        'difference between what was proposed and what was accepted is on the record.\n\n' +
        'This build can execute `create_item`, `discard` and `none`. Any other proposed action is a ' +
        '409 naming it, rather than an entry marked accepted with nothing done.',
      tags: REVIEW_TAGS,
      scope: 'ingestion:write',
      requestParams: { path: idPath() },
      requestBody: {
        required: false,
        content: { 'application/json': { schema: ReviewAcceptRequestSchema } },
      },
      responses: {
        '200': jsonResponse('The resolved entry and what it created.', ReviewAcceptResultSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/reject`]: {
    post: operation({
      operationId: 'rejectReviewEntry',
      summary: 'Reject an entry',
      description:
        'Nothing is executed and nothing is created. The document stays in the library — it was ' +
        'ingested before the gate ran — and can be filed by hand or discarded through a later ' +
        'entry. The note is stored and audited.',
      tags: REVIEW_TAGS,
      scope: 'ingestion:write',
      requestParams: { path: idPath() },
      requestBody: {
        required: false,
        content: { 'application/json': { schema: ReviewRejectRequestSchema } },
      },
      responses: {
        '200': jsonResponse('The rejected entry.', ReviewEntrySchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
};
