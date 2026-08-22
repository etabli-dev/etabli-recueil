/**
 * The controlled vocabularies of the data model.
 *
 * `spec/data-model.md` §1.1 draws a line that this module keeps: a **closed** vocabulary is a
 * `CHECK` constraint in the database and a `z.enum` here; an **open** vocabulary carries no
 * database constraint and is validated here as a slug, because the plugin host contributes to it
 * at runtime. Widening a closed vocabulary is a migration; widening an open one is an install.
 */
import * as z from 'zod';

import { SlugSchema } from './primitives.js';

/* -------------------------------------------------------------------------------------------- */
/* Item types — open (CONCEPT.md §5.2, spec/data-model.md §3.4)                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * The item types Recueil ships with. CONCEPT.md §5.2 lists the scholarly and office ends of the
 * range and then an ellipsis; `spec/data-model.md` §3.4 fixes the built-in set, which is this one.
 */
export const CORE_ITEM_TYPES = [
  'article',
  'book',
  'chapter',
  'report',
  'thesis',
  'dataset',
  'preprint',
  'webpage',
  'conference_paper',
  'software',
  'standard',
  'patent',
  'invoice',
  'letter',
  'contract',
  'receipt',
  'certificate',
  'photo',
  'note',
  'attachment_only',
] as const;

export type CoreItemType = (typeof CORE_ITEM_TYPES)[number];

/** The built-in item types, as a closed enum. Use it for exhaustive switches, not for validation. */
export const CoreItemTypeSchema = z.enum(CORE_ITEM_TYPES).meta({
  id: 'CoreItemType',
  title: 'CoreItemType',
  description: 'The item types Recueil ships with. A plugin may register further types.',
});

/**
 * The item type as validated on the wire. Open vocabulary: a plugin may register a type, so the
 * constraint is the slug shape rather than the built-in list (`spec/data-model.md` §1.1, §3.4).
 * `isCoreItemType` narrows to the built-in set when a caller needs exhaustiveness.
 */
export const ItemTypeSchema = SlugSchema.meta({
  id: 'ItemType',
  title: 'ItemType',
  description:
    'An item type slug. Open vocabulary: the built-in types are listed in `CoreItemType`, and ' +
    'plugins may register more, so the wire format validates the slug shape rather than a list.',
  examples: [...CORE_ITEM_TYPES],
});

const CORE_ITEM_TYPE_SET: ReadonlySet<string> = new Set<string>(CORE_ITEM_TYPES);

export const isCoreItemType = (value: string): value is CoreItemType => CORE_ITEM_TYPE_SET.has(value);

/* -------------------------------------------------------------------------------------------- */
/* Closed vocabularies                                                                             */
/* -------------------------------------------------------------------------------------------- */

export const LIBRARY_STATES = ['normal', 'merged', 'template'] as const;
export const LibraryStateSchema = z.enum(LIBRARY_STATES).meta({ id: 'LibraryState' });

export const MIME_SOURCES = ['sniffed', 'declared', 'extension', 'manual'] as const;
export const MimeSourceSchema = z.enum(MIME_SOURCES).meta({ id: 'MimeSource' });

export const STORAGE_BACKENDS = ['local', 'webdav', 's3'] as const;
export const StorageBackendSchema = z.enum(STORAGE_BACKENDS).meta({ id: 'StorageBackend' });

export const OCR_STATUSES = [
  'not_applicable',
  'not_needed',
  'pending',
  'done',
  'failed',
  'skipped',
] as const;
export const OcrStatusSchema = z.enum(OCR_STATUSES).meta({ id: 'OcrStatus' });

export const DOCUMENT_SOURCE_KINDS = [
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
] as const;
export const DocumentSourceKindSchema = z.enum(DOCUMENT_SOURCE_KINDS).meta({
  id: 'DocumentSourceKind',
  description: 'Which ingestion path put these bytes in the library (CONCEPT.md §5.3).',
});

export const ATTACHMENT_ROLES = [
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
] as const;
export const AttachmentRoleSchema = z.enum(ATTACHMENT_ROLES).meta({
  id: 'AttachmentRole',
  description: 'The part a file plays for one item (CONCEPT.md §5.2, spec/data-model.md §3.8).',
});

