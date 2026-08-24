/**
 * `POST /api/v1/ingestion/upload` — the share target.
 *
 * `POST /api/v1/documents` already stores bytes. This is a different operation: it puts the bytes
 * through the whole pipeline of CONCEPT §5.3 — duplicate check, archive extraction, type detection,
 * metadata extraction, the rule engine, the confidence gate — and answers with what the gate
 * decided. That is what a PWA share target needs: a person who has just shared a receipt from a
 * phone wants "filed as this item" or "queued for review because of this", in one round trip, and a
 * client that had to poll a job to find out which would show a spinner for the common case.
 *
 * Three properties.
 *
 * **Streaming and bounded.** The part is written to a spool file a chunk at a time and hashed on
 * the way past, so a forty-megabyte scan is never held in memory and in flight at once, and a file
 * over `RECUEIL_MAX_UPLOAD_BYTES` is refused during that pass. `@fastify/multipart`'s `truncated`
 * flag is checked: storing a prefix under the digest of that prefix would be a corrupt library that
 * looks correct.
 *
 * **The filename is never a path.** It is passed to the pipeline as `suggestedFilename`, which is
 * documented as informational — identity is the hash (P2) — and it is used in the `externalId` only
 * after being reduced to its basename, so a share sheet that sends `../../etc/passwd` names a
 * candidate and not a location.
 *
 * **One upload, one answer.** The response says which of the six pipeline outcomes happened and
 * carries the created item or the review entry, so a client renders one or the other.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';

import { newId } from '@recueil/core';
import { API_BASE_PATH } from '@recueil/schemas';
import { bufferCandidate } from '@recueil/ingest';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import * as z from 'zod';

import { sendJson } from '../http.js';
import { loadItemView } from '../item-view.js';
import { reviewEntryToWire } from '../ingestion/review.js';
import { jsonResponse, operation, problemResponse, problems } from '../openapi-kit.js';
import { ApiError } from '../problem.js';
import { IngestUploadResultSchema } from '../schemas-ingestion.js';
import { parseOrThrow, refuse } from '../validate.js';
import { documentToWire } from '../wire.js';

const BASE = `${API_BASE_PATH}/ingestion/upload`;

const UPLOAD_TAGS = ['Ingestion'] as const;

/** The fields the share target accepts beside the file itself. */
const UploadFieldsSchema = z.strictObject({
  sourceKind: z
    .enum(['upload', 'mobile', 'scanner', 'connector', 'api', 'folder', 'webdav', 'imap', 'import', 'plugin', 'derived'])
    .optional()
    .meta({ description: 'Which ingestion path this is. Defaults to `upload`; a phone share sheet should send `mobile`.' }),
  sourceId: z
    .string()
    .max(255)
    .optional()
    .meta({ description: 'Groups arrivals for the rule engine and the run journal. Defaults to `upload`.' }),
  title: z.string().max(1024).optional().meta({ description: 'A hint for the rule engine; never the identity.' }),
  sender: z.string().max(512).optional().meta({ description: 'Matched by rules on `sender`, as a mail source would set it.' }),
  subject: z.string().max(2048).optional().meta({ description: 'Matched by rules on `subject`.' }),
  runLabel: z.string().max(128).optional(),
});

/** The multipart body, described for the document rather than parsed by Zod. */
const UploadBodySchema = z
  .object({
    file: z.string().meta({ format: 'binary', description: 'The file. Required.' }),
    sourceKind: z.string().optional(),
    sourceId: z.string().optional(),
    title: z.string().optional(),
    sender: z.string().optional(),
    subject: z.string().optional(),
    runLabel: z.string().optional(),
  })
  .meta({ id: 'IngestUpload', title: 'IngestUpload', unusedIO: 'input' });

