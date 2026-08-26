/**
 * `/api/v1/documents` — bytes, and the content-addressed identity over them (ADR-0004, P2).
 *
 * **Upload is multipart and the hash is computed while streaming.** The part is written to a
 * temporary file a chunk at a time, and the SHA-256 and the byte count fall out of the same pass,
 * so the server never has to trust the client's claim about either and never has to hold a 400 MB
 * scan in memory to find out what it is. A file larger than `RECUEIL_MAX_UPLOAD_BYTES` is refused
 * during that pass, before anything has been recorded.
 *
 * **The response tells the client the file was already here.** `created: false` is CONCEPT.md §5.3
 * stage 2 — "exact duplicate check against document hashes: link to the existing document, log,
 * stop" — surfaced rather than hidden. A capture client that re-downloads the same PDF learns that
 * in one round trip, which is the difference between a sync loop that settles and one that does not.
 *
 * **Download supports byte ranges**, because a PDF reader opening a hundred-page document fetches
 * the cross-reference table at the end of the file first, and a reader that has to pull the whole
 * file to render page one is a reader nobody uses. The `ETag` is the digest: content-addressed
 * storage gives a perfect, permanently stable validator for free.
 *
 * **The bytes are served from a sandbox, because they are somebody else's bytes.** `mime_type` is
 * sniffed rather than trusted, but sniffing has a fall-back, and the fall-back is the *filename's*
 * extension — a zip member name, or a MIME `filename` parameter. `htm` maps to `text/html`. This
 * route used to answer with that type and `Content-Disposition: inline`, on the API's own origin,
 * with no `nosniff` and no CSP, so a zip holding one member called `invoice.html` executed script
 * against `/api/v1` with the caller's scopes. So: `nosniff` and a restrictive Content-Security-
 * Policy on every response, and `inline` only for an allow-list of types a browser paints rather
 * than runs — `INLINE_RENDERABLE`, which has PDF and the raster images on it and has HTML, XHTML
 * and SVG deliberately off it. Everything else is `attachment` and `application/octet-stream`. The
 * reader is unaffected and `contentSecurityPolicy` says exactly why.
 *
 * **Nothing is deleted.** Trashing a document is refused while any live attachment references it
 * (D4/TR3) — detach first — and the blob is never removed, because reclaiming storage is a
 * separate, explicit operation (P5, AT2).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { newId } from '@recueil/core';
import type { IngestProvenance } from '@recueil/core';
import { API_BASE_PATH, DocumentSchema, IdSchema, Sha256Schema } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { isFresh, sendJson } from '../http.js';
import { idPath, jsonResponse, operation, problems } from '../openapi-kit.js';
import { ApiError, notFound } from '../problem.js';
import { attachmentById } from '../queries.js';
import { publishAttachmentAdded, publishDocumentIngested } from '../publish.js';
import { DocumentUploadResultSchema, TrashRequestSchema } from '../schemas.js';
import { coerceQuery, parseOrThrow, refuse } from '../validate.js';
import { documentToWire } from '../wire.js';

const BASE = `${API_BASE_PATH}/documents`;

const DOCUMENT_TAGS = ['Library'] as const;

/** The multipart fields the upload accepts beside the file itself. */
const UploadFieldsSchema = z.strictObject({
  itemId: IdSchema.optional().meta({ description: 'Attach the document to this item in the same transaction.' }),
  role: z
    .enum([
      'primary',
      'supplement',
      'snapshot',
      'scan',
      'preprint',
      'accepted_manuscript',
      'data',
      'code',
      'cover',
      'source_export',
      'other',
    ])
    .optional()
    .meta({ description: 'The part the file plays for that item. Defaults to `primary`.' }),
  sourceKind: z
    .enum([
      'upload',
      'folder',
      'webdav',
      'imap',
      'scanner',
      'connector',
      'mobile',
      'import',
      'api',
      'plugin',
      'derived',
    ])
    .optional()
    .meta({ description: 'Which ingestion path this is. Defaults to `upload`.' }),
  sourceRef: z.string().max(2048).optional(),
  title: z.string().max(1024).optional(),
});