export const ATTACHMENT_LINK_MODES = ['stored', 'linked_file', 'linked_url'] as const;
export const AttachmentLinkModeSchema = z.enum(ATTACHMENT_LINK_MODES).meta({
  id: 'AttachmentLinkMode',
  description:
    '`stored` keeps the bytes in a Recueil backend, `linked_file` points at a path outside the ' +
    'store (desktop only) and `linked_url` is a bookmark with no bytes at all.',
});

export const ATTACHMENT_SOURCES = ['manual', 'ingest', 'import', 'connector', 'resolver', 'merge'] as const;
export const AttachmentSourceSchema = z.enum(ATTACHMENT_SOURCES).meta({ id: 'AttachmentSource' });

export const COLLECTION_KINDS = ['manual', 'smart'] as const;
export const CollectionKindSchema = z.enum(COLLECTION_KINDS).meta({ id: 'CollectionKind' });

export const QUERY_BACKENDS = ['fts5', 'meilisearch', 'sql'] as const;
export const QueryBackendSchema = z.enum(QUERY_BACKENDS).meta({ id: 'QueryBackend' });

export const TAG_SCHEMES = ['manual', 'automatic', 'imported'] as const;
export const TagSchemeSchema = z.enum(TAG_SCHEMES).meta({
  id: 'TagScheme',
  description: '`automatic` is a tag added by a rule or a resolver — Zotero tag type 1.',
});

export const ASSIGNMENT_SOURCES = ['manual', 'rule', 'resolver', 'import', 'connector', 'merge', 'plugin'] as const;
export const AssignmentSourceSchema = z.enum(ASSIGNMENT_SOURCES).meta({
  id: 'AssignmentSource',
  description: 'Why a tag, term or collection membership is on a record (P4).',
});

export const CUSTOM_FIELD_DATA_TYPES = [
  'text',
  'long_text',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'choice',
  'multi_choice',
  'json',
  'item_reference',
  'url',
  'monetary',
] as const;
export const CustomFieldDataTypeSchema = z.enum(CUSTOM_FIELD_DATA_TYPES).meta({
  id: 'CustomFieldDataType',
  description: 'Closed vocabulary; immutable once any value exists (spec/data-model.md §4.6, CF1).',
});

export const CUSTOM_FIELD_SCOPES = ['library', 'review'] as const;
export const CustomFieldScopeSchema = z.enum(CUSTOM_FIELD_SCOPES).meta({ id: 'CustomFieldScope' });

export const NOTE_FORMATS = ['markdown', 'html'] as const;
export const NoteSourceFormatSchema = z.enum(NOTE_FORMATS).meta({ id: 'NoteSourceFormat' });

export const NOTE_KINDS = ['note', 'quote', 'thought', 'summary', 'email_body'] as const;
export const NoteKindSchema = z.enum(NOTE_KINDS).meta({ id: 'NoteKind' });

export const ANNOTATION_TYPES = [
  'highlight',
  'underline',
  'strikeout',
  'note',
  'area',
  'ink',
  'text',
] as const;
export const AnnotationTypeSchema = z.enum(ANNOTATION_TYPES).meta({ id: 'AnnotationType' });

/** The W3C Web Annotation motivations Recueil uses (ADR-0009). */
export const ANNOTATION_MOTIVATIONS = [
  'highlighting',
  'commenting',
  'describing',
  'questioning',
  'bookmarking',
] as const;
export const AnnotationMotivationSchema = z.enum(ANNOTATION_MOTIVATIONS).meta({
  id: 'AnnotationMotivation',
  description: 'W3C Web Annotation motivation (ADR-0009).',
});

export const ANNOTATION_BODY_FORMATS = ['markdown', 'text'] as const;
export const AnnotationBodyFormatSchema = z.enum(ANNOTATION_BODY_FORMATS).meta({
  id: 'AnnotationBodyFormat',
});

export const CREATOR_KINDS = ['person', 'organisation'] as const;
export const CreatorKindSchema = z.enum(CREATOR_KINDS).meta({ id: 'CreatorKind' });

