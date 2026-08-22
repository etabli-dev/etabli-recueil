/**
 * The Recueil relational schema, Phase 1.
 *
 * This file is `spec/data-model.md` expressed in Drizzle. It carries the tables the first phase
 * needs — the library core, organisation and content, people, and operations — and nothing more;
 * the graph, curated-network and systematic-review tables arrive with the phases that serve them
 * (`spec/data-model.md` §11).
 *
 * Everything here is written against the SQLite/Postgres intersection (ADR-0003), which is what
 * makes the same migration series run on both:
 *
 * - no enumerated types — a closed vocabulary is `TEXT` plus a `CHECK`, an open one is `TEXT` with
 *   no constraint, validated by Zod in `@recueil/schemas` against a registry the plugin host
 *   contributes to (§1.1);
 * - no arrays — a repeated value is a child table, or `JSON` where the value is opaque to SQL;
 * - no `uuid`, `money`, `inet` or `tsvector` columns; money is `INTEGER` minor units plus an
 *   ISO-4217 code, and the full-text index is dialect-specific and lives outside this schema (§9);
 * - timestamps are fixed-width ISO-8601 UTC text, so lexicographic order is chronological order;
 * - case-insensitive lookups go through a stored `*_normalised` column, never `lower()`;
 * - a unique rule over a nullable column goes through a `COALESCE(col, '')` mirror, because `NULL`s
 *   are distinct in a unique index in both dialects;
 * - `ON DELETE` is `RESTRICT` almost everywhere, because P5 says nothing is deleted; `CASCADE`
 *   appears only on join and child rows that have no independent meaning.
 *
 * The three deliberately dialect-specific fragments named by the spec are the `json_valid` checks
 * below, the `FOR UPDATE SKIP LOCKED` a Postgres job claim needs (§6.3, IK5) and the trigger that
 * makes `audit_log` insert-only (§6.5, AL1).
 *
 * Departures from `spec/data-model.md`, each deliberate and recorded in `README.md`:
 *
 * - `document_provenance` (§below) is not in the spec. It exists because D1 says the same bytes are
 *   one row however often they arrive, while P4 says every derived fact carries its source: without
 *   a child table the second arrival's provenance has nowhere to go but the audit log.
 * - Columns whose foreign key target is a later phase (`tags.term_id` → `terms`,
 *   `custom_fields.plugin_id` → `plugins`, `items.promoted_from_shadow_work_id` → `shadow_works`,
 *   `jobs.plugin_id` → `plugins`, the `field_values` review columns) are omitted here and added by
 *   the migration of the phase that brings their target, exactly as §11 prescribes.
 *   `audit_log.actor_plugin_id` is the one exception: the column is present without a foreign key,
 *   because AL2 requires an actor column for every `actor_type` and `plugin` is one of them.
 */
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/* -------------------------------------------------------------------------------------------- */
/* Constraint helpers                                                                              */
/* -------------------------------------------------------------------------------------------- */

const quoted = (column: string) => `"${column}"`;
const literals = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/** A closed vocabulary on a `NOT NULL` column (§1.1: no enumerated types). */
const oneOf = (name: string, column: string, values: readonly string[]) =>
  check(name, sql.raw(`${quoted(column)} in (${literals(values)})`));

/** A closed vocabulary on a nullable column. */
const oneOfOrNull = (name: string, column: string, values: readonly string[]) =>
  check(name, sql.raw(`${quoted(column)} is null or ${quoted(column)} in (${literals(values)})`));

/** `BOOLEAN` is `INTEGER` plus this check in SQLite, and a real boolean in Postgres (§1.1). */
const boolean01 = (name: string, column: string) =>
  check(name, sql.raw(`${quoted(column)} in (0, 1)`));

/** `JSON` is TEXT plus this check in SQLite; Postgres gets the guarantee from `jsonb` (§1.1). */
const jsonValid = (name: string, column: string) =>
  check(name, sql.raw(`json_valid(${quoted(column)})`));

const jsonValidOrNull = (name: string, column: string) =>
  check(name, sql.raw(`${quoted(column)} is null or json_valid(${quoted(column)})`));

/** A confidence, where the column allows one (§3.6). */
const confidence01 = (name: string, column: string) =>
  check(
    name,
    sql.raw(`${quoted(column)} is null or (${quoted(column)} >= 0 and ${quoted(column)} <= 1)`),
  );

const live = sql`trashed_at is null`;

/* -------------------------------------------------------------------------------------------- */
/* Vocabularies used as database CHECK constraints                                                 */
/*                                                                                                 */
/* These repeat the closed vocabularies of `@recueil/schemas`. The repetition is deliberate: the    */
/* Zod enum is the wire contract and this is the storage constraint, and a migration must not       */
/* silently change shape because a dependency was upgraded. A test asserts the two agree.           */
/* -------------------------------------------------------------------------------------------- */

export const TOKEN_CLIENTS = [
  'cli',
  'mcp',
  'connector',
  'r',
  'python',
  'web_session',
  'bib_feed',
  'other',
] as const;
export const MIME_SOURCES = ['sniffed', 'declared', 'extension', 'manual'] as const;
export const STORAGE_BACKENDS = ['local', 'webdav', 's3'] as const;
export const OCR_STATUSES = [
  'not_applicable',
  'not_needed',
  'pending',
  'done',
  'failed',
  'skipped',
] as const;
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
export const LIBRARY_STATES = ['normal', 'merged', 'template'] as const;
export const OA_STATUSES = [
  'closed',
  'green',
  'bronze',
  'hybrid',
  'gold',
  'diamond',
  'unknown',
] as const;
export const RETRACTION_STATUSES = [
  'none',
  'retracted',
  'corrected',
  'expression_of_concern',
  'withdrawn',
  'unknown',
] as const;
export const VERIFICATION_STATUSES = ['unverified', 'verified', 'disputed', 'unverifiable'] as const;
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
export const ATTACHMENT_LINK_MODES = ['stored', 'linked_file', 'linked_url'] as const;
export const ATTACHMENT_SOURCES = [
  'manual',
  'ingest',
  'import',
  'connector',
  'resolver',
  'merge',
] as const;
export const COLLECTION_KINDS = ['manual', 'smart'] as const;
export const QUERY_BACKENDS = ['fts5', 'meilisearch', 'sql'] as const;
export const MEMBERSHIP_SOURCES = ['manual', 'rule', 'import', 'connector', 'merge', 'plugin'] as const;
export const TAG_SCHEMES = ['manual', 'automatic', 'imported'] as const;
export const TAG_ASSIGNMENT_SOURCES = [
  'manual',
  'rule',
  'resolver',
  'import',
  'plugin',
  'merge',
] as const;
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
export const CUSTOM_FIELD_SCOPES = ['library', 'review'] as const;
export const NOTE_FORMATS = ['markdown', 'html'] as const;
export const NOTE_KINDS = ['note', 'quote', 'thought', 'summary', 'email_body'] as const;
export const ANNOTATION_TYPES = [
  'highlight',
  'underline',
  'strikeout',
  'note',
  'area',
  'ink',
  'text',
] as const;
export const ANNOTATION_MOTIVATIONS = [
  'highlighting',
  'commenting',
  'describing',
  'questioning',
  'bookmarking',
] as const;
export const ANNOTATION_BODY_FORMATS = ['markdown', 'text'] as const;
export const CREATOR_KINDS = ['person', 'organisation'] as const;
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
export const DISAMBIGUATION_STATUSES = ['unreviewed', 'confirmed', 'ambiguous', 'merged'] as const;
export const JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'waiting_review',
  'dead',
] as const;
export const JOB_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const ACTOR_TYPES = ['user', 'token', 'system', 'plugin', 'job', 'mcp', 'import'] as const;
export const TRASH_ENTITY_TYPES = [
  'item',
  'document',
  'attachment',
  'collection',
  'note',
  'annotation',
  'tag',
  'creator',
  'review',
  'curated_network',
] as const;
export const TRASH_REASONS = ['user', 'merge', 'import_rollback', 'cascade', 'plugin'] as const;