/**
 * A multipart body, described for the document rather than parsed by Zod.
 *
 * The bytes never become a JavaScript value, so there is no schema to validate them with; what the
 * contract needs to say is which parts exist and that the file part is required.
 */
const UploadBodySchema = z
  .object({
    file: z.string().meta({ format: 'binary', description: 'The file. Required.' }),
    itemId: z.string().optional(),
    role: z.string().optional(),
    sourceKind: z.string().optional(),
    sourceRef: z.string().optional(),
    title: z.string().optional(),
  })
  .meta({ id: 'DocumentUpload', title: 'DocumentUpload', unusedIO: 'input' });

/** What a streaming upload produced: where the bytes are, what they hash to, how many there were. */
interface SpooledUpload {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly filename: string | null;
  readonly declaredMimeType: string | null;
}

export const documentRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil, config, events } = app.recueil;

  /* ---- upload -------------------------------------------------------------------------- */

  app.post(BASE, { config: { scope: 'documents:write' } }, async (request, reply) => {
    if (!request.isMultipart()) {
      throw new ApiError(
        'https://recueil.org/problems/validation',
        415,
        'Unsupported media type',
        'Upload a file as `multipart/form-data` with the bytes in a part named `file`.',
      );
    }

    const part = await request.file();
    if (part === undefined) {
      refuse('body.file', 'is required: the upload carried no file part.');
      return reply;
    }

    // Fields arrive alongside the file part. `@fastify/multipart` gives them as `{ value }`.
    const rawFields: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(part.fields ?? {})) {
      const single = Array.isArray(field) ? field[0] : field;
      if (single !== undefined && 'value' in single && typeof single.value === 'string') {
        rawFields[name] = single.value;
      }
    }
    const fields = parseOrThrow(UploadFieldsSchema, rawFields, 'body');

    const spoolRoot = join(config.storagePath, '.uploads');
    await mkdir(spoolRoot, { recursive: true });
    const spoolPath = join(spoolRoot, `${newId()}.part`);

    let spooled: SpooledUpload;
    try {
      const hash = createHash('sha256');
      let size = 0;
      part.file.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.byteLength;
      });

      await pipeline(part.file, createWriteStream(spoolPath, { flags: 'wx' }));

      // `truncated` is how `@fastify/multipart` reports that it stopped at the limit. Treating it
      // as success would store a prefix of the file under a digest that is genuinely the digest of
      // that prefix — a corrupt library that looks correct.
      if (part.file.truncated) {
        throw new ApiError(
          'https://recueil.org/problems/validation',
          413,
          'Payload too large',
          `The upload exceeds RECUEIL_MAX_UPLOAD_BYTES (${config.maxUploadBytes} bytes).`,
        );
      }

      spooled = {
        path: spoolPath,
        sha256: hash.digest('hex'),
        size,
        filename: part.filename ?? null,
        declaredMimeType: part.mimetype ?? null,
      };
    } catch (error) {
      await rm(spoolPath, { force: true });
      throw error;
    }

    try {
      const provenance: IngestProvenance = {
        sourceKind: fields.sourceKind ?? 'upload',
        actor: request.actor,
        originalFilename: spooled.filename,
        declaredMimeType: spooled.declaredMimeType,
        ...(fields.sourceRef === undefined ? {} : { sourceRef: fields.sourceRef }),
        ...(fields.itemId === undefined
          ? {}
          : {
              attachTo: {
                itemId: fields.itemId,
                ...(fields.role === undefined ? {} : { role: fields.role }),
                ...(fields.title === undefined ? {} : { title: fields.title }),
              },
            }),
      };

      // The bytes are read back from the spool file rather than accumulated in memory during the
      // network read: the whole upload is never in memory and in flight at the same time.
      const bytes = await readFile(spooled.path);
      const result = await recueil.documents.ingestBuffer(bytes, provenance);

      if (result.document.sha256 !== spooled.sha256 || (result.created && result.document.byteSize !== spooled.size)) {
        /* c8 ignore next 6 */
        throw new ApiError(
          'https://recueil.org/problems/internal',
          500,
          'Internal server error',
          'The digest computed during the upload does not match the digest of the stored bytes.',
        );
      }

      publishDocumentIngested(
        events,
        result,
        request.actor,
        fields.itemId === undefined ? [] : [fields.itemId],
        newId(),
      );
      if (result.attachmentId !== null) {
        publishAttachmentAdded(
          events,
          attachmentById(recueil.db, result.attachmentId),
          request.actor,
          'api',
        );
      }

      reply.header('etag', `"${result.document.sha256}"`);
      reply.header('location', `${BASE}/${result.document.id}`);
      return sendJson(
        reply,
        DocumentUploadResultSchema,
        {
          document: documentToWire(result.document),
          created: result.created,
          blobWritten: result.blobWritten,
          attachmentId: result.attachmentId,
        },
        result.created ? 201 : 200,
      );
    } finally {
      await rm(spooled.path, { force: true });
    }
  });

  /* ---- lookup by digest ------------------------------------------------------------------ */

  app.get(`${BASE}/by-sha256/:sha256`, { config: { scope: 'documents:read' } }, async (request, reply) => {
    const { sha256 } = parseOrThrow(z.object({ sha256: Sha256Schema }), request.params, 'path');
    const row = recueil.documents.findBySha256(sha256);
    if (row === null) throw notFound(`No document with SHA-256 '${sha256}'.`);
    return sendJson(reply, DocumentSchema, documentToWire(row));
  });

  /* ---- metadata --------------------------------------------------------------------------- */

  app.get(`${BASE}/:id`, { config: { scope: 'documents:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(reply, DocumentSchema, documentToWire(recueil.documents.getDocument(id)));
  });

  /* ---- bytes ------------------------------------------------------------------------------ */

  app.get(`${BASE}/:id/content`, { config: { scope: 'documents:read' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const query = parseOrThrow(
      z.object({ download: z.coerce.boolean().optional() }),
      coerceQuery(request.query),
      'query',
    );
    const document = recueil.documents.getDocument(id);

    // The digest *is* the validator. Nothing about these bytes can ever change (D3), so the tag is
    // permanent and a cache may keep it forever.
    const etag = `"${document.sha256}"`;
    reply.header('etag', etag);
    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    if (isFresh(request, etag)) return reply.code(304).send();

    // The sandbox. See `renderableInline` for why a type the library sniffed is still not a type
    // this route will let a browser render. Two decisions, not one: `renderable` is the safety
    // question and governs the media type and the policy; `inline` is the caller's preference and
    // governs only the disposition, so `?download=true` on a PDF still says `application/pdf`.
    const renderable = renderableInline(document.mimeType);
    const inline = renderable && query.download !== true;
    reply.header('x-content-type-options', 'nosniff');
    // `X-Frame-Options` for the browsers that predate `frame-ancestors`, and only where the two
    // cannot disagree: it has no syntax for "this origin and that one", so where the operator has
    // named cross-origin callers it is left off and the CSP — which every current browser prefers
    // anyway — is the whole answer.
    const framedOrigins = Array.isArray(config.corsOrigin) ? config.corsOrigin : [];
    if (!inline) reply.header('x-frame-options', 'DENY');
    else if (framedOrigins.length === 0) reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('content-security-policy', contentSecurityPolicy(renderable, config.corsOrigin));
    reply.header(
      'content-disposition',
      contentDisposition(
        inline ? 'inline' : 'attachment',
        document.originalFilename ?? document.sha256.slice(0, 12),
      ),
    );
    reply.type(renderable ? document.mimeType : 'application/octet-stream');

    const range = parseRange(request.headers.range, document.byteSize);
    if (range === 'unsatisfiable') {
      reply.header('content-range', `bytes */${document.byteSize}`);
      throw new ApiError(
        'https://recueil.org/problems/validation',
        416,
        'Range not satisfiable',
        `The document is ${document.byteSize} bytes long.`,
      );
    }

    if (range === null) {
      reply.header('content-length', String(document.byteSize));
      return reply.send(await openBlob(recueil, document.sha256));
    }

    reply.code(206);
    reply.header('content-range', `bytes ${range.start}-${range.end}/${document.byteSize}`);
    reply.header('content-length', String(range.end - range.start + 1));
    return reply.send(await openBlob(recueil, document.sha256, range));
  });

  /* ---- trash and restore ------------------------------------------------------------------ */

  app.post(`${BASE}/:id/trash`, { config: { scope: 'documents:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    const body = parseOrThrow(TrashRequestSchema, request.body ?? {}, 'body');
    const row = recueil.documents.trashDocument(id, request.actor, {
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      ...(body.reasonDetail === undefined ? {} : { reasonDetail: body.reasonDetail }),
    });
    return sendJson(reply, DocumentSchema, documentToWire(row));
  });

  app.post(`${BASE}/:id/restore`, { config: { scope: 'documents:write' } }, async (request, reply) => {
    const { id } = parseOrThrow(z.object({ id: IdSchema }), request.params, 'path');
    return sendJson(
      reply,
      DocumentSchema,
      documentToWire(recueil.documents.restoreDocument(id, request.actor)),
    );
  });
};

/* -------------------------------------------------------------------------------------------- */
/* The sandboxed disposition                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * The types this route will let a browser render as a document, and nothing else.
 *
 * An allow-list rather than a deny-list, because the input is not a type somebody chose from a menu
 * — it is `documents.mime_type`, and §3.3 sniffs that from the bytes only when the bytes are
 * recognisable. `sniffMagic` returns `null` for any sequence holding a control character below
 * 0x09, and `sniffMimeType` then falls back to the *filename's* extension, which came out of a zip
 * member name or a MIME `filename` parameter. `htm` and `html` map to `text/html`. So the type on
 * the row is, for a whole family of inputs, exactly what an attacker wrote, and a deny-list would
 * be a list of the ways in somebody had thought of.
 *
 * Nothing scriptable is on it. HTML, XHTML and SVG are all documents with a script context; XML has
 * one in enough browsers to count. What is left is a set of formats a browser paints: PDF, the
 * raster images, and plain text, which cannot execute anything once `nosniff` stops the browser
 * from deciding it is really HTML.
 *
 * `application/pdf` is on the list deliberately and the reader depends on it — see
 * `contentSecurityPolicy`.
 */
const INLINE_RENDERABLE: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/apng',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'text/plain',
]);

