/**
 * `/api/v1/export` and the tokened `.bib` feeds (CONCEPT.md §5.11).
 *
 * §5.11 asks for two things and they are different endpoints on purpose.
 *
 * `GET /export/{format}` is the general one: pick a selection — a collection, a saved search, or an
 * explicit list of ids — and get BibTeX, BibLaTeX, RIS or CSL-JSON back.
 *
 * `GET /collections/{id}/bibliography.bib` is the one that makes the Overleaf workflow work, and
 * every detail of it is there for a reason:
 *
 * - **The path ends in `.bib`.** Overleaf's "add file from URL" and Quarto's `bibliography:` both
 *   take the extension from the URL, and a file called `bibliography` is not one either will treat
 *   as a bibliography.
 * - **The token may be in the query string.** Neither tool can set a header. This is the only place
 *   on the API where that is accepted, and invariant A2 means such a token can hold no write scope
 *   — a credential that lives in a project setting is a credential that has been published.
 * - **The ETag is a digest of the bytes served.** Overleaf refetches on every build; a stable ETag
 *   turns that into a 304 and a LaTeX run that does not have to re-parse the file. It is a content
 *   hash rather than a timestamp so that it is identical across restarts and across processes.
 * - **`Cache-Control: no-cache`, not `no-store`.** The client should revalidate every time and then
 *   reuse what it has — which is exactly what a conditional request does.
 */
import { API_BASE_PATH, IdSchema } from '@recueil/schemas';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { renderExport, resolveSelection } from '../export.js';
import type { ExportFormat, RenderedExport } from '../export.js';
import { contentEtag, isFresh, sendJson } from '../http.js';
import { idPath, jsonResponse, operation, problems } from '../openapi-kit.js';
import { ApiError } from '../problem.js';
import { ExportFormatSchema, ExportReportSchema } from '../schemas.js';
import { coerceQuery, parseOrThrow } from '../validate.js';

const BASE = `${API_BASE_PATH}/export`;
const COLLECTIONS = `${API_BASE_PATH}/collections`;
const SAVED_SEARCHES = `${API_BASE_PATH}/saved-searches`;

const ExportQuerySchema = z.strictObject({
  collectionId: IdSchema.optional().meta({ description: 'Export a collection, or a saved search.' }),
  ids: z
    .string()
    .max(65_536)
    .optional()
    .meta({ description: 'A comma-separated list of item ids. Order is preserved.' }),
  q: z.string().max(2048).optional().meta({ description: "A full-text query in Recueil's syntax." }),
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
  report: z.coerce
    .boolean()
    .optional()
    .meta({
      description:
        'Return the loss report as JSON instead of the file. What a format cannot carry is ' +
        'reported, never silently dropped (P10).',
    }),
});

/** Send a rendered export as a file, with the caching a build tool needs. */
const sendExport = (
  request: FastifyRequest,
  reply: FastifyReply,
  rendered: RenderedExport,
  filename: string,
): FastifyReply => {
  const etag = contentEtag(rendered.text);
  reply.header('etag', etag);
  reply.header('cache-control', 'no-cache, must-revalidate');
  reply.header('x-recueil-record-count', String(rendered.recordCount));
  reply.header('x-recueil-loss-count', String(rendered.losses.length));

  if (isFresh(request, etag)) return reply.code(304).send();

  reply.type(rendered.contentType);
  reply.header('content-disposition', `inline; filename="${filename}"`);
  return reply.send(rendered.text);
};

export const exportRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil } = app.recueil;

  /* ---- the general export ------------------------------------------------------------------ */

  app.get(`${BASE}/:format`, { config: { scope: 'export:read' } }, async (request, reply) => {
    const { format } = parseOrThrow(z.object({ format: ExportFormatSchema }), request.params, 'path');
    const query = parseOrThrow(ExportQuerySchema, coerceQuery(request.query), 'query');

    const ids = resolveSelection(recueil, {
      ...(query.collectionId === undefined ? {} : { collectionId: query.collectionId }),
      ...(query.ids === undefined
        ? {}
        : { ids: query.ids.split(',').map((id) => id.trim()).filter((id) => id !== '') }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });

    const rendered = renderExport(recueil, format as ExportFormat, ids);

    if (query.report === true) {
      return sendJson(reply, ExportReportSchema, {
        format: rendered.format,
        recordCount: rendered.recordCount,
        losses: [...rendered.losses],
      });
    }

    return sendExport(request, reply, rendered, `recueil.${rendered.extension}`);
  });

  /* ---- the tokened feeds -------------------------------------------------------------------- */

  /** The two feeds differ only in whether they insist the collection is a saved search. */
  const feed = (path: string, requireSmart: boolean): void => {
    app.get(
      path,
      { config: { scope: 'export:read', allowQueryToken: true } },
      async (request, reply) => {
        const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
        const query = parseOrThrow(
          z.object({
            format: z.enum(['bibtex', 'biblatex']).optional(),
            limit: z.coerce.number().int().min(1).max(10_000).optional(),
            // Consumed by the auth hook; declared here so the strict parse does not reject it.
            token: z.string().max(256).optional(),
          }),
          coerceQuery(request.query),
          'query',
        );

        const collection = recueil.collections.get(id);
        if (requireSmart && collection.kind !== 'smart') {
          throw new ApiError(
            'https://recueil.org/problems/validation',
            404,
            'Not found',
            `Collection '${id}' is a manual collection, not a saved search. Its bibliography is at ` +
              `${COLLECTIONS}/${id}/bibliography.bib.`,
          );
        }

        const ids = resolveSelection(recueil, {
          collectionId: id,
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        });
        const rendered = renderExport(recueil, query.format ?? 'bibtex', ids);

        const slug = collection.nameNormalised.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '');
        return sendExport(request, reply, rendered, `${slug === '' ? 'bibliography' : slug}.bib`);
      },
    );
  };

  feed(`${COLLECTIONS}/:id/bibliography.bib`, false);
  feed(`${SAVED_SEARCHES}/:id/bibliography.bib`, true);
};