/* ============================================================================================== */
/* 3. Library core                                                                                 */
/* ============================================================================================== */

/**
 * `users` — the account a record belongs to and an action is attributed to (§3.1).
 *
 * One row in v1. The column set is already what a multi-user deployment needs, so adding accounts
 * is a data change and not a migration (§1.4). Deactivation never removes the row, because every
 * `audit_log` actor must keep resolving (P5).
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    /** NFKC casefolded; the uniqueness key (§1.1). */
    usernameNormalised: text('username_normalised').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    /** argon2id. Null when the account authenticates by token only. */
    passwordHash: text('password_hash'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(true),
    locale: text('locale'),
    /** IANA name. Presentation only — it never affects storage. */
    timezone: text('timezone'),
    settings: text('settings').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastSeenAt: text('last_seen_at'),
    trashedAt: text('trashed_at'),
  },
  (table) => [
    uniqueIndex('ux_users_username_normalised').on(table.usernameNormalised),
    boolean01('ck_users_is_active_bool', 'is_active'),
    boolean01('ck_users_is_admin_bool', 'is_admin'),
    jsonValid('ck_users_settings_json', 'settings'),
  ],
);

/**
 * `api_tokens` — scoped bearer credentials, and the web UI's session cookie (§3.2).
 *
 * The secret itself is never stored: `token_hash` is its SHA-256 and `token_prefix` is the first
 * twelve characters, kept in clear for display and for a cheap lookup. Revocation is never a delete
 * (A3), because `audit_log.actor_token_id` must keep resolving.
 */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** JSON array of scope strings (`items:read`, `sr:write`, …). */
    scopes: text('scopes').notNull().default('[]'),
    client: text('client', { enum: TOKEN_CLIENTS }).notNull(),
    createdAt: text('created_at').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    expiresAt: text('expires_at'),
    /** Written at most once per minute per token, to avoid a write per request. */
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
    note: text('note'),
  },
  (table) => [
    uniqueIndex('ux_api_tokens_token_hash').on(table.tokenHash),
    uniqueIndex('ux_api_tokens_token_prefix').on(table.tokenPrefix),
    index('ix_api_tokens_user_id').on(table.userId),
    oneOf('ck_api_tokens_client', 'client', TOKEN_CLIENTS),
    jsonValid('ck_api_tokens_scopes_json', 'scopes'),
  ],
);

/**
 * `documents` — one row per distinct byte sequence in the library (§3.3).
 *
 * This is the content-addressed layer of ADR-0004: identity is the SHA-256 of the bytes, and path,
 * filename and mtime are metadata that never define sameness (P2). `ux_documents_sha256` is the
 * single most important constraint in the schema — it is what makes exact deduplication free and
 * total, and it is what invariant D1 rests on.
 *
 * Documents are deliberately unowned (§1.4): a document is content, and the same bytes may be
 * reachable from two users' items. Access is decided at the `attachments` row.
 */
export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    /** 64 lowercase hex characters. The identity (ADR-0004). */
    sha256: text('sha256').notNull(),
    byteSize: integer('byte_size').notNull(),
    /** Sniffed, not trusted from the uploader. */
    mimeType: text('mime_type').notNull(),
    mimeSource: text('mime_source', { enum: MIME_SOURCES }).notNull(),
    /** As received; purely informational. */
    originalFilename: text('original_filename'),
    storageBackend: text('storage_backend', { enum: STORAGE_BACKENDS }).notNull(),
    /** Backend-relative key. For `local`: `<aa>/<bb>/<sha256>` per ADR-0004. */
    storageKey: text('storage_key').notNull(),
    storageVerifiedAt: text('storage_verified_at'),
    /** Set false by the `attachment_integrity` check on a hash mismatch (D2). */
    storageOk: integer('storage_ok', { mode: 'boolean' }).notNull().default(true),
    pageCount: integer('page_count'),
    hasTextLayer: integer('has_text_layer', { mode: 'boolean' }),
    textExtractedAt: text('text_extracted_at'),
    textCharCount: integer('text_char_count'),
    ocrStatus: text('ocr_status', { enum: OCR_STATUSES }).notNull().default('not_applicable'),
    /** 16 hex characters over the extracted text: the near-duplicate blocking key (CONCEPT §5.6). */
    simhash: text('simhash'),
    sourceKind: text('source_kind', { enum: DOCUMENT_SOURCE_KINDS }).notNull(),
    sourceRef: text('source_ref'),
    sourceDetail: text('source_detail').notNull().default('{}'),
    /** Set when this document was extracted from an archive (CONCEPT §5.3 stage 3). */
    parentDocumentId: text('parent_document_id').references((): AnySQLiteColumn => documents.id, {
      onDelete: 'restrict',
    }),
    /** First time these bytes entered the library. */
    ingestedAt: text('ingested_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    trashedAt: text('trashed_at'),
  },
  (table) => [
    uniqueIndex('ux_documents_sha256').on(table.sha256),
    index('ix_documents_mime_type').on(table.mimeType),
    index('ix_documents_ingested_at').on(table.ingestedAt),
    index('ix_documents_simhash')
      .on(table.simhash)
      .where(sql`simhash is not null and trashed_at is null`),
    index('ix_documents_source').on(table.sourceKind, table.sourceRef),
    index('ix_documents_parent_document_id')
      .on(table.parentDocumentId)
      .where(sql`parent_document_id is not null`),
    index('ix_documents_live').on(table.ingestedAt).where(live),
    check('ck_documents_sha256_shape', sql`length("sha256") = 64`),
    check('ck_documents_byte_size', sql`"byte_size" >= 0`),
    check('ck_documents_storage', sql`"storage_key" <> ''`),
    oneOf('ck_documents_mime_source', 'mime_source', MIME_SOURCES),
    oneOf('ck_documents_storage_backend', 'storage_backend', STORAGE_BACKENDS),
    oneOf('ck_documents_ocr_status', 'ocr_status', OCR_STATUSES),
    oneOf('ck_documents_source_kind', 'source_kind', DOCUMENT_SOURCE_KINDS),
    boolean01('ck_documents_storage_ok_bool', 'storage_ok'),
    boolean01('ck_documents_has_text_layer_bool', 'has_text_layer'),
    jsonValid('ck_documents_source_detail_json', 'source_detail'),
  ],
);

/**
 * `document_provenance` — one row per ingestion event (P4).
 *
 * Not in `spec/data-model.md`, and the reason it is here is the tension between two rules the spec
 * does state. D1 says bytes already known never insert a second `documents` row: the pipeline links
 * the existing document and stops at CONCEPT §5.3 stage 2. P4 says every derived fact carries its
 * source, timestamp and confidence. The second arrival of the same PDF — the same paper mailed by a
 * colleague after it was already downloaded — is a fact about the library with a different source,
 * and with only the columns on `documents` it would overwrite the first or be dropped.
 *
 * So `documents` keeps the provenance of the arrival that created it, and this table keeps every
 * arrival, including that one. `is_first` marks which row is the origin. The rows are also what
 * `ingest.file:<sha256>:<source_kind>:<source_ref>` (§6.3, IK1) counts as distinct work.
 */
