/**
 * The HTTP conventions of `/api/v1`, in one place.
 *
 * docs/api.qmd and CONCEPT.md §5.12 fix four of them, and every route in `routes/` reaches for the
 * helpers here rather than re-deriving them:
 *
 * - **Cursor pagination.** Offsets lie when the set changes under you, and an ingestion run is
 *   inserting rows the whole time (`@recueil/schemas`, `CursorSchema`). Every list takes
 *   `?cursor=&limit=&order=` and answers with a `page` block whose `nextCursor` is the end
 *   condition.
 * - **ETags are versions.** An item's `version` column is optimistic concurrency (§1.7), so the
 *   ETag of an item is that number and `If-Match` is the conditional write. A stale one is a 412
 *   and nothing is merged (P1).
 * - **ETags are also content digests**, on the export endpoints, where there is no version column
 *   and Overleaf wants to cache. There the tag is a hash of the bytes served, which is stable
 *   across restarts and across processes — the property a cache needs.
 * - **Responses are validated against the published schema** before they are sent. See `wire.ts`.
 */
import { createHash } from 'node:crypto';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PageParamsSchema } from '@recueil/schemas';
import type { PageInfo } from '@recueil/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';

import { ApiError } from './problem.js';
import { coerceQuery, parseOrThrow } from './validate.js';

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };

/* -------------------------------------------------------------------------------------------- */
/* Pagination                                                                                      */
/* -------------------------------------------------------------------------------------------- */

export interface ResolvedPageParams {
  readonly limit: number;
  readonly cursor?: string;
  readonly order: 'asc' | 'desc';
}

/**
 * The three pagination parameters, parsed out of a query object that may carry many more.
 *
 * `PageParamsSchema` is strict, so it cannot be handed the whole query string of an endpoint that
 * also filters; the fields are picked out first and the rest is the endpoint's business.
 */
export const resolvePageParams = (query: unknown): ResolvedPageParams => {
  const raw = coerceQuery(query);
  const picked: Record<string, unknown> = {};
  for (const key of ['cursor', 'limit', 'order', 'sort'] as const) {
    if (raw[key] !== undefined) picked[key] = raw[key];
  }
  const parsed = parseOrThrow(PageParamsSchema, picked, 'query');
  return {
    limit: parsed.limit ?? DEFAULT_PAGE_SIZE,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    order: parsed.order ?? 'desc',
  };
};

/** The `page` block of a list response. `total` is omitted rather than guessed when unknown. */
export const pageInfo = (
  page: { nextCursor: string | null; hasMore: boolean; limit: number; textFilterTruncated?: boolean },
  total?: number,
): PageInfo => ({
  nextCursor: page.nextCursor,
  hasMore: page.hasMore,
  limit: page.limit,
  ...(total === undefined ? {} : { total }),
  // Passed straight through: only the service knows whether its text filter hit its ceiling, and a
  // client that is not told cannot distinguish "no more matches" from "no more than we looked at".
  ...(page.textFilterTruncated === true ? { textFilterTruncated: true } : {}),
});

/**
 * A page over a list the service returned whole.
 *
 * Collections, tags, creators and custom fields are small, bounded sets that `packages/core`
 * returns as arrays. Wrapping them in the same envelope as a cursor-paged list means a client has
 * one shape to handle, and the `page` block tells the truth: there is no next page.
 */
export const wholeList = <TValue>(data: TValue[], limit = data.length): { data: TValue[]; page: PageInfo } => ({
  data,
  page: { nextCursor: null, hasMore: false, limit: Math.max(1, Math.min(limit, MAX_PAGE_SIZE)), total: data.length },
});

/* -------------------------------------------------------------------------------------------- */
/* Conditional requests                                                                            */
/* -------------------------------------------------------------------------------------------- */

/** The ETag of a versioned record: its `version`, quoted, as a strong validator. */
export const versionEtag = (version: number): string => `"${version}"`;

/** A strong ETag over bytes. Used where there is no version column — the export endpoints. */
export const contentEtag = (body: string | Buffer): string =>
  `"${createHash('sha256').update(body).digest('base64url').slice(0, 32)}"`;

/**
 * The version a conditional write requires, from `If-Match`.
 *
 * `If-Match: *` means "it must exist", which every write here already requires, so it is accepted
 * and imposes nothing further. Anything that is not a quoted integer is a client error rather than
 * something to ignore: silently doing an unconditional write because the header was misspelled is
 * how lost updates happen.
 */
export const ifMatchVersion = (request: FastifyRequest): number | undefined => {
  const header = request.headers['if-match'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value.trim() === '' || value.trim() === '*') return undefined;

  const match = /^(?:W\/)?"(\d+)"$/u.exec(value.trim());
  if (match === null) {
    throw new ApiError(
      'https://recueil.org/problems/validation',
      400,
      'Bad request',
      `If-Match must be the quoted version of the record, for example '"3"'. Received: ${value}.`,
      { errors: [{ path: 'headers.if-match', message: 'must be a quoted integer version', code: 'invalid_format' }] },
    );
  }
  return Number.parseInt(match[1] as string, 10);
};

/** True when the client already holds this representation (`If-None-Match`). */
export const isFresh = (request: FastifyRequest, etag: string): boolean => {
  const header = request.headers['if-none-match'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return false;
  if (value.trim() === '*') return true;
  return value
    .split(',')
    .map((candidate: string) => candidate.trim().replace(/^W\//u, ''))
    .includes(etag);
};

/* -------------------------------------------------------------------------------------------- */
/* Sending                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * Send a body after parsing it through its published schema.
 *
 * The parse is the point (P6): if a route ever sends a shape the OpenAPI document does not
 * describe, this throws in the route rather than the client discovering it in production.
 */
export const sendJson = <TSchema extends z.ZodType>(
  reply: FastifyReply,
  schema: TSchema,
  body: z.input<TSchema>,
  status = 200,
): FastifyReply => reply.code(status).send(schema.parse(body));

/** The `Idempotency-Key` header, if present and well-formed. */
export const idempotencyKeyHeader = (request: FastifyRequest): string | undefined => {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  return value === undefined || value.trim() === '' ? undefined : value.trim();
};