const renderableInline = (mimeType: string): boolean =>
  INLINE_RENDERABLE.has(mimeType.split(';')[0]?.trim().toLowerCase() ?? '');

/**
 * The policy the bytes are rendered under.
 *
 * **Why the reader still works.** `apps/web` reads a PDF two ways and neither is broken by this.
 * `src/reader/pdf-reader.tsx` hands the content URL to PDF.js, which fetches it with XHR and paints
 * into a canvas — a fetch is not a navigation, so no disposition, CSP or `nosniff` applies to it at
 * all, and `Range` still works, which is what keeps the first page fast. `src/review/
 * subject-preview.tsx` embeds `<object data={contentUrl} type="application/pdf">`, which *is* a
 * navigation, and needs three things: `Content-Disposition: inline`, the real `application/pdf`
 * content type, and a `frame-ancestors` that admits the page doing the embedding. All three hold
 * for a PDF. An attacker's `text/html` gets none of them.
 *
 * `frame-ancestors 'self'` plus the configured CORS origins, because the UI is normally served from
 * the API's own origin and, in development, from Vite on another port — the origins the operator
 * has already named as allowed to talk to this API are exactly the ones allowed to frame it. A
 * wildcard `RECUEIL_CORS_ORIGIN=*` is deliberately *not* honoured here: somebody who opened up XHR
 * did not thereby ask to be clickjacked.
 *
 * The non-inline case adds `sandbox` with no tokens, which is the strongest statement available:
 * opaque origin, no scripts, no forms, no navigation. It is belt and braces over a response that is
 * already `attachment` and already `application/octet-stream`, and it costs nothing, because a
 * download is not rendered.
 */