export const CREATOR_ROLES = [
  'author',
  'editor',
  'translator',
  'contributor',
  'series_editor',
  'recipient',
  'interviewer',
  'director',
  'reviewed_author',
  'sender',
  'correspondent',
] as const;
export const CreatorRoleSchema = z.enum(CREATOR_ROLES).meta({
  id: 'CreatorRole',
  description: 'Closed vocabulary, extended by a migration and never by a plugin.',
});

export const DISAMBIGUATION_STATUSES = ['unreviewed', 'confirmed', 'ambiguous', 'merged'] as const;
export const DisambiguationStatusSchema = z.enum(DISAMBIGUATION_STATUSES).meta({
  id: 'DisambiguationStatus',
});

export const OA_STATUSES = ['closed', 'green', 'bronze', 'hybrid', 'gold', 'diamond', 'unknown'] as const;
export const OaStatusSchema = z.enum(OA_STATUSES).meta({ id: 'OaStatus' });

export const RETRACTION_STATUSES = [
  'none',
  'retracted',
  'corrected',
  'expression_of_concern',
  'withdrawn',
  'unknown',
] as const;
export const RetractionStatusSchema = z.enum(RETRACTION_STATUSES).meta({
  id: 'RetractionStatus',
  description: 'Outcome of the `retraction` check (CONCEPT.md §5.5).',
});

export const VERIFICATION_STATUSES = ['unverified', 'verified', 'disputed', 'unverifiable'] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES).meta({
  id: 'VerificationStatus',
  description:
    'Outcome of the `existence` and `doi_resolves` checks. `unverifiable` is the "possible ' +
    'fabrication" verdict of CONCEPT.md §5.5.',
});

export const OFFICE_DOCUMENT_TYPES = [
  'invoice',
  'letter',
  'contract',
  'receipt',
  'statement',
  'certificate',
  'payslip',
  'tax',
  'medical',
  'other',
] as const;
export const CoreOfficeDocumentTypeSchema = z.enum(OFFICE_DOCUMENT_TYPES).meta({
  id: 'CoreOfficeDocumentType',
});

/** Open vocabulary: the Paperless-ngx importer carries user-defined document types across (§3.7). */
export const OfficeDocumentTypeSchema = SlugSchema.meta({
  id: 'OfficeDocumentType',
  description:
    'An office document type slug. Open vocabulary, because the Paperless-ngx importer carries ' +
    'user-defined types across (CONCEPT.md §6).',
  examples: [...OFFICE_DOCUMENT_TYPES],
});

/* -------------------------------------------------------------------------------------------- */
/* Provenance sources — open, because a plugin is a source (spec/data-model.md §3.6)                */
/* -------------------------------------------------------------------------------------------- */

export const CORE_PROVENANCE_SOURCES = [
  'manual',
  'import:zotero',
  'import:paperless',
  'crossref',
  'openalex',
  'pubmed',
  'semantic_scholar',
  'datacite',
  'arxiv',
  'openlibrary',
  'google_books',
  'orcid',
  'unpaywall',
  'grobid',
  'heuristic',
  'rule',
] as const;

export const PROVENANCE_SOURCE_PATTERN = /^(?:[a-z][a-z0-9_]*)(?::[a-z0-9][a-z0-9_.-]*)?$/;

export const ProvenanceSourceSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(
    PROVENANCE_SOURCE_PATTERN,
    'must be a source slug, optionally qualified — e.g. `crossref`, `import:zotero`, `plugin:resolver-openalex`',
  )
  .meta({
    id: 'ProvenanceSource',
    description:
      'Where a derived fact came from (P4). Open vocabulary: `plugin:<name>` is a legitimate ' +
      'source, so the shape is validated rather than the list.',
    examples: [...CORE_PROVENANCE_SOURCES, 'plugin:resolver-openalex'],
  });

export const PROVENANCE_ENTITY_TYPES = [
  'item_bibliographic',
  'item_office',
  'creator',
  'item_creator',
] as const;
export const ProvenanceEntityTypeSchema = z.enum(PROVENANCE_ENTITY_TYPES).meta({
  id: 'ProvenanceEntityType',
});