export const documentProvenance = sqliteTable(
  'document_provenance',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    /** Denormalised from the document, so a provenance row is self-describing in an export. */
    sha256: text('sha256').notNull(),
    sourceKind: text('source_kind', { enum: DOCUMENT_SOURCE_KINDS }).notNull(),
    sourceRef: text('source_ref'),
    sourceDetail: text('source_detail').notNull().default('{}'),
    originalFilename: text('original_filename'),
    /** The MIME type the caller claimed, kept beside the sniffed one for the same reason (§3.3). */
    declaredMimeType: text('declared_mime_type'),
    /** True on the arrival that created the `documents` row; false on every later one. */
    isFirst: integer('is_first', { mode: 'boolean' }).notNull().default(false),
    observedAt: text('observed_at').notNull(),
    jobId: text('job_id'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('ix_document_provenance_document').on(table.documentId, table.observedAt),
    index('ix_document_provenance_sha256').on(table.sha256),
    index('ix_document_provenance_source').on(table.sourceKind, table.sourceRef),
    uniqueIndex('ux_document_provenance_first')
      .on(table.documentId)
      .where(sql`is_first = 1`),
    oneOf('ck_document_provenance_source_kind', 'source_kind', DOCUMENT_SOURCE_KINDS),
    boolean01('ck_document_provenance_is_first_bool', 'is_first'),
    jsonValid('ck_document_provenance_source_detail_json', 'source_detail'),
  ],
);

/**
 * `items` — the library record, the thing a user thinks of as "an entry" (§3.4).
 *
 * An item exists independently of whether any file is attached. `item_type` is an **open**
 * vocabulary and therefore carries no database `CHECK`: a plugin may register a type, and Zod
 * validates the slug shape against the runtime registry instead (§1.1, open question O3).
 */
export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    /** Eight-character Zotero-key-shaped public key (§1.3). */
    publicId: text('public_id').notNull(),
    itemType: text('item_type').notNull(),
    /** Mirrors `item_bibliographic.title` when that facet exists (I3). */
    title: text('title'),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    libraryState: text('library_state', { enum: LIBRARY_STATES }).notNull().default('normal'),
    /** Set when this item lost a dedup merge (CONCEPT §5.6). Such an item is always trashed (I2). */
    mergedIntoItemId: text('merged_into_item_id').references((): AnySQLiteColumn => items.id, {
      onDelete: 'restrict',
    }),
    sourceSystem: text('source_system'),
    sourceId: text('source_id'),
    /** Zotero's free-text Extra field, preserved verbatim for round-tripping (P10). */
    extra: text('extra'),
    version: integer('version').notNull().default(1),
    dateAdded: text('date_added').notNull(),
    dateModified: text('date_modified').notNull(),
    trashedAt: text('trashed_at'),
  },
  (table) => [
    uniqueIndex('ux_items_public_id').on(table.publicId),
    /** What makes the Zotero and Paperless importers idempotent (P9, CONCEPT §6). */
    uniqueIndex('ux_items_source')
      .on(table.sourceSystem, table.sourceId)
      .where(sql`source_system is not null and source_id is not null`),
    index('ix_items_item_type').on(table.itemType),
    index('ix_items_owner_live').on(table.ownerUserId, table.dateModified).where(live),
    index('ix_items_date_added').on(table.dateAdded),
    index('ix_items_merged_into')
      .on(table.mergedIntoItemId)
      .where(sql`merged_into_item_id is not null`),
    oneOf('ck_items_library_state', 'library_state', LIBRARY_STATES),
    check('ck_items_version', sql`"version" >= 1`),
    check(
      'ck_items_merged',
      sql`("library_state" = 'merged') = ("merged_into_item_id" is not null)`,
    ),
  ],
);

/**
 * `item_bibliographic` — the scholarly facet (§3.5).
 *
 * A separate table rather than nullable columns on `items`, because roughly half a real library —
 * invoices, letters, photos — will never have any of it, and because per-field provenance attaches
 * to this facet specifically (§3.6, arriving with Phase 3).
 *
 * `item_trashed_at` is mirrored from the parent purely so that "unique among live items" can be a
 * partial unique index rather than a join (§1.1).
 */
export const itemBibliographic = sqliteTable(
  'item_bibliographic',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'restrict' }),
    /** CSL item type, when it differs from the Recueil `item_type` mapping. */
    cslType: text('csl_type'),
    title: text('title'),
    subtitle: text('subtitle'),
    /** Feeds the citation key formula (ADR-0016). */
    shortTitle: text('short_title'),
    /** Journal, book, proceedings — bibliometrix `SO`. */
    containerTitle: text('container_title'),
    containerShort: text('container_short'),
    collectionTitle: text('collection_title'),
    collectionNumber: text('collection_number'),
    publisher: text('publisher'),
    publisherPlace: text('publisher_place'),
    edition: text('edition'),
    /** TEXT, not INTEGER — volumes are `12`, `12A`, `II`. */
    volume: text('volume'),
    issue: text('issue'),
    pages: text('pages'),
    pageFirst: integer('page_first'),
    pageLast: integer('page_last'),
    numberOfPages: integer('number_of_pages'),
    /** EDTF. May be year-only; the canonical publication date. */
    issuedDate: text('issued_date'),
    /** Derived from `issued_date`; bibliometrix `PY`, and the only date safe to range-index. */
    issuedYear: integer('issued_year'),
    issuedMonth: integer('issued_month'),
    availableDate: text('available_date'),
    accessedAt: text('accessed_at'),
    /** Lowercase, without the resolver prefix (B1). */
    doi: text('doi'),
    pmid: text('pmid'),
    pmcid: text('pmcid'),
    arxivId: text('arxiv_id'),
    isbn: text('isbn'),
    issn: text('issn'),
    eissn: text('eissn'),
    /** Linking ISSN — the venue key the graph nodes will use. */
    issnL: text('issn_l'),
    openalexId: text('openalex_id'),
    semanticScholarId: text('semantic_scholar_id'),
    dataciteDoi: text('datacite_doi'),
    handle: text('handle'),
    url: text('url'),
    /** bibliometrix `AB`. */
    abstract: text('abstract'),
    languageCode: text('language_code'),
    /** Stable, exported to BibTeX; bibliometrix `SR`. */
    citationKey: text('citation_key'),
    citationKeyLocked: integer('citation_key_locked', { mode: 'boolean' }).notNull().default(false),
    citationKeyFormula: text('citation_key_formula'),
    /** SPDX id or licence URL. The CSL-JSON key is `license`; our prose is British English. */
    licence: text('licence'),
    oaStatus: text('oa_status', { enum: OA_STATUSES }),
    oaUrl: text('oa_url'),
    oaCheckedAt: text('oa_checked_at'),
    isPreprint: integer('is_preprint', { mode: 'boolean' }).notNull().default(false),
    publishedVersionDoi: text('published_version_doi'),
    preprintCheckedAt: text('preprint_checked_at'),
    versionLabel: text('version_label'),
    retractionStatus: text('retraction_status', { enum: RETRACTION_STATUSES })
      .notNull()
      .default('unknown'),
    retractionNoticeDoi: text('retraction_notice_doi'),
    retractionCheckedAt: text('retraction_checked_at'),
    /** Mirrored from the parent; see §1.1. */
    itemTrashedAt: text('item_trashed_at'),
    verificationStatus: text('verification_status', { enum: VERIFICATION_STATUSES })
      .notNull()
      .default('unverified'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    /** Two live items may not claim the same DOI; the deduplicator resolves it before insert. */
    uniqueIndex('ux_item_bibliographic_doi')
      .on(table.doi)
      .where(sql`doi is not null and item_trashed_at is null`),
    /** The `citation_key` collision check, as a database constraint (ADR-0016). */
    uniqueIndex('ux_item_bibliographic_citation_key')
      .on(table.citationKey)
      .where(sql`citation_key is not null and item_trashed_at is null`),
    index('ix_item_bib_issued_year').on(table.issuedYear),
    index('ix_item_bib_container_title').on(table.containerTitle),
    index('ix_item_bib_pmid').on(table.pmid).where(sql`pmid is not null`),
    index('ix_item_bib_openalex_id').on(table.openalexId).where(sql`openalex_id is not null`),
    index('ix_item_bib_arxiv_id').on(table.arxivId).where(sql`arxiv_id is not null`),
    index('ix_item_bib_isbn').on(table.isbn).where(sql`isbn is not null`),
    index('ix_item_bib_issn_l').on(table.issnL).where(sql`issn_l is not null`),
    index('ix_item_bib_retraction_status')
      .on(table.retractionStatus)
      .where(sql`retraction_status not in ('none', 'unknown')`),
    check(
      'ck_item_bibliographic_pages',
      sql`"page_last" is null or "page_first" is null or "page_last" >= "page_first"`,
    ),
    check(
      'ck_item_bibliographic_issued_month',
      sql`"issued_month" is null or ("issued_month" between 1 and 12)`,
    ),
    oneOfOrNull('ck_item_bibliographic_oa_status', 'oa_status', OA_STATUSES),
    oneOf('ck_item_bibliographic_retraction_status', 'retraction_status', RETRACTION_STATUSES),
    oneOf('ck_item_bibliographic_verification', 'verification_status', VERIFICATION_STATUSES),
    boolean01('ck_item_bibliographic_key_locked_bool', 'citation_key_locked'),
    boolean01('ck_item_bibliographic_is_preprint_bool', 'is_preprint'),
  ],
);