const contentSecurityPolicy = (renderable: boolean, corsOrigin: string[] | boolean): string => {
  const directives = [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (!renderable) {
    directives.push("frame-ancestors 'none'", 'sandbox');
    return directives.join('; ');
  }
  const origins = Array.isArray(corsOrigin) ? corsOrigin : [];
  directives.push(`frame-ancestors 'self'${origins.map((origin) => ` ${origin}`).join('')}`);
  return directives.join('; ');
};

/**
 * A `Content-Disposition` that Node will accept, whatever the archive called the file.
 *
 * `documents.original_filename` is attacker-chosen: `packages/ingest/src/archive/safe-path.ts`
 * rejects NUL, absolute paths and `..`, and permits CR and LF. The previous sanitiser stripped
 * quotes and backslashes but not those, so `reply.header` threw `ERR_INVALID_CHAR` from inside the
 * handler — past `sendProblem`, so the caller got a raw Fastify 500 in the second error format the
 * application's own header warns about, and the document's bytes became permanently unreachable
 * through the API. A denial of access planted by whoever built the zip. Node's validation was doing
 * the work the sanitiser was supposed to; here the sanitiser does it.
 *
 * Both forms are emitted. The quoted one is ASCII and is what every client can read; `filename*`
 * carries the real name, which for this user's library is routinely `Rechnung_Müller.pdf`.
 */
const contentDisposition = (kind: 'inline' | 'attachment', filename: string): string => {
  // Control characters first, and from both forms: they are the ones that end the header.
  const cleaned = filename.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 200);
  const ascii = cleaned.replace(/[^\u0020-\u007e]/gu, '_').replace(/["\\]/gu, '').trim();
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/gu,
    (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`,
  );
  const name = ascii === '' ? 'document' : ascii;
  return `${kind}; filename="${name}"; filename*=UTF-8''${encoded === '' ? 'document' : encoded}`;
};

/* -------------------------------------------------------------------------------------------- */
/* Ranges and blobs                                                                                */
/* -------------------------------------------------------------------------------------------- */

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parse a single-range `Range` header.
 *
 * Only one range: multipart/byteranges is in the specification and is used by approximately nobody,
 * and answering a multi-range request with the whole document — which RFC 9110 permits — is both
 * correct and simpler than getting the multipart encoding wrong.
 */
export const parseRange = (
  header: string | string[] | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' => {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;

  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null) return null;

  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // `bytes=-500`: the last 500 bytes. A suffix longer than the file is the whole file.
    const suffix = Number.parseInt(rawEnd, 10);
    if (suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
};

/**
 * Open the bytes, as a stream where the backend has a path and as a buffer where it does not.
 *
 * Only the local backend has a filesystem path today; WebDAV and S3 arrive in Phase 2 and will
 * either expose a ranged read of their own or be read whole here. The branch is explicit so that
 * adding one is a change in one place.
 */
const openBlob = async (
  recueil: import('@recueil/core').Recueil,
  sha256: string,
  range?: ByteRange,
): Promise<NodeJS.ReadableStream | Buffer> => {
  if (recueil.storage.backend === 'local') {
    const path = recueil.storage.path(sha256);
    return range === undefined
      ? createReadStream(path)
      : createReadStream(path, { start: range.start, end: range.end });
  }
  const buffer = await recueil.storage.getBuffer(sha256);
  return range === undefined ? buffer : buffer.subarray(range.start, range.end + 1);
};

/* -------------------------------------------------------------------------------------------- */
/* The contract                                                                                    */
/* -------------------------------------------------------------------------------------------- */

export const documentPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    post: operation({
      operationId: 'uploadDocument',
      summary: 'Upload a file',
      description:
        'Multipart. The bytes are hashed while streaming, so the SHA-256 is computed and not ' +
        'accepted from the client (ADR-0004, P2). If the digest is already in the library the ' +
        'existing document is linked and no second copy is stored: the response says so with ' +
        '`created: false` and answers 200 rather than 201 (D1, CONCEPT.md §5.3 stage 2).\n\n' +
        'Send `itemId` to attach the file to an item in the same transaction, which is what a ' +
        'capture client does.',
      tags: DOCUMENT_TAGS,
      scope: 'documents:write',
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: UploadBodySchema } },
      },
      responses: {
        '200': jsonResponse('These bytes were already in the library; the existing document was linked.', DocumentUploadResultSchema),
        '201': jsonResponse('A new document was created.', DocumentUploadResultSchema),
        '413': {
          description: 'The upload exceeds `RECUEIL_MAX_UPLOAD_BYTES`.',
          content: { 'application/problem+json': { schema: z.unknown() } },
        },
        ...problems('401', '403', '415', '422'),
      },
    }),
  },
  [`${BASE}/by-sha256/{sha256}`]: {
    get: operation({
      operationId: 'getDocumentBySha256',
      summary: 'Look a document up by its digest',
      description:
        'The identity question of ADR-0004, asked directly: "do you already have these bytes?" A ' +
        'client that hashes before uploading can skip the upload entirely.',
      tags: DOCUMENT_TAGS,
      scope: 'documents:read',
      requestParams: { path: z.object({ sha256: Sha256Schema }) },
      responses: {
        '200': jsonResponse('The document.', DocumentSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}`]: {
    get: operation({
      operationId: 'getDocument',
      summary: 'Document metadata',
      description: 'Everything about the bytes except the bytes. For those, `GET /documents/{id}/content`.',
      tags: DOCUMENT_TAGS,
      scope: 'documents:read',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The document.', DocumentSchema),
        ...problems('401', '403', '404', '422'),
      },
    }),
  },
  [`${BASE}/{id}/content`]: {
    get: operation({
      operationId: 'downloadDocument',
      summary: 'Download the bytes',
      description:
        'Supports `Range`, which is what lets a PDF reader fetch the cross-reference table before ' +
        'the first page. The `ETag` is the SHA-256 and the bytes are immutable (D3), so the ' +
        'representation may be cached indefinitely.\n\n' +
        'Every response carries `X-Content-Type-Options: nosniff` and a restrictive ' +
        '`Content-Security-Policy`. `Content-Disposition: inline` is sent only for the types a ' +
        'browser paints rather than runs — PDF, the raster images, plain text; anything else, ' +
        'including HTML and SVG, is `attachment` and `application/octet-stream`, because the ' +
        "media type can be derived from a filename the uploader chose. `?download=true` forces " +
        'the attachment form for the inline types too.',
      tags: DOCUMENT_TAGS,
      scope: 'documents:read',
      requestParams: {
        path: idPath(),
        query: z.object({
          download: z.coerce.boolean().optional().meta({ description: '`Content-Disposition: attachment` rather than `inline`.' }),
        }),
        header: z.object({
          range: z.string().optional().meta({ description: 'A single byte range, e.g. `bytes=0-1023`.' }),
          'if-none-match': z.string().optional(),
        }),
      },
      responses: {
        // `*/*` and not `application/octet-stream`: the response carries the document's own MIME
        // type — `application/pdf`, `image/jpeg`, whatever was sniffed at ingest (§3.3) — and
        // declaring one concrete type would tell a generated client to expect a media type this
        // endpoint almost never sends. The schema is still the bytes.
        '200': { description: 'The whole document, in its own MIME type.', content: { '*/*': { schema: z.string().meta({ format: 'binary' }) } } },
        '206': { description: 'The requested byte range, in the document\'s own MIME type.', content: { '*/*': { schema: z.string().meta({ format: 'binary' }) } } },
        ...problems('304', '401', '403', '404', '416', '422'),
      },
    }),
  },
  [`${BASE}/{id}/trash`]: {
    post: operation({
      operationId: 'trashDocument',
      summary: 'Move a document to the trash',
      description:
        'Refused while any live attachment references it (D4, TR3): a trashed document behind a ' +
        'live attachment is a reference to bytes the library says are gone. Detach first. The blob ' +
        'is never removed — reclaiming storage is a separate, explicit operation (P5).',
      tags: DOCUMENT_TAGS,
      scope: 'documents:write',
      requestParams: { path: idPath() },
      requestBody: { required: false, content: { 'application/json': { schema: TrashRequestSchema } } },
      responses: {
        '200': jsonResponse('The trashed document.', DocumentSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
  [`${BASE}/{id}/restore`]: {
    post: operation({
      operationId: 'restoreDocument',
      summary: 'Restore a document from the trash',
      description: 'A row update and an audit row: the blob was never removed.',
      tags: DOCUMENT_TAGS,
      scope: 'documents:write',
      requestParams: { path: idPath() },
      responses: {
        '200': jsonResponse('The restored document.', DocumentSchema),
        ...problems('401', '403', '404', '409', '422'),
      },
    }),
  },
};
