/**
 * Document — one row per distinct byte sequence in the library (`spec/data-model.md` §3.3).
 *
 * Identity is the SHA-256 of the bytes (ADR-0004, P2). Path, filename and mtime are metadata and
 * never define sameness, which is why none of them is writable after ingestion.
 */
import * as z from 'zod';

import {
  CountSchema,
  IdSchema,
  JsonObjectSchema,
  Sha256Schema,
  ShortTextSchema,
  SimhashSchema,
  TimestampSchema,
} from '../primitives.js';
import {
  DocumentSourceKindSchema,
  MimeSourceSchema,
  OcrStatusSchema,
  StorageBackendSchema,
} from '../vocabularies.js';

const MimeTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, 'must be a MIME type')
  .meta({ id: 'MimeType', examples: ['application/pdf'] });

/** Fields the ingestion pipeline writes and a client never sets directly. */
const documentServerShape = {
  id: IdSchema,
  /** Sniffed, never trusted from the uploader (§3.3). */
  mimeType: MimeTypeSchema,
  mimeSource: MimeSourceSchema,
  byteSize: CountSchema.meta({ description: 'Size of the stored bytes.' }),
  storageBackend: StorageBackendSchema,
  storageKey: z
    .string()
    .min(1)
    .max(1024)
    .meta({ description: 'Backend-relative key. For `local`: `<aa>/<bb>/<sha256>` per ADR-0004.' }),
  storageVerifiedAt: TimestampSchema.nullish(),
  storageOk: z
    .boolean()
    .meta({ description: 'Set false by the `attachment_integrity` check on a hash mismatch (D2).' }),
  pageCount: CountSchema.nullish(),
  hasTextLayer: z.boolean().nullish().meta({ description: 'Null until the file has been examined.' }),
  textExtractedAt: TimestampSchema.nullish(),
  textCharCount: CountSchema.nullish(),
  ocrStatus: OcrStatusSchema,
  simhash: SimhashSchema.nullish(),
  ingestedAt: TimestampSchema.meta({ description: 'First time these bytes entered the library.' }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  trashedAt: TimestampSchema.nullish(),
} as const;

/** Fields supplied when a file is registered, and preserved verbatim afterwards. */
const documentWritableShape = {
  sha256: Sha256Schema,
  originalFilename: ShortTextSchema.nullish().meta({
    description: 'As received. Purely informational — it never defines identity (P2).',
  }),
  sourceKind: DocumentSourceKindSchema,
  sourceRef: z
    .string()
    .max(2048)
    .nullish()
    .meta({ description: 'Watched-folder path, IMAP message-id, capture URL, importer record id.' }),
  sourceDetail: JsonObjectSchema.meta({
    description: 'Sender, subject, scanner id, connector page title, archive member path.',
  }),
  parentDocumentId: IdSchema.nullish().meta({
    description: 'Set when this document was extracted from an archive (CONCEPT.md §5.3 stage 3).',
  }),
} as const;

export const DocumentSchema = z
  .strictObject({ ...documentServerShape, ...documentWritableShape })
  .meta({
    id: 'Document',
    title: 'Document',
    description:
      'A distinct byte sequence in the library. Identified by its SHA-256 (ADR-0004): ingesting ' +
      'bytes whose hash already exists links the existing document rather than storing a copy.',
  });

/**
 * Registering a document. The bytes arrive separately (multipart upload or a storage backend
 * reference); everything derived from them — size, MIME type, storage key, text layer — is the
 * server's to compute, so it is absent here.
 */
export const DocumentCreateSchema = z
  .strictObject({
    ...documentWritableShape,
    sha256: Sha256Schema.meta({
      description:
        'The digest the client computed. The server recomputes it and rejects a mismatch rather ' +
        'than trusting the claim.',
    }),
    sourceDetail: JsonObjectSchema.optional(),
    mimeTypeHint: MimeTypeSchema.optional().meta({
      description: 'Declared MIME type. Advisory: the server sniffs and may disagree.',
    }),
    originalFilename: ShortTextSchema.optional(),
    ingestedAt: TimestampSchema.optional().meta({
      description: 'Importers preserve the original timestamp; ordinary uploads leave it unset.',
    }),
  })
  .meta({ id: 'DocumentCreate', title: 'DocumentCreate', unusedIO: 'input' });

/**
 * Updating a document. Deliberately tiny: the bytes are immutable (D3), so only the informational
 * metadata and the operator's manual MIME correction can move.
 */
export const DocumentUpdateSchema = z
  .strictObject({
    originalFilename: ShortTextSchema.nullish(),
    mimeType: MimeTypeSchema.optional().meta({
      description: 'A manual correction. Sets `mimeSource` to `manual`.',
    }),
    sourceDetail: JsonObjectSchema.optional(),
  })
  .meta({ id: 'DocumentUpdate', title: 'DocumentUpdate', unusedIO: 'input' });

export type Document = z.infer<typeof DocumentSchema>;
export type DocumentCreate = z.infer<typeof DocumentCreateSchema>;
export type DocumentUpdate = z.infer<typeof DocumentUpdateSchema>;
export { MimeTypeSchema };