/**
 * `item_office` — the private/office facet, covering the Paperless-ngx mapping (§3.7).
 *
 * Fields beyond this set go to `custom_fields`/`field_values` and never to new columns (O1): the
 * facet covers what the ingestion rule engine and the Paperless importer need, and everything else
 * is user-defined by design. `office_document_type` is an open vocabulary, because the importer
 * carries user-defined types across.
 */
export const itemOffice = sqliteTable(
  'item_office',
  {
    itemId: text('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'restrict' }),
    correspondent: text('correspondent').notNull(),
    correspondentNormalised: text('correspondent_normalised'),
    /** Optional promotion of a correspondent to a first-class organisation (O4). */
    correspondentCreatorId: text('correspondent_creator_id').references(() => creators.id, {
      onDelete: 'restrict',
    }),
    officeDocumentType: text('office_document_type'),
    /** The date printed on the document, not the ingest date. */
    documentDate: text('document_date'),
    /** Paperless archive serial number. */
    asn: integer('asn'),
    referenceNumber: text('reference_number'),
    /** Minor units. Never REAL (§1.1). */
    amountMinor: integer('amount_minor'),
    amountCurrency: text('amount_currency'),
    dueDate: text('due_date'),
    periodStart: text('period_start'),
    periodEnd: text('period_end'),
    itemTrashedAt: text('item_trashed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    /** The ASN is a physical filing number and must be unique in the library. */
    uniqueIndex('ux_item_office_asn')
      .on(table.asn)
      .where(sql`asn is not null and item_trashed_at is null`),
    index('ix_item_office_correspondent_normalised').on(table.correspondentNormalised),
    index('ix_item_office_document_date').on(table.documentDate),
    index('ix_item_office_type_date').on(table.officeDocumentType, table.documentDate),
    check(
      'ck_item_office_amount',
      sql`("amount_minor" is null) = ("amount_currency" is null)`,
    ),
    check(
      'ck_item_office_period',
      sql`"period_end" is null or "period_start" is null or "period_end" >= "period_start"`,
    ),
    check(
      'ck_item_office_currency_shape',
      sql`"amount_currency" is null or length("amount_currency") = 3`,
    ),
  ],
);

/**
 * `attachments` — the many-to-many between items and documents (§3.8).
 *
 * This table is the reason a single PDF shared by two items is stored once (ADR-0004) and the
 * reason one item can carry a scan, a supplement and a web snapshot at the same time. Detaching is
 * a soft delete of this row only; the document survives, and storage reclamation is a separate,
 * explicit operation over documents with no live attachment (AT2).
 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    /** Null only for `link_mode = 'linked_url'`. */
    documentId: text('document_id').references(() => documents.id, { onDelete: 'restrict' }),
    role: text('role', { enum: ATTACHMENT_ROLES }).notNull(),
    linkMode: text('link_mode', { enum: ATTACHMENT_LINK_MODES }).notNull().default('stored'),
    title: text('title'),
    url: text('url'),
    /** Absolute path on the machine that owns the link. Desktop only, and a P10 hazard (AT5). */
    linkedPath: text('linked_path'),
    contentTypeHint: text('content_type_hint'),
    /** Denormalised from `annotations`; the reader needs it without a join (AT4). */
    hasAnnotations: integer('has_annotations', { mode: 'boolean' }).notNull().default(false),
    annotationCount: integer('annotation_count').notNull().default(0),
    position: integer('position').notNull().default(0),
    addedAt: text('added_at').notNull(),
    addedByUserId: text('added_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    source: text('source', { enum: ATTACHMENT_SOURCES }).notNull().default('manual'),
    updatedAt: text('updated_at').notNull(),
    trashedAt: text('trashed_at'),
  },
  (table) => [
    /** The same file is never attached to the same item twice. */
    uniqueIndex('ux_attachments_item_document')
      .on(table.itemId, table.documentId)
      .where(sql`document_id is not null and trashed_at is null`),
    /** At most one primary attachment per item. */
    uniqueIndex('ux_attachments_primary')
      .on(table.itemId)
      .where(sql`role = 'primary' and trashed_at is null`),
    /** "Which items use this file" — the deduplicator and the storage garbage report both need it. */
    index('ix_attachments_document_id').on(table.documentId).where(live),
    index('ix_attachments_item_position').on(table.itemId, table.position),
    index('ix_attachments_role').on(table.role),
    oneOf('ck_attachments_role', 'role', ATTACHMENT_ROLES),
    oneOf('ck_attachments_link_mode_vocab', 'link_mode', ATTACHMENT_LINK_MODES),
    oneOf('ck_attachments_source', 'source', ATTACHMENT_SOURCES),
    check(
      'ck_attachments_link_mode',
      sql`("link_mode" = 'linked_url' and "document_id" is null and "url" is not null)
        or ("link_mode" = 'linked_file' and "document_id" is null and "linked_path" is not null)
        or ("link_mode" = 'stored' and "document_id" is not null)`,
    ),
    check('ck_attachments_annotation_count', sql`"annotation_count" >= 0`),
    boolean01('ck_attachments_has_annotations_bool', 'has_annotations'),
  ],
);

/* ============================================================================================== */
/* 4. Organisation and content                                                                     */
/* ============================================================================================== */

/**
 * `collections` — the hierarchical filing structure, plus saved searches (§4.1).
 *
 * A saved search is a collection whose membership is a query rather than a list, which keeps the
 * UI, the API, the `.bib` endpoint and the export path identical for both (CONCEPT §5.7).
 *
 * `parent_key` is the `COALESCE(parent_id, '')` mirror that lets sibling uniqueness be a plain
 * unique index: `NULL`s are distinct in a unique index in both dialects, so a nullable `parent_id`
 * cannot carry the constraint (§1.1).
 */
export const collections = sqliteTable(
  'collections',
  {
    id: text('id').primaryKey(),
    /** Used in `.bib` feed URLs. */
    publicId: text('public_id').notNull(),
    name: text('name').notNull(),
    nameNormalised: text('name_normalised').notNull(),
    parentId: text('parent_id').references((): AnySQLiteColumn => collections.id, {
      onDelete: 'restrict',
    }),
    parentKey: text('parent_key').notNull().default(''),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: COLLECTION_KINDS }).notNull().default('manual'),
    /** Required when `kind = 'smart'`: the saved search in the API's structured query form. */
    query: text('query'),
    /** Recorded so a saved search built against one index is not reinterpreted by another (ADR-0011). */
    queryBackend: text('query_backend', { enum: QUERY_BACKENDS }),
    description: text('description'),
    colour: text('colour'),
    /** Root is 0. Denormalised, maintained on move (C4). */
    depth: integer('depth').notNull().default(0),
    position: integer('position').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    trashedAt: text('trashed_at'),
  },
  (table) => [
    uniqueIndex('ux_collections_public_id').on(table.publicId),
    uniqueIndex('ux_collections_sibling_name')
      .on(table.ownerUserId, table.parentKey, table.nameNormalised)
      .where(live),
    index('ix_collections_parent').on(table.parentId, table.position),
    index('ix_collections_owner_live').on(table.ownerUserId, table.position).where(live),
    oneOf('ck_collections_kind', 'kind', COLLECTION_KINDS),
    oneOfOrNull('ck_collections_query_backend', 'query_backend', QUERY_BACKENDS),
    check('ck_collections_smart', sql`("kind" = 'smart') = ("query" is not null)`),
    check('ck_collections_depth', sql`"depth" >= 0`),
    check('ck_collections_parent_key', sql`"parent_key" = coalesce("parent_id", '')`),
    jsonValidOrNull('ck_collections_query_json', 'query'),
  ],
);