export const ingestionUploadRoutes: FastifyPluginAsync = async (app) => {
  const { library: recueil, config, ingestion } = app.recueil;

  app.post(BASE, { config: { scope: 'ingestion:write' } }, async (request, reply) => {
    if (!request.isMultipart()) {
      throw new ApiError(
        'https://recueil.org/problems/validation',
        415,
        'Unsupported media type',
        'Share a file as `multipart/form-data` with the bytes in a part named `file`.',
      );
    }

    const part = await request.file();
    if (part === undefined) {
      refuse('body.file', 'is required: the upload carried no file part.');
      return reply;
    }

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

    let digest: string;
    let byteSize: number;
    try {
      const hash = createHash('sha256');
      let size = 0;
      part.file.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.byteLength;
      });
      await streamPipeline(part.file, createWriteStream(spoolPath, { flags: 'wx' }));

      if (part.file.truncated) {
        throw new ApiError(
          'https://recueil.org/problems/validation',
          413,
          'Payload too large',
          `The upload exceeds RECUEIL_MAX_UPLOAD_BYTES (${config.maxUploadBytes} bytes).`,
        );
      }
      digest = hash.digest('hex');
      byteSize = size;
    } catch (error) {
      await rm(spoolPath, { force: true });
      throw error;
    }

    try {
      // The filename is reduced to its basename before it is used for anything at all. It is
      // informational to the pipeline, but it reaches a rule's `filename` condition and the run
      // journal's `externalId`, and neither should ever see a traversal.
      const filename = part.filename === undefined ? null : basename(part.filename);

      const bytes = await readFile(spoolPath);
      const candidate = bufferCandidate(bytes, {
        sourceId: fields.sourceId ?? 'upload',
        sourceKind: fields.sourceKind ?? 'upload',
        // The digest, not the filename: two shares of the same receipt from two phones are the same
        // arrival, and a name is not identity (P2).
        externalId: `sha256:${digest}`,
        ...(filename === null ? {} : { filename }),
        ...(part.mimetype === undefined ? {} : { mediaType: part.mimetype }),
        sourceMetadata: {
          ...(fields.title === undefined ? {} : { title: fields.title }),
          ...(fields.sender === undefined ? {} : { sender: fields.sender }),
          ...(fields.subject === undefined ? {} : { subject: fields.subject }),
          uploadedBy: request.principal.userId,
        },
      });

      const run = await ingestion.runner.ingestOne(candidate, {
        actor: request.actor,
        ...(fields.runLabel === undefined ? {} : { runLabel: fields.runLabel }),
      });
      const outcome = run.outcome;

      // Everything below is read back out of the library rather than taken from the outcome's own
      // account of itself: the document row, the item and the review entry are all queried by id.
      const documentId =
        outcome.status === 'failed' ? null : 'documentId' in outcome ? outcome.documentId ?? null : null;
      const document = documentId === null ? null : recueil.documents.getDocument(documentId);

      const itemId = outcome.status === 'ingested' ? outcome.itemId : null;
      const item = itemId === null ? null : loadItemView(recueil, itemId);

      const reviewEntry =
        outcome.status === 'review' ? ingestion.review.get(outcome.reviewQueueEntryId) : null;

      return sendJson(
        reply,
        IngestUploadResultSchema,
        {
          outcome: outcome.status,
          jobId: run.runId,
          document: document === null ? null : documentToWire(document),
          item,
          reviewEntry: reviewEntry === null ? null : reviewEntryToWire(reviewEntry),
          reasonCode:
            outcome.status === 'review'
              ? outcome.reasonCode
              : outcome.status === 'stopped'
                ? outcome.reasonCode
                : outcome.status === 'failed'
                  ? outcome.code
                  : null,
          detail: describeOutcome(outcome, byteSize),
        },
        outcome.status === 'ingested' ? 201 : 200,
      );
    } finally {
      await rm(spoolPath, { force: true });
    }
  });
};

/** One sentence a client can show without switching on the status itself. */
const describeOutcome = (
  outcome: { status: string; [key: string]: unknown },
  byteSize: number,
): string => {
  switch (outcome.status) {
    case 'ingested':
      return `${String(byteSize)} bytes were filed as a new item.`;
    case 'duplicate':
      return 'These exact bytes are already in the library; the new arrival was recorded and no second document was created.';
    case 'review':
      return `The document was stored and routed for review: ${String(outcome['reasonCode'])}.`;
    case 'container':
      return 'The archive was extracted; each member was ingested on its own.';
    case 'stopped':
      return `The pipeline refused the document: ${String(outcome['explanation'] ?? outcome['reasonCode'])}.`;
    default:
      return `Ingestion failed: ${String(outcome['message'] ?? 'unknown error')}.`;
  }
};

export const ingestionUploadPaths: ZodOpenApiPathsObject = {
  [BASE]: {
    post: operation({
      operationId: 'ingestUpload',
      summary: 'Share a file into the pipeline',
      description:
        'Multipart, streamed and hashed on the way past. Unlike `POST /api/v1/documents`, which ' +
        'stores bytes, this runs the whole ingestion pipeline (CONCEPT.md §5.3): duplicate check, ' +
        'archive extraction, type detection, metadata extraction, the stored rules and the ' +
        'confidence gate.\n\n' +
        'The answer is one of six outcomes and carries the created item or the review entry, so a ' +
        'PWA share target renders a result rather than polling a job. `201` when an item was ' +
        'created, `200` otherwise — including the duplicate case, which is a successful, ' +
        'idempotent re-share (P9).\n\n' +
        'This build runs no OCR (there is no worker to reach) and no resolvers, so a scan with no ' +
        'text layer will usually arrive in the review queue rather than being filed. The job id in ' +
        'the response leads to the full stage trace.',
      tags: UPLOAD_TAGS,
      scope: 'ingestion:write',
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: UploadBodySchema } },
      },
      responses: {
        '200': jsonResponse('What the pipeline decided.', IngestUploadResultSchema),
        '201': jsonResponse('An item was created.', IngestUploadResultSchema),
        '413': problemResponse('The file is larger than `RECUEIL_MAX_UPLOAD_BYTES`. Nothing was stored.'),
        ...problems('401', '403', '415', '422'),
      },
    }),
  },
};
