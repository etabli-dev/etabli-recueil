/**
 * `/api/v1/search` — the FTS5 query surface (ADR-0011).
 *
 * Recueil has two ways of asking a question of the text, and they are different operations rather
 * than one with a flag. `GET /items?q=…` is a *filter*: the matching ids are folded into the SQL
 * query so that the result can be paged, ordered and combined with `collectionId` and `tagId`. This
 * endpoint is a *search*: results come back ranked by BM25, across items, notes and extracted
 * document text, each with a snippet showing why it matched.
 *
 * The query language is Recueil's own and is compiled to an FTS5 expression, never passed through:
 * bare words are `AND`, `"phrase"` is a phrase, `term*` is a prefix, `-term` excludes, `OR` and
 * parentheses group, and `field:term` restricts to `title`, `creator`, `container`, `id`, `tag`,
 * `note` or `text`. An unknown field is a 422 naming the ones that exist rather than a silent
 * literal match.
 *
 * `search.available` is false where the database has no FTS5 index — a build of SQLite without the
 * module, which ADR-0011 anticipates. That is a 503 and not a 500: the library is fine, this
 * feature is not there.
 */
import { API_BASE_PATH } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { sendJson } from '../http.js';
import { jsonResponse, operation, problems } from '../openapi-kit.js';
import { ApiError } from '../problem.js';
import { SearchResponseSchema } from '../schemas.js';
import { coerceQuery, parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/search`;

const SearchQuerySchema = z.strictObject({
  q: z
    .string()
    .min(1)
    .max(2048)
    .meta({
      description:
        'The query. Bare words are `AND`; `"a phrase"`; `term*`; `-excluded`; `OR`; `(grouping)`; ' +
        '`field:term` over `title`, `creator`, `container`, `id`, `tag`, `note`, `text`.',
      examples: ['title:trial AND -retracted', '"randomised controlled" creator:ravaud'],
    }),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  entityType: z
    .enum(['item', 'note', 'document'])
    .optional()
    .meta({ description: 'Restrict to one kind of indexed entity.' }),
});

export const searchRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  app.get(BASE, { config: { scope: 'search:read' } }, async (request, reply) => {
    const query = parseOrThrow(SearchQuerySchema, coerceQuery(request.query), 'query');

    if (!recueil.search.available) {
      throw new ApiError(
        'https://recueil.org/problems/unavailable',
        503,
        'Service unavailable',
        'This database has no FTS5 index, so full-text search is unavailable (ADR-0011). The rest ' +
          'of the library is unaffected.',
      );
    }

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const result = recueil.search.search(query.q, {
      limit,
      offset,
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
    });

    return sendJson(reply, SearchResponseSchema, {
      query: query.q,
      expression: result.expression,
      hits: result.hits,
      limit,
      offset,
    });
  });
};

export const searchPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    get: operation({
      operationId: 'search',
      summary: 'Full-text search',
      description:
        'Ranked results across items, notes and extracted document text, each with a snippet. A ' +
        'title match beats a body match beats a match in the extracted text of a fifty-page PDF, ' +
        'which is what a reader means by relevance in a reference library.\n\n' +
        'For a *filter* that can be paged and combined with a collection or a tag, use ' +
        '`GET /api/v1/items?q=…` instead.',
      tags: ['Search'],
      scope: 'search:read',
      requestParams: { query: SearchQuerySchema },
      responses: {
        '200': jsonResponse('The ranked hits, and the compiled expression behind them.', SearchResponseSchema),
        ...problems('401', '403', '422', '503'),
      },
    }),
  },
};