/** `collection_items` — membership of manual collections (§4.2). */
export const collectionItems = sqliteTable(
  'collection_items',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    addedAt: text('added_at').notNull(),
    addedByUserId: text('added_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    source: text('source', { enum: MEMBERSHIP_SOURCES }).notNull().default('manual'),
  },
  (table) => [
    primaryKey({ name: 'pk_collection_items', columns: [table.collectionId, table.itemId] }),
    /** The reverse lookup for the item pane. */
    index('ix_collection_items_item_id').on(table.itemId),
    oneOf('ck_collection_items_source', 'source', MEMBERSHIP_SOURCES),
  ],
);

/**
 * `tags` — flat, free-text labels (§4.3).
 *
 * Distinct from `terms`: a tag is something the user typed, a term is a controlled-vocabulary
 * entry. The optional binding of a tag to a term arrives with the graph phase, which is when
 * `terms` exists (§11, `0005_graph`).
 */
export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nameNormalised: text('name_normalised').notNull(),
    colour: text('colour'),
    /** `automatic` is a tag added by a rule or resolver — Zotero's tag type 1. */
    scheme: text('scheme', { enum: TAG_SCHEMES }).notNull().default('manual'),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    position: integer('position').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    trashedAt: text('trashed_at'),
  },
  (table) => [
    uniqueIndex('ux_tags_owner_name').on(table.ownerUserId, table.nameNormalised).where(live),
    index('ix_tags_scheme').on(table.scheme),
    oneOf('ck_tags_scheme', 'scheme', TAG_SCHEMES),
  ],
);

/** `item_tags` — tag assignments, carrying why the tag is there (§4.4, P4). */
export const itemTags = sqliteTable(
  'item_tags',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    source: text('source', { enum: TAG_ASSIGNMENT_SOURCES }).notNull().default('manual'),
    /** The ingestion rule that applied it (CONCEPT §5.3 stage 8) — "why is this tagged". */
    ruleRef: text('rule_ref'),
    confidence: real('confidence'),
    addedAt: text('added_at').notNull(),
    addedByUserId: text('added_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ name: 'pk_item_tags', columns: [table.itemId, table.tagId] }),
    index('ix_item_tags_tag_id').on(table.tagId),
    oneOf('ck_item_tags_source', 'source', TAG_ASSIGNMENT_SOURCES),
    confidence01('ck_item_tags_confidence', 'confidence'),
  ],
);