/* -------------------------------------------------------------------------------------------- */
/* The contract                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * Deliberately not strict, unlike every other query on this surface: a build tool may append a
 * cache-buster of its own to a feed URL, and refusing the fetch over it would break the workflow
 * this endpoint exists for.
 */
const feedQuery = z.object({
  format: z
    .enum(['bibtex', 'biblatex'])
    .optional()
    .meta({ description: 'Defaults to `bibtex`. BibLaTeX keeps UTF-8 and ISO-8601 dates.' }),
  limit: z.coerce.number().int().min(1).max(10_000).optional(),
  token: z
    .string()
    .max(256)
    .optional()
    .meta({
      description:
        'A read-only `bib_feed` token, for clients that cannot set a header — Overleaf and Quarto ' +
        'both fetch by URL alone. Such a token may hold no write scope (A2).',
    }),
});

const feedResponses = {
  '200': {
    description: 'The bibliography.',
    content: { 'application/x-bibtex': { schema: z.string() } },
  },
  ...problems('304', '401', '403', '404', '422'),
};

export const exportPaths: ZodOpenApiPathsObject = {
  [`${BASE}/{format}`]: {
    get: operation({
      operationId: 'exportSelection',
      summary: 'Export a selection',
      description:
        'BibTeX, BibLaTeX, RIS or CSL-JSON over a collection, a saved search or an explicit list ' +
        'of ids. Exactly one selection must be given: exporting the whole library by accident is ' +
        'not something an endpoint should make easy.\n\n' +
        'Citation keys follow ADR-0016: a stored key always wins, a pinned key is never ' +
        'recomputed, and only keyless items get a generated key — disambiguated against the keys ' +
        'already in the batch, so a new item can never take one a manuscript points at.\n\n' +
        '`report=true` returns what the format could not carry instead of the file (P10).',
      tags: ['Platform'],
      scope: 'export:read',
      requestParams: { path: z.object({ format: ExportFormatSchema }), query: ExportQuerySchema },
      responses: {
        '200': {
          description: 'The serialised selection, or the loss report when `report=true`.',
          content: {
            'application/x-bibtex': { schema: z.string() },
            'application/x-research-info-systems': { schema: z.string() },
            'application/vnd.citationstyles.csl+json': { schema: z.string() },
            'application/json': { schema: ExportReportSchema },
          },
        },
        ...problems('304', '401', '403', '404', '422'),
      },
    }),
  },
  [`${COLLECTIONS}/{id}/bibliography.bib`]: {
    get: operation({
      operationId: 'getCollectionBibliography',
      summary: 'A collection as a .bib file',
      description:
        'The endpoint CONCEPT.md §5.11 asks for: a `.bib` URL an Overleaf project or a Quarto ' +
        "document can point at directly. The path ends in `.bib` because both tools take the file " +
        'type from the URL.\n\n' +
        'The credential may travel in `?token=` because neither tool can set a header; such a ' +
        'token must be read-only (A2). The `ETag` is a digest of the bytes served, so a build that ' +
        'refetches every time gets a 304 and does not re-parse the file.',
      tags: ['Platform'],
      scope: 'export:read',
      requestParams: { path: idPath(), query: feedQuery },
      responses: feedResponses,
    }),
  },
  [`${SAVED_SEARCHES}/{id}/bibliography.bib`]: {
    get: operation({
      operationId: 'getSavedSearchBibliography',
      summary: 'A saved search as a .bib file',
      description:
        'The same feed over a saved search — a collection of `kind: "smart"`, whose membership is ' +
        'its query rather than a list (§4.1). Pointed at a manual collection it answers 404 and ' +
        'names the right URL, rather than quietly serving a different set of items.',
      tags: ['Platform'],
      scope: 'export:read',
      requestParams: { path: idPath(), query: feedQuery },
      responses: feedResponses,
    }),
  },
};