/** `annotation_tags` — tags on annotations; Zotero has them and the importer must not drop them (§4.5). */
export const annotationTags = sqliteTable(
  'annotation_tags',
  {
    annotationId: text('annotation_id')
      .notNull()
      .references(() => annotations.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    addedAt: text('added_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'pk_annotation_tags', columns: [table.annotationId, table.tagId] }),
    index('ix_annotation_tags_tag_id').on(table.tagId),
  ],
);

/**
 * `custom_fields` — user- and plugin-defined typed fields (§4.6).
 *
 * The same mechanism carries Paperless custom fields and systematic-review extraction variables,
 * which is why CONCEPT §5.10 can say extraction forms are generated from custom-field schemas.
 * `data_type` is immutable once any value exists (CF1), and deleting a field is refused while
 * values exist (CF2) — both service-layer rules, because neither is expressible portably in SQL.
 */
export const customFields = sqliteTable(
  'custom_fields',
  {
    id: text('id').primaryKey(),
    /** Stable slug: the API name, the export name and the Parquet column name. */
    fieldKey: text('field_key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    dataType: text('data_type', { enum: CUSTOM_FIELD_DATA_TYPES }).notNull(),
    config: text('config').notNull().default('{}'),
    /** JSON array; null means "any item type". */
    appliesToItemTypes: text('applies_to_item_types'),
    /** Advisory — enforced by the `completeness` check, because requiredness is per item type. */
    isRequired: integer('is_required', { mode: 'boolean' }).notNull().default(false),
    isRepeatable: integer('is_repeatable', { mode: 'boolean' }).notNull().default(false),
    scope: text('scope', { enum: CUSTOM_FIELD_SCOPES }).notNull().default('library'),
    position: integer('position').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('ux_custom_fields_field_key').on(table.fieldKey),
    oneOf('ck_custom_fields_data_type', 'data_type', CUSTOM_FIELD_DATA_TYPES),
    oneOf('ck_custom_fields_scope', 'scope', CUSTOM_FIELD_SCOPES),
    boolean01('ck_custom_fields_is_required_bool', 'is_required'),
    boolean01('ck_custom_fields_is_repeatable_bool', 'is_repeatable'),
    jsonValid('ck_custom_fields_config_json', 'config'),
    jsonValidOrNull('ck_custom_fields_applies_json', 'applies_to_item_types'),
  ],
);

/**
 * `field_values` — the values of custom fields (§4.7).
 *
 * Typed columns rather than one stringly-typed column, so that numbers sort, dates range-query and
 * the analytics export emits a correctly typed Parquet column without inference. `is_blank` records
 * an explicit "not reported", which is a different fact from "not yet extracted" — the latter is
 * the absence of a row.
 *
 * The `review_id`, `extraction_form_id` and their two scope-key mirrors belong to the
 * systematic-review phase and are added by `0007_sr` (§11), so the slot key here is the Phase 1
 * one: field, item, repeatable group, ordinal.
 */
export const fieldValues = sqliteTable(
  'field_values',
  {
    id: text('id').primaryKey(),
    fieldId: text('field_id')
      .notNull()
      .references(() => customFields.id, { onDelete: 'restrict' }),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    /** The repeatable group instance: `arm:intervention`, `outcome:mortality_30d`. */
    groupKey: text('group_key'),
    /** `COALESCE(group_key, '')`; see §1.1. */
    groupScopeKey: text('group_scope_key').notNull().default(''),
    ordinal: integer('ordinal').notNull().default(0),
    valueText: text('value_text'),
    valueNumber: real('value_number'),
    valueInteger: integer('value_integer'),
    valueBoolean: integer('value_boolean', { mode: 'boolean' }),
    valueDate: text('value_date'),
    valueJson: text('value_json'),
    valueItemId: text('value_item_id').references(() => items.id, { onDelete: 'restrict' }),
    isBlank: integer('is_blank', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [
    uniqueIndex('ux_field_values_slot').on(
      table.fieldId,
      table.itemId,
      table.groupScopeKey,
      table.ordinal,
    ),
    index('ix_field_values_item').on(table.itemId, table.fieldId),
    index('ix_field_values_field_text')
      .on(table.fieldId, table.valueText)
      .where(sql`value_text is not null`),
    index('ix_field_values_field_number')
      .on(table.fieldId, table.valueNumber)
      .where(sql`value_number is not null`),
    index('ix_field_values_value_item_id')
      .on(table.valueItemId)
      .where(sql`value_item_id is not null`),
    check('ck_field_values_ordinal', sql`"ordinal" >= 0`),
    check('ck_field_values_group_scope_key', sql`"group_scope_key" = coalesce("group_key", '')`),
    /** Exactly one value column, or none at all with `is_blank = 1`. */
    check(
      'ck_field_values_one_value',
      sql`(
        (case when "value_text" is null then 0 else 1 end)
        + (case when "value_number" is null then 0 else 1 end)
        + (case when "value_integer" is null then 0 else 1 end)
        + (case when "value_boolean" is null then 0 else 1 end)
        + (case when "value_date" is null then 0 else 1 end)
        + (case when "value_json" is null then 0 else 1 end)
        + (case when "value_item_id" is null then 0 else 1 end)
      ) = case when "is_blank" = 1 then 0 else 1 end`,
    ),
    boolean01('ck_field_values_value_boolean_bool', 'value_boolean'),
    boolean01('ck_field_values_is_blank_bool', 'is_blank'),
    jsonValidOrNull('ck_field_values_value_json', 'value_json'),
  ],
);

/**
 * `notes` — markdown notes, attached to an item or standalone (§4.8).
 *
 * Also the destination for IMAP message bodies (CONCEPT §5.3) and for Citavi-style quotes and
 * thoughts. `content_markdown` is always populated, including for HTML imports, so the search
 * index and the export path read one column (N1); `content_original` keeps the imported HTML
 * verbatim so a Zotero note round-trips losslessly (P10).
 */
export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    publicId: text('public_id').notNull(),
    itemId: text('item_id').references(() => items.id, { onDelete: 'restrict' }),
    /** A note written from a highlight keeps the link. */
    parentAnnotationId: text('parent_annotation_id').references(
      (): AnySQLiteColumn => annotations.id,
      { onDelete: 'set null' },
    ),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    title: text('title'),
    contentMarkdown: text('content_markdown').notNull(),
    sourceFormat: text('source_format', { enum: NOTE_FORMATS }).notNull().default('markdown'),
    contentOriginal: text('content_original'),
    noteKind: text('note_kind', { enum: NOTE_KINDS }).notNull().default('note'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    trashedAt: text('trashed_at'),
  },
  (table) => [
    uniqueIndex('ux_notes_public_id').on(table.publicId),
    index('ix_notes_item_id')
      .on(table.itemId)
      .where(sql`item_id is not null and trashed_at is null`),
    index('ix_notes_owner_updated').on(table.ownerUserId, table.updatedAt),
    oneOf('ck_notes_source_format', 'source_format', NOTE_FORMATS),
    oneOf('ck_notes_note_kind', 'note_kind', NOTE_KINDS),
    check('ck_notes_version', sql`"version" >= 1`),
  ],
);

/**
 * `annotations` — reading annotations as first-class records in the W3C shape (§4.9, ADR-0009).
 *
 * The target is a **document**, not an item, because the annotation belongs to the bytes; `item_id`
 * records the reading context so the item pane can show them without joining through `attachments`.
 * The underlying bytes are never modified (AN1, D3): exporting to embedded PDF annotations produces
 * a new document with its own hash.
 */
export const annotations = sqliteTable(
  'annotations',
  {
    id: text('id').primaryKey(),
    publicId: text('public_id').notNull(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    itemId: text('item_id').references(() => items.id, { onDelete: 'restrict' }),
    attachmentId: text('attachment_id').references(() => attachments.id, { onDelete: 'set null' }),
    annotationType: text('annotation_type', { enum: ANNOTATION_TYPES }).notNull(),
    motivation: text('motivation', { enum: ANNOTATION_MOTIVATIONS }).notNull(),
    /** The full W3C selector set. The one place the model is deliberately format-dependent (AN4). */
    selector: text('selector').notNull().default('{}'),
    /** `TextQuoteSelector.exact`, duplicated out of the JSON so it can be full-text indexed. */
    quotedText: text('quoted_text'),
    prefixText: text('prefix_text'),
    suffixText: text('suffix_text'),
    bodyText: text('body_text'),
    bodyFormat: text('body_format', { enum: ANNOTATION_BODY_FORMATS }).notNull().default('markdown'),
    colour: text('colour'),
    pageIndex: integer('page_index'),
    /** The printed label, which is frequently not the physical index. */
    pageLabel: text('page_label'),
    /** Fixed-width reading-order key — the portable equivalent of Zotero's `sortIndex`. */
    positionSortKey: text('position_sort_key').notNull(),
    authorUserId: text('author_user_id').references(() => users.id, { onDelete: 'restrict' }),
    authorName: text('author_name'),
    /** True when extracted from annotations already embedded in the PDF at ingest (ADR-0009). */
    isExternal: integer('is_external', { mode: 'boolean' }).notNull().default(false),
    externalRef: text('external_ref'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    trashedAt: text('trashed_at'),
  },
  (table) => [
    uniqueIndex('ux_annotations_public_id').on(table.publicId),
    /** Re-running the embedded-annotation extractor is idempotent (P9). */
    uniqueIndex('ux_annotations_external')
      .on(table.documentId, table.externalRef)
      .where(sql`external_ref is not null`),
    index('ix_annotations_document_sort')
      .on(table.documentId, table.positionSortKey)
      .where(live),
    index('ix_annotations_item').on(table.itemId).where(sql`item_id is not null`),
    index('ix_annotations_author').on(table.authorUserId),
    oneOf('ck_annotations_type', 'annotation_type', ANNOTATION_TYPES),
    oneOf('ck_annotations_motivation', 'motivation', ANNOTATION_MOTIVATIONS),
    oneOf('ck_annotations_body_format', 'body_format', ANNOTATION_BODY_FORMATS),
    check('ck_annotations_body', sql`"annotation_type" <> 'note' or "body_text" is not null`),
    check('ck_annotations_version', sql`"version" >= 1`),
    boolean01('ck_annotations_is_external_bool', 'is_external'),
    jsonValid('ck_annotations_selector_json', 'selector'),
  ],
);

/* ============================================================================================== */
/* 5. People                                                                                       */
/* ============================================================================================== */

/**
 * `creators` — a person or organisation as an entity, with identity-resolution state (§5.1).
 *
 * Distinct from their appearance on a particular item, which is `item_creators`. Two creators with
 * different non-null ORCIDs are never merged automatically: the `author_consistency` check flags
 * the conflict for the review queue (CR2, P3).
 */
export const creators = sqliteTable(
  'creators',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: CREATOR_KINDS }).notNull(),
    familyName: text('family_name'),
    givenName: text('given_name'),
    /** `van`, `de` where the source separates it. */
    namePrefix: text('name_prefix'),
    nameSuffix: text('name_suffix'),
    /** Required for organisations and for persons whose name does not split (Zotero field mode 1). */
    literalName: text('literal_name'),
    /** Rendered once, on write. */
    displayName: text('display_name').notNull(),
    /** `family, given` normalised: the dedup blocking key and the browsing index. */
    sortName: text('sort_name').notNull(),
    /** bibliometrix `AU` uses the abbreviated form; `AF` uses `display_name`. */
    initials: text('initials'),
    /** JSON array of `{form, source, count}` — the "name forms" of CONCEPT §5.2. */
    nameVariants: text('name_variants').notNull().default('[]'),
    orcid: text('orcid'),
    openalexAuthorId: text('openalex_author_id'),
    semanticScholarAuthorId: text('semantic_scholar_author_id'),
    scopusAuthorId: text('scopus_author_id'),
    researcherId: text('researcher_id'),
    isni: text('isni'),
    viaf: text('viaf'),
    /** Organisations. */
    ror: text('ror'),
    wikidataId: text('wikidata_id'),
    disambiguationStatus: text('disambiguation_status', { enum: DISAMBIGUATION_STATUSES })
      .notNull()
      .default('unreviewed'),
    mergedIntoCreatorId: text('merged_into_creator_id').references(
      (): AnySQLiteColumn => creators.id,
      { onDelete: 'restrict' },
    ),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    trashedAt: text('trashed_at'),
  },
  (table) => [
    uniqueIndex('ux_creators_orcid')
      .on(table.orcid)
      .where(sql`orcid is not null and trashed_at is null`),
    uniqueIndex('ux_creators_openalex')
      .on(table.openalexAuthorId)
      .where(sql`openalex_author_id is not null and trashed_at is null`),
    index('ix_creators_sort_name').on(table.sortName).where(live),
    index('ix_creators_ror').on(table.ror).where(sql`ror is not null`),
    index('ix_creators_disambiguation')
      .on(table.disambiguationStatus)
      .where(sql`disambiguation_status = 'ambiguous'`),
    oneOf('ck_creators_kind', 'kind', CREATOR_KINDS),
    oneOf('ck_creators_disambiguation', 'disambiguation_status', DISAMBIGUATION_STATUSES),
    check('ck_creators_name', sql`"literal_name" is not null or "family_name" is not null`),
    check('ck_creators_org', sql`"kind" <> 'organisation' or "literal_name" is not null`),
    check(
      'ck_creators_merged',
      sql`("disambiguation_status" = 'merged') = ("merged_into_creator_id" is not null)`,
    ),
    jsonValid('ck_creators_name_variants_json', 'name_variants'),
  ],
);

/**
 * `item_creators` — a creator's appearance on an item, with role, order and printed affiliation
 * (§5.2).
 *
 * Affiliation lives here and not on `creators`, because it is a property of the publication event:
 * this is what makes bibliometrix `C1` and institutional collaboration networks possible. `ordinal`
 * is dense from zero within an item (IC1), and first-author queries — which the deduplicator and
 * the citation-key formula both need — are `role = 'author' AND ordinal = 0` (IC3).
 */
export const itemCreators = sqliteTable(
  'item_creators',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    creatorId: text('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'restrict' }),
    role: text('role', { enum: CREATOR_ROLES }).notNull().default('author'),
    /** Exactly as printed, for BibTeX fidelity and the `author_consistency` check. */
    rawName: text('raw_name'),
    /** bibliometrix `C1`. */
    affiliationRaw: text('affiliation_raw'),
    affiliationRor: text('affiliation_ror'),
    affiliationCreatorId: text('affiliation_creator_id').references(() => creators.id, {
      onDelete: 'restrict',
    }),
    /** ISO-3166-1 alpha-2, for country collaboration maps. */
    countryCode: text('country_code'),
    isCorresponding: integer('is_corresponding', { mode: 'boolean' }).notNull().default(false),
    /** CRediT taxonomy roles, when the source supplies them. */
    contributionRoles: text('contribution_roles'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'pk_item_creators', columns: [table.itemId, table.ordinal] }),
    /** "Everything by this author". */
    index('ix_item_creators_creator_id').on(table.creatorId, table.itemId),
    index('ix_item_creators_role').on(table.itemId, table.role, table.ordinal),
    index('ix_item_creators_ror')
      .on(table.affiliationRor)
      .where(sql`affiliation_ror is not null`),
    check('ck_item_creators_ordinal', sql`"ordinal" >= 0`),
    oneOf('ck_item_creators_role', 'role', CREATOR_ROLES),
    boolean01('ck_item_creators_is_corresponding_bool', 'is_corresponding'),
    jsonValidOrNull('ck_item_creators_contribution_roles_json', 'contribution_roles'),
  ],
);

/* ============================================================================================== */
/* 6. Operations                                                                                   */
/* ============================================================================================== */

/**
 * `jobs` — the persistent queue of ADR-0010, and the record of every long-running operation (§6.3).
 *
 * P9 lives here: an import, an enrichment sweep or a dedup run is re-runnable because of
 * `idempotency_key` and resumable because of `cursor`. The claim is a single `UPDATE … RETURNING`
 * statement, which both dialects support (IK5) — SQLite's single-writer model makes it atomic and
 * Postgres needs `FOR UPDATE SKIP LOCKED` in the subselect.
 *
 * `job_type` is an open vocabulary — a plugin registers `plugin.<name>` — so it carries no `CHECK`.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    jobType: text('job_type').notNull(),
    idempotencyKey: text('idempotency_key'),
    /** The complete input; a job is re-runnable from this alone. */
    params: text('params').notNull().default('{}'),
    state: text('state', { enum: JOB_STATES }).notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    runAfter: text('run_after').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    heartbeatAt: text('heartbeat_at'),
    /** A crashed worker's job returns to `queued` when its lease lapses. */
    leaseExpiresAt: text('lease_expires_at'),
    workerId: text('worker_id'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    progressDone: integer('progress_done').notNull().default(0),
    progressTotal: integer('progress_total'),
    /** The resume point, written at every checkpoint (IK4). */
    cursor: text('cursor'),
    result: text('result'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    errorDetail: text('error_detail'),
    parentJobId: text('parent_job_id').references((): AnySQLiteColumn => jobs.id, {
      onDelete: 'set null',
    }),
    /** Denormalised, so a whole job tree is one indexed query. */
    rootJobId: text('root_job_id').references((): AnySQLiteColumn => jobs.id, {
      onDelete: 'set null',
    }),
    batchId: text('batch_id'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    createdByTokenId: text('created_by_token_id').references(() => apiTokens.id, {
      onDelete: 'restrict',
    }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    /** Global, not scoped by type: the key is constructed to be self-describing (IK1). */
    uniqueIndex('ux_jobs_idempotency_key')
      .on(table.idempotencyKey)
      .where(sql`idempotency_key is not null`),
    /** The only index the claim query needs. */
    index('ix_jobs_claim')
      .on(table.priority, table.runAfter)
      .where(sql`state = 'queued'`),
    index('ix_jobs_state_updated').on(table.state, table.updatedAt),
    index('ix_jobs_root').on(table.rootJobId).where(sql`root_job_id is not null`),
    index('ix_jobs_type_created').on(table.jobType, table.createdAt),
    oneOf('ck_jobs_state', 'state', JOB_STATES),
    check('ck_jobs_attempts', sql`"attempts" >= 0 and "attempts" <= "max_attempts"`),
    check('ck_jobs_progress', sql`"progress_done" >= 0`),
    jsonValid('ck_jobs_params_json', 'params'),
    jsonValidOrNull('ck_jobs_cursor_json', 'cursor'),
    jsonValidOrNull('ck_jobs_result_json', 'result'),
    jsonValidOrNull('ck_jobs_error_detail_json', 'error_detail'),
  ],
);

/**
 * `job_logs` — the `log` property CONCEPT §5.2 gives a Job, as a child table (§6.4).
 *
 * A child table and not a JSON column because an import writes thousands of lines and a column
 * would be rewritten on every append. The id is a ULID, so `ORDER BY id` is append order.
 */
export const jobLogs = sqliteTable(
  'job_logs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    loggedAt: text('logged_at').notNull(),
    level: text('level', { enum: JOB_LOG_LEVELS }).notNull(),
    message: text('message').notNull(),
    data: text('data'),
    /** Lets a report answer "what happened to this file during the import". */
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
  },
  (table) => [
    index('ix_job_logs_job').on(table.jobId, table.id),
    index('ix_job_logs_subject').on(table.subjectId).where(sql`subject_id is not null`),
    oneOf('ck_job_logs_level', 'level', JOB_LOG_LEVELS),
    jsonValidOrNull('ck_job_logs_data_json', 'data'),
  ],
);

/**
 * `audit_log` — P5's append-only record of who did what (§6.5).
 *
 * Every write through the API lands here, including writes made by MCP tools and by plugins. It is
 * insert-only: no update, no delete, no retention policy (AL1). `before`/`after` hold the changed
 * fields only, not the whole row (AL4) — a full snapshot is reconstructed by replaying, or read
 * from `trash.restore_payload` for a trashed entity.
 *
 * `actor_plugin_id` has no foreign key in Phase 1 because `plugins` arrives with `0003_enrichment`;
 * the column is present regardless, because AL2 requires one actor column per `actor_type`.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    /** ULID, monotonic, so `(occurred_at, id)` is a total order. */
    id: text('id').primaryKey(),
    occurredAt: text('occurred_at').notNull(),
    actorType: text('actor_type', { enum: ACTOR_TYPES }).notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    actorTokenId: text('actor_token_id').references(() => apiTokens.id, { onDelete: 'restrict' }),
    actorPluginId: text('actor_plugin_id'),
    actorJobId: text('actor_job_id').references(() => jobs.id, { onDelete: 'restrict' }),
    /** Dotted verb: `item.created`, `document.ingested`, `field.locked`, `token.revoked`. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: text('before'),
    after: text('after'),
    reason: text('reason'),
    /** Correlates every row written by one HTTP request. */
    requestId: text('request_id'),
    apiRoute: text('api_route'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [
    index('ix_audit_log_entity').on(table.entityType, table.entityId, table.occurredAt),
    index('ix_audit_log_occurred_at').on(table.occurredAt),
    index('ix_audit_log_actor_user').on(table.actorUserId).where(sql`actor_user_id is not null`),
    index('ix_audit_log_request').on(table.requestId).where(sql`request_id is not null`),
    index('ix_audit_log_action').on(table.action),
    oneOf('ck_audit_log_actor_type', 'actor_type', ACTOR_TYPES),
    jsonValidOrNull('ck_audit_log_before_json', 'before'),
    jsonValidOrNull('ck_audit_log_after_json', 'after'),
  ],
);

/**
 * `trash` — P5's "never delete": the restore record for every soft-deleted entity, and the
 * reversible merge record the record deduplicator writes (§6.6).
 *
 * The other half of invariant T1: `trashed_at IS NOT NULL` on the entity if and only if there is an
 * open row here for it. Both are written in the same transaction, always.
 */
export const trash = sqliteTable(
  'trash',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type', { enum: TRASH_ENTITY_TYPES }).notNull(),
    /** Polymorphic; no SQL foreign key (§12, open question O5). */
    entityId: text('entity_id').notNull(),
    /** Groups the rows written by one cascading trash, so restore puts back what went together. */
    groupId: text('group_id'),
    trashedAt: text('trashed_at').notNull(),
    trashedByUserId: text('trashed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason', { enum: TRASH_REASONS }).notNull().default('user'),
    reasonDetail: text('reason_detail'),
    /** Everything needed to undo: detached memberships, tag assignments, previous parents. */
    restorePayload: text('restore_payload').notNull().default('{}'),
    mergeTargetItemId: text('merge_target_item_id').references(() => items.id, {
      onDelete: 'restrict',
    }),
    /** Field-by-field account of what the winner took, so a merge reverses field by field. */
    mergeRecord: text('merge_record'),
    /** Null by default — nothing expires unless the operator configures it. */
    expiresAt: text('expires_at'),
    restoredAt: text('restored_at'),
    restoredByUserId: text('restored_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    /** Hard deletion, only ever on an explicit request (TR2). */
    purgedAt: text('purged_at'),
    purgedByUserId: text('purged_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (table) => [
    /** One open trash record per entity — the other half of T1. */
    uniqueIndex('ux_trash_open')
      .on(table.entityType, table.entityId)
      .where(sql`restored_at is null and purged_at is null`),
    index('ix_trash_open')
      .on(table.trashedAt)
      .where(sql`restored_at is null and purged_at is null`),
    index('ix_trash_group').on(table.groupId).where(sql`group_id is not null`),
    index('ix_trash_merge_target')
      .on(table.mergeTargetItemId)
      .where(sql`merge_target_item_id is not null`),
    index('ix_trash_expires')
      .on(table.expiresAt)
      .where(sql`expires_at is not null and purged_at is null`),
    oneOf('ck_trash_entity_type', 'entity_type', TRASH_ENTITY_TYPES),
    oneOf('ck_trash_reason', 'reason', TRASH_REASONS),
    check('ck_trash_merge', sql`"reason" <> 'merge' or "merge_target_item_id" is not null`),
    jsonValid('ck_trash_restore_payload_json', 'restore_payload'),
    jsonValidOrNull('ck_trash_merge_record_json', 'merge_record'),
  ],
);

/* -------------------------------------------------------------------------------------------- */
/* Row types                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export type UserRow = typeof users.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentProvenanceRow = typeof documentProvenance.$inferSelect;
export type ItemRow = typeof items.$inferSelect;
export type ItemBibliographicRow = typeof itemBibliographic.$inferSelect;
export type ItemOfficeRow = typeof itemOffice.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type CustomFieldRow = typeof customFields.$inferSelect;
export type FieldValueRow = typeof fieldValues.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type AnnotationRow = typeof annotations.$inferSelect;
export type CreatorRow = typeof creators.$inferSelect;
export type ItemCreatorRow = typeof itemCreators.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type JobLogRow = typeof jobLogs.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type TrashRow = typeof trash.$inferSelect;
