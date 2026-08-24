# Recueil — data model v1

| | |
|---|---|
| Status | Draft v0.1 |
| Date | 2026-08-22 |
| Phase | Phase 0 deliverable ("Data model v1: ERD, migrations, fixture library") |
| Scope | Relational schema for CONCEPT.md §5.2, written to the SQLite/Postgres intersection (ADR-0003) |
| Companion | [`erd.mmd`](erd.mmd) — the same schema as a Mermaid entity relationship diagram |

This document turns the entity table in CONCEPT.md §5.2 into a relational design: one section per
table, giving purpose, columns with types, constraints, indexes and the invariants that hold. It is
the reference for the Drizzle schema in `packages/core` and for the migrations that follow it.

Phase markers appear in the section headings. Everything unmarked is needed by Phase 5 at the
latest; the systematic-review tables are Phase 7 and the curated-network tables are Phase 6, and
both are specified now so that the graph and analytics work built in Phase 5 does not have to be
reshaped later (CONCEPT §7 sequencing rule: "never start Phase 6 or 7 before Phase 5's graph schema is in
production").

---

## 1. Conventions

**Cross-references.** `CONCEPT §x.y` and `CONCEPT.md §x.y` cite the concept document. A bare
`§x.y` cites a section of this document. `Pn` are the binding principles of CONCEPT.md §3; `ADR-nnnn` are the records in
[`adr/`](adr/).

### 1.1 Dialect intersection

Migrations run unchanged against SQLite and Postgres (ADR-0003). That rules out several
conveniences, so the schema uses a deliberately small type vocabulary.

| Notation used here | SQLite | Postgres | Rationale |
|---|---|---|---|
| `TEXT` | `TEXT` | `text` | No length limits anywhere; length is validated by Zod, not by the database |
| `ID` | `TEXT` | `text` | 26-character Crockford base32 ULID. Lexicographically sortable, so `ORDER BY id` is creation order |
| `INTEGER` | `INTEGER` | `bigint` | 64-bit in both |
| `REAL` | `REAL` | `double precision` | Only for weights, confidences and metric values — never for money |
| `BOOLEAN` | `INTEGER` + `CHECK (col IN (0,1))` | `boolean` | Drizzle maps both to a JS boolean |
| `TIMESTAMP` | `TEXT`, ISO-8601 UTC | `timestamptz` | SQLite form is always `YYYY-MM-DDTHH:MM:SS.sssZ` — fixed width, always `Z`, always three fractional digits, so lexicographic order equals chronological order |
| `DATE` | `TEXT`, `YYYY-MM-DD` | `date` | Only for complete calendar dates |
| `EDTF` | `TEXT` | `text` | Bibliographic dates that may be partial or approximate (`2019`, `2019-04`, `2019-04-01/2019-04-03`). Never `DATE` — a year-only publication date is normal |
| `JSON` | `TEXT` + `CHECK (json_valid(col))` | `jsonb` | The `json_valid` check is the one dialect-specific fragment in the migrations; Postgres gets the guarantee from the column type |

Consequences of the intersection, all of which the schema below obeys:

- **No enumerated types.** Postgres `ENUM` has no SQLite counterpart and cannot be extended in a
  portable migration. Closed vocabularies are `TEXT` with a `CHECK (col IN (...))`. Vocabularies
  that plugins may extend (`items.item_type`, `graph_edges.edge_type`, `jobs.job_type`,
  `check_results.check_id`) carry **no** database `CHECK`; they are validated by the Zod schema in
  `packages/schemas` against a registry the plugin host contributes to. Where a vocabulary is
  closed, the section says so explicitly.
- **No arrays.** Postgres arrays have no SQLite counterpart. Repeated values are either a child
  table (the default) or a `JSON` array where the value is opaque to SQL (`terms.tree_numbers`,
  `api_tokens.scopes`).
- **No `uuid`, `money`, `inet`, `tsvector` columns** in the portable schema. Full-text index
  structures are dialect-specific and live outside the shared migrations (§9).
- **Money is `INTEGER` minor units plus an ISO-4217 currency code.** `REAL` is never used for an
  amount.
- **Case folding differs.** SQLite `LIKE` is case-insensitive for ASCII, Postgres is not; `COLLATE
  NOCASE` does not exist in Postgres. Every uniqueness or lookup rule that should ignore case gets a
  stored, application-maintained `*_normalised` column (NFKC, casefolded, whitespace collapsed) and
  a plain index on it. No expression indexes on `lower()`.
- **Nullable columns cannot carry uniqueness.** `NULL`s are distinct in a unique index in both
  dialects, so a rule like "one row per `(parent, name)`, roots included" cannot be written over a
  nullable `parent_id`. Wherever that is needed the table carries an application-maintained mirror
  column named `<col>_key` or `<col>_scope_key`, holding `COALESCE(<col>, '')`, and the unique index
  is built over the mirror. The mirror is written in the same statement as the column it shadows.
  Tables using the pattern: `collections.parent_key`, `field_values.review_scope_key` /
  `form_scope_key` / `group_scope_key`, `item_terms.qualifier_key`, `graph_edges.scheme_key` /
  `run_key`, `check_results.run_scope_key`, `rob_assessments.outcome_key`,
  `prisma_counts.source_scope_key` / `reason_scope_key`.
- **Partial unique indexes over a parent's state need a mirrored flag.** `item_bibliographic` and
  `item_office` carry `item_trashed_at`, mirrored from `items.trashed_at`, so that "unique among
  live items" is expressible without a join.
- **Partial indexes are used freely** — both dialects support `CREATE [UNIQUE] INDEX ... WHERE`.
  They carry most of the soft-delete and "one current row" invariants.
- **`RETURNING` is used** (SQLite ≥ 3.35, Postgres): the job claim in §6.3 depends on it.
- **`ON DELETE` is almost always `RESTRICT`,** because P5 says nothing is deleted. `CASCADE` appears
  only on pure join and child tables whose rows have no independent meaning (`collection_items`,
  `item_tags`, `annotation_tags`, `review_record_sources`, `job_logs`, `edge_evidence`).
  `SET NULL` appears only where a nullable back-reference is genuinely optional.
- SQLite deployments run with `PRAGMA foreign_keys = ON`, `journal_mode = WAL`,
  `busy_timeout = 5000` and `synchronous = NORMAL`. Foreign keys are not optional.

### 1.2 Naming

`lower_snake_case`, plural table names, singular column names, no identifier over 63 characters
(the Postgres limit). Foreign keys are `<referenced_table_singular>_id`. Indexes are `ix_<table>_<cols>`,
unique indexes `ux_<table>_<cols>`, check constraints `ck_<table>_<rule>`.

SQL keywords are avoided as identifiers even though Drizzle quotes them, because the job queue and
the audit log are meant to be inspectable with a plain `sqlite3` or `psql` session (ADR-0010). This
is why the schema says `public_id` and not `key`, `source_database` and not `database`, `count_value`
and not `count`, `logged_at` and not `at`, and `language_code` and not `language`.

### 1.3 Keys and public identifiers

Every table has a surrogate `id ID` primary key, except pure join tables which use the composite of
their foreign keys. Surrogate keys are ULIDs generated by the application, never by the database, so
that a record can be constructed and referenced inside one transaction and so that ids survive an
export/import round trip.

Entities that appear in URLs, in citation keys, in the connector protocol or in a
`recueil://item/<id>` deep link additionally carry `public_id TEXT NOT NULL UNIQUE`: an
eight-character uppercase Crockford base32 string, deliberately Zotero-key-shaped so that Zotero
item keys can be carried across at import (§6 of CONCEPT.md) and so the REST API can expose it as
`key` without a second identifier scheme. Tables with a `public_id`: `items`, `collections`,
`notes`, `annotations`, `reviews`, `curated_networks`.

### 1.4 Ownership and the multi-user future

v1 is single-user (CONCEPT §2 non-goals), but the schema must not need a migration to become multi-user.
Top-level user-owned records carry `owner_user_id ID NOT NULL REFERENCES users(id)`: `items`,
`collections`, `tags`, `notes`, `annotations` (as `author_user_id`), `reviews`, `curated_networks`.
In v1 every row holds the single local user's id.

`documents` deliberately has **no** owner. A document is content, identified by its hash (ADR-0004);
the same bytes may legitimately be reachable from two users' items. Access is decided at the
`attachments` row, which belongs to an item, which has an owner. Library-global configuration
(`custom_fields`, `terms`, `plugins`) is likewise unowned; when multi-user arrives these gain a
scope column rather than an owner.

### 1.5 Soft delete (P5)

Two mechanisms, always used together.

1. Every soft-deletable table carries `trashed_at TIMESTAMP NULL`. All ordinary queries filter
   `trashed_at IS NULL`, and the hot indexes are partial on that predicate.
2. The `trash` table (§6.6) holds one row per trashed entity with the actor, the reason and a
   `restore_payload` capturing anything that had to be detached.

**Invariant (T1).** For every soft-deletable table, `trashed_at IS NOT NULL` if and only if there is
a row in `trash` for that `(entity_type, entity_id)` with `restored_at IS NULL AND purged_at IS
NULL`. Trashing and restoring are single transactions that write both places.

Soft-deletable tables: `documents`, `items`, `attachments`, `collections`, `notes`, `annotations`,
`tags`, `creators`, `users`, `reviews`, `curated_networks`.

Not soft-deletable, and why:

- `audit_log` is append-only; nothing is ever removed from it.
- `graph_edges` with `derivation = 'derived'`, and the derived rows of `item_metrics`, are
  recomputable projections. They are replaced wholesale per run and hard-deleted. P5 protects
  authored data, not caches.
- Join rows (`collection_items`, `item_tags`, `item_terms`, `annotation_tags`) are hard-deleted;
  their prior state is reconstructible from `audit_log` and from the parent's `restore_payload`.

### 1.6 Provenance (P4)

Three distinct mechanisms, for three distinct shapes of derived fact.

| Where | Mechanism |
|---|---|
| Bibliographic and office **field values** | `field_provenance` rows, one per `(entity, field_path)`, carrying source, confidence, fetch time and the manual lock (§3.6) |
| **Graph edges** | Columns on the edge itself: `provenance_source`, `provenance_fetched_at`, `confidence`, `derivation`, `run_id`, plus `edge_evidence` child rows |
| **Everything else** — tag assignments, term assignments, merges, screening decisions | A `source` column on the join or decision row, plus the `audit_log` entry |

### 1.7 Concurrency

`items`, `notes` and `annotations` carry `version INTEGER NOT NULL DEFAULT 1`, incremented on every
write. The REST API exposes it as an ETag; a conditional write with a stale version is rejected
rather than merged (P1: "conflicts logged, not merged"). The rejected write is recorded in
`audit_log` with `action = '<entity>.conflict'`.

### 1.8 Timestamps

`created_at`/`updated_at` are on every table that is not append-only, and are set by the application
(not by triggers or defaults), so that importers can preserve original timestamps. `items` uses
`date_added`/`date_modified` instead, matching the names the Zotero importer and the connector
protocol already use.

---

## 2. Table overview

| Table | CONCEPT.md §5.2 entity | Phase | Notes |
|---|---|---|---|
| `users` | User | 1 | Exactly one row in v1 |
| `api_tokens` | ApiToken | 1 | Also carries web sessions |
| `documents` | Document | 1 | Content-addressed, ADR-0004 |
| `items` | Item | 1 | |
| `item_bibliographic` | Item.Bibliographic | 1 | 1:1 facet |
| `item_office` | Item.Office | 2 | 1:1 facet |
| `attachments` | Attachment | 1 | M:N item ↔ document |
| `field_provenance` | *(implied by P4)* | 3 | Added below; CONCEPT §5.2 lists it as a property of the bibliographic facet |
| `item_metrics` | *(implied by CONCEPT §5.4, ADR-0008)* | 5 | Metric time series |
| `collections` | Collection | 1 | Hierarchical; also holds smart collections |
| `collection_items` | *(join)* | 1 | |
| `tags` | Tag | 1 | |
| `item_tags` | *(join)* | 1 | |
| `annotation_tags` | *(join)* | 4 | Needed by the Zotero importer |
| `custom_fields` | CustomField | 1 | |
| `field_values` | FieldValue | 1 | Also the SR extraction store |
| `notes` | Note | 1 | |
| `annotations` | Annotation | 4 | ADR-0009 |
| `creators` | Creator | 1 | |
| `item_creators` | *(join)* | 1 | Carries role, order and affiliation |
| `terms` | Term | 5 | |
| `item_terms` | *(join)* | 5 | |
| `shadow_works` | ShadowWork | 5 | |
| `graph_nodes` | GraphNode | 5 | |
| `graph_edges` | GraphEdge | 5 | |
| `edge_evidence` | *(the "evidence" column of GraphEdge)* | 5 | Citation contexts, CONCEPT §5.8 |
| `review_queue` | ReviewQueueEntry | 2 | P3 |
| `check_results` | *(implied by CONCEPT §5.5)* | 3 | Check outcomes with timestamps |
| `jobs` | Job | 1 | P9, ADR-0010 |
| `job_logs` | *(the "log" column of Job)* | 1 | |
| `audit_log` | AuditLog | 1 | Append-only, P5 |
| `trash` | Trash | 1 | Soft delete, P5 |
| `plugins` | Plugin | 3 | |
| `curated_networks` | CuratedNetwork | 6 | |
| `curated_network_versions` | *(the "version history" of CuratedNetwork)* | 6 | |
| `reviews` | Review | 7 | |
| `search_runs` | SearchRun | 7 | |
| `review_records` | *(implied: the review ↔ item join)* | 7 | PRISMA's unit of counting |
| `review_record_sources` | *(implied by "records identified per source")* | 7 | |
| `screening_decisions` | ScreeningDecision | 7 | |
| `extraction_forms` | ExtractionForm | 7 | |
| `rob_assessments` | RoBAssessment | 7 | |
| `prisma_counts` | PrismaCounts | 7 | Frozen snapshots; live counts are a query |

Nine tables above are not named in CONCEPT §5.2. Each exists because a CONCEPT §5.2 entity lists a property that is
one-to-many and therefore cannot be a column: the field-level provenance and lock flags on
`Item.Bibliographic`, the `log` on `Job`, the `evidence` on `GraphEdge`, the version history on
`CuratedNetwork`, annotation tags for Zotero import fidelity, metric time series required by CONCEPT §5.4
and the ADR-0008 Parquet bundle, check results required by CONCEPT §5.5, and the review ↔ item join with
per-source tracking that PRISMA counting requires (CONCEPT §5.6, CONCEPT §5.10).

---

## 3. Library core

### 3.1 `users`

**Purpose.** The account a record belongs to and an action is attributed to. One row in v1; the
column set is already what a multi-user deployment needs so that adding accounts is a data change,
not a migration.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `username` | `TEXT` | no | Login handle |
| `username_normalised` | `TEXT` | no | NFKC casefolded; the uniqueness key |
| `email` | `TEXT` | yes | Also used as the Unpaywall polite-pool address if no separate one is configured |
| `display_name` | `TEXT` | yes | |
| `password_hash` | `TEXT` | yes | argon2id. `NULL` when the account authenticates by token only |
| `is_active` | `BOOLEAN` | no | Default `1` |
| `is_admin` | `BOOLEAN` | no | Default `1` for the initial user |
| `locale` | `TEXT` | yes | BCP-47 |
| `timezone` | `TEXT` | yes | IANA name; only affects presentation, never storage |
| `settings` | `JSON` | no | Default `{}`. UI preferences, default collection, citation style |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `last_seen_at` | `TIMESTAMP` | yes | |
| `trashed_at` | `TIMESTAMP` | yes | Deactivation never removes the row; audit rows must keep resolving |

**Constraints.** `ux_users_username_normalised` unique. `ck_users_admin_active`: an inactive user
cannot be the only admin — enforced in the service layer, not in SQL, because it is a cross-row rule.

**Invariants.**
- U1. `trashed_at IS NOT NULL` implies `is_active = 0`.
- U2. At least one row with `is_admin = 1 AND is_active = 1` exists at all times.

### 3.2 `api_tokens`

**Purpose.** Scoped bearer credentials for the CLI, MCP server, connector, R and Python clients, and
the web UI's session cookie. Every write in `audit_log` is attributable to a token or a user.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `user_id` | `ID` | no | FK → `users(id)` `ON DELETE RESTRICT` |
| `name` | `TEXT` | no | Human label ("laptop CLI", "Overleaf bib feed") |
| `token_prefix` | `TEXT` | no | First 12 characters of the secret, stored in clear for display and for a cheap index lookup |
| `token_hash` | `TEXT` | no | SHA-256 of the full secret. The secret itself is shown once and never stored |
| `scopes` | `JSON` | no | Array of scope strings (`items:read`, `sr:write`, `analytics:read`, …). Default `[]` |
| `client` | `TEXT` | no | `cli`, `mcp`, `connector`, `r`, `python`, `web_session`, `bib_feed`, `other`. Closed vocabulary |
| `created_at` | `TIMESTAMP` | no | |
| `created_by_user_id` | `ID` | yes | FK → `users(id)`; `NULL` for the bootstrap token |
| `expires_at` | `TIMESTAMP` | yes | `NULL` means no expiry |
| `last_used_at` | `TIMESTAMP` | yes | Written at most once per minute per token to avoid a write per request |
| `revoked_at` | `TIMESTAMP` | yes | |
| `note` | `TEXT` | yes | |

**Constraints.** `ux_api_tokens_token_hash` unique; `ux_api_tokens_token_prefix` unique.

**Indexes.** `ix_api_tokens_user_id`.

**Invariants.**
- A1. A token is usable when `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)` and
  its user has `is_active = 1`.
- A2. Tokened `.bib` feed URLs (CONCEPT §5.11) use a `client = 'bib_feed'` token whose scopes are read-only;
  the API refuses to mint a feed URL from a token with write scopes.
- A3. Revocation is never a delete: the row stays so that `audit_log.actor_token_id` resolves.

### 3.3 `documents`

**Purpose.** One row per distinct byte sequence in the library. This is the content-addressed layer
of ADR-0004: identity is the SHA-256 of the bytes, and path, filename and mtime are metadata that
never define sameness (P2).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK. A surrogate, so that the hash can be re-derived or corrected without rewriting every foreign key |
| `sha256` | `TEXT` | no | 64 lowercase hex characters. The identity |
| `byte_size` | `INTEGER` | no | `CHECK (byte_size >= 0)` |
| `mime_type` | `TEXT` | no | Sniffed, not trusted from the uploader |
| `mime_source` | `TEXT` | no | `sniffed`, `declared`, `extension`, `manual` |
| `original_filename` | `TEXT` | yes | As received; purely informational |
| `storage_backend` | `TEXT` | no | `local`, `webdav`, `s3`. Closed vocabulary |
| `storage_key` | `TEXT` | no | Backend-relative key. For `local`: `<aa>/<bb>/<sha256>` per ADR-0004 |
| `storage_verified_at` | `TIMESTAMP` | yes | Last time the blob was confirmed present and hash-correct |
| `storage_ok` | `BOOLEAN` | no | Default `1`; set `0` by the `attachment_integrity` check on mismatch |
| `page_count` | `INTEGER` | yes | PDFs and multi-page TIFFs |
| `has_text_layer` | `BOOLEAN` | yes | `NULL` until examined |
| `text_extracted_at` | `TIMESTAMP` | yes | |
| `text_char_count` | `INTEGER` | yes | Cheap emptiness signal for the OCR gate |
| `ocr_status` | `TEXT` | no | `not_applicable`, `not_needed`, `pending`, `done`, `failed`, `skipped`. Closed vocabulary. Default `not_applicable` |
| `simhash` | `TEXT` | yes | 16 hex characters (64-bit) over the extracted text; the near-duplicate blocking key (CONCEPT §5.6) |
| `source_kind` | `TEXT` | no | `upload`, `folder`, `webdav`, `imap`, `scanner`, `connector`, `mobile`, `import`, `api`, `plugin`, `derived`. Closed vocabulary |
| `source_ref` | `TEXT` | yes | Watched-folder path, IMAP message-id, capture URL, importer record id |
| `source_detail` | `JSON` | no | Default `{}`. Sender, subject, scanner id, connector page title, archive member path |
| `parent_document_id` | `ID` | yes | FK → `documents(id)`. Set when this document was extracted from an archive (zip, eml) — CONCEPT §5.3 stage 3 |
| `ingested_at` | `TIMESTAMP` | no | First time these bytes entered the library |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `trashed_at` | `TIMESTAMP` | yes | |

**Constraints.**
- `ux_documents_sha256` unique — the single most important constraint in the schema.
- `ck_documents_sha256_shape`: `length(sha256) = 64`.
- `ck_documents_storage`: `storage_key <> ''`.

**Indexes.** `ix_documents_mime_type`, `ix_documents_ingested_at`, `ix_documents_simhash`
(partial, `WHERE simhash IS NOT NULL AND trashed_at IS NULL`), `ix_documents_source`
(`source_kind, source_ref`), `ix_documents_parent_document_id` (partial, `WHERE parent_document_id IS NOT NULL`),
`ix_documents_live` (partial on `ingested_at WHERE trashed_at IS NULL`).

**Invariants (content-hash identity, ADR-0004).**
- D1. `sha256` is the identity. Ingesting bytes whose hash already exists never inserts a second
  row; the pipeline links the existing document and stops at stage 2 (CONCEPT §5.3).
- D2. `(storage_backend, storage_key)` locates exactly the bytes whose digest is `sha256`. A
  mismatch is a hard integrity failure: it sets `storage_ok = 0`, raises a `review_queue` entry and
  never silently rewrites `sha256`.
- D3. Bytes are immutable. Nothing in the application rewrites a stored blob — this is what makes
  annotations records rather than embedded PDF objects (ADR-0009) and what makes the store readable
  without the application (P10).
- D4. A document may have zero attachments (an ingested file not yet filed, sitting in the review
  queue) or many (the same PDF attached to several items). Trashing an item never trashes a
  document; a document is trashable only when it has no live attachment. The rule is symmetric and
  has to be enforced from both ends: **no live attachment may reference a trashed document**, so
  attaching one, re-ingesting bytes whose document is in the trash, and restoring an attachment
  whose document was trashed while it sat in the bin are all refused. Enforcing only the trash
  direction leaves three ordinary paths into the state the invariant forbids.
- D5. Documents are unowned; see §1.4.

### 3.4 `items`

**Purpose.** The library record — the thing a user thinks of as "an entry". Facet tables hang off it;
attachments connect it to files. An item exists independently of whether any file is attached.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `public_id` | `TEXT` | no | Eight-character key; see §1.3 |
| `item_type` | `TEXT` | no | `article`, `book`, `chapter`, `report`, `thesis`, `dataset`, `preprint`, `webpage`, `conference_paper`, `software`, `standard`, `patent`, `invoice`, `letter`, `contract`, `receipt`, `certificate`, `photo`, `note` (standalone), `attachment_only`, … **Open vocabulary**: no DB `CHECK`, validated by Zod against the registry (§1.1) |
| `title` | `TEXT` | yes | Display title for every facet. Kept in step with `item_bibliographic.title` when that facet exists (see I3) |
| `owner_user_id` | `ID` | no | FK → `users(id)` |
| `library_state` | `TEXT` | no | `normal`, `merged`, `template`. Closed vocabulary. Default `normal` |
| `merged_into_item_id` | `ID` | yes | FK → `items(id)`. Set when this item lost a dedup merge (CONCEPT §5.6). The row survives in the trash with a reversible merge record |
| `promoted_from_shadow_work_id` | `ID` | yes | FK → `shadow_works(id)`. Records that this item began as an external stub (CONCEPT §5.8) |
| `source_system` | `TEXT` | yes | `zotero`, `paperless`, `bibtex`, `ris`, `endnote`, `csl_json`, `mendeley`, `csv`, `connector`, `pubmed`, … |
| `source_id` | `TEXT` | yes | The identifier in that system (Zotero item key, Paperless document id) |
| `extra` | `TEXT` | yes | Zotero's free-text `Extra` field, preserved verbatim for round-tripping |
| `version` | `INTEGER` | no | Optimistic concurrency, §1.7. Default `1` |
| `date_added` | `TIMESTAMP` | no | Preserved by importers |
| `date_modified` | `TIMESTAMP` | no | |
| `trashed_at` | `TIMESTAMP` | yes | |

**Constraints.**
- `ux_items_public_id` unique.
- `ux_items_source` unique on `(source_system, source_id)`, partial `WHERE source_system IS NOT NULL
  AND source_id IS NOT NULL`. This is what makes the Zotero and Paperless importers idempotent (P9,
  CONCEPT §6): a re-run updates the existing row instead of creating a twin.

**Indexes.** `ix_items_item_type`, `ix_items_owner_live` (`owner_user_id, date_modified` partial
`WHERE trashed_at IS NULL`), `ix_items_date_added`, `ix_items_merged_into`
(partial `WHERE merged_into_item_id IS NOT NULL`).

**Invariants.**
- I1. Every item has at most one `item_bibliographic` row and at most one `item_office` row. Both
  may be present (a scanned conference programme that is also a bibliographic record); neither need be.
- I2. `library_state = 'merged'` if and only if `merged_into_item_id IS NOT NULL`, and such an item
  is always also trashed. It is never returned by list endpoints and never appears in exports.
- I3. When `item_bibliographic` exists, `items.title` mirrors `item_bibliographic.title`. The
  duplication is deliberate: the library list view and full-text index must not join a facet table
  to render a row, and office-only items need a title too. The service layer owns the mirroring; it
  is asserted by a test, not by a trigger, because trigger syntax is not portable.
- I4. Deleting an item is always a soft delete (§1.5), which cascades logically — not with `ON DELETE
  CASCADE` — to its facets, attachments, notes and annotations, all of which get their own
  `trashed_at` and a single shared `trash` row group.

### 3.5 `item_bibliographic`

**Purpose.** The scholarly facet (CONCEPT.md §5.2 "Item.Bibliographic"). Present on items that are
literature. A separate table rather than nullable columns on `items` because roughly half the
library — invoices, letters, photos — will never have any of it, and because per-field provenance
attaches to this facet specifically.

| Column | Type | Null | Notes |
|---|---|---|---|
| `item_id` | `ID` | no | PK **and** FK → `items(id)` `ON DELETE RESTRICT`. One-to-one |
| `csl_type` | `TEXT` | yes | CSL item type, when it differs from the Recueil `item_type` mapping |
| `title` | `TEXT` | yes | |
| `subtitle` | `TEXT` | yes | |
| `short_title` | `TEXT` | yes | Feeds the citation key formula (ADR-0016) |
| `container_title` | `TEXT` | yes | Journal, book, proceedings — bibliometrix `SO` |
| `container_short` | `TEXT` | yes | ISO-4 abbreviation |
| `collection_title` | `TEXT` | yes | Series |
| `collection_number` | `TEXT` | yes | |
| `publisher` | `TEXT` | yes | |
| `publisher_place` | `TEXT` | yes | |
| `edition` | `TEXT` | yes | |
| `volume` | `TEXT` | yes | `TEXT`, not `INTEGER` — volumes are `12`, `12A`, `II` |
| `issue` | `TEXT` | yes | |
| `pages` | `TEXT` | yes | Range as printed |
| `page_first` | `INTEGER` | yes | Parsed, for the `plausibility` check and for sorting |
| `page_last` | `INTEGER` | yes | |
| `number_of_pages` | `INTEGER` | yes | |
| `issued_date` | `EDTF` | yes | May be year-only. The canonical publication date |
| `issued_year` | `INTEGER` | yes | Derived from `issued_date`; bibliometrix `PY`, and the only date column that is safe to index for range queries |
| `issued_month` | `INTEGER` | yes | `CHECK (issued_month BETWEEN 1 AND 12)` |
| `available_date` | `EDTF` | yes | Online-first date |
| `accessed_at` | `TIMESTAMP` | yes | For webpages and datasets |
| `doi` | `TEXT` | yes | Stored lowercase, without the `https://doi.org/` prefix |
| `pmid` | `TEXT` | yes | Digits only |
| `pmcid` | `TEXT` | yes | `PMC` prefix retained |
| `arxiv_id` | `TEXT` | yes | Including version suffix when known |
| `isbn` | `TEXT` | yes | ISBN-13, hyphenless |
| `issn` | `TEXT` | yes | Print ISSN, hyphenated |
| `eissn` | `TEXT` | yes | |
| `issn_l` | `TEXT` | yes | Linking ISSN — the venue key used by `graph_nodes` |
| `openalex_id` | `TEXT` | yes | `W…` |
| `semantic_scholar_id` | `TEXT` | yes | S2 paper id |
| `datacite_doi` | `TEXT` | yes | When distinct from `doi` |
| `handle` | `TEXT` | yes | |
| `url` | `TEXT` | yes | |
| `abstract` | `TEXT` | yes | bibliometrix `AB` |
| `language_code` | `TEXT` | yes | BCP-47 |
| `citation_key` | `TEXT` | yes | Stable, exported to BibTeX; bibliometrix `SR` |
| `citation_key_locked` | `BOOLEAN` | no | Default `0`. When `1`, regeneration never touches it (ADR-0016) |
| `citation_key_formula` | `TEXT` | yes | The formula that produced it, so drift can be detected by the `citation_key` check |
| `licence` | `TEXT` | yes | SPDX id or licence URL. Maps to the CSL-JSON `license` field — the spelling differs because prose and identifiers here are British English (CONCEPT.md), the CSL key is not |
| `oa_status` | `TEXT` | yes | `closed`, `green`, `bronze`, `hybrid`, `gold`, `diamond`, `unknown` |
| `oa_url` | `TEXT` | yes | From Unpaywall |
| `oa_checked_at` | `TIMESTAMP` | yes | |
| `is_preprint` | `BOOLEAN` | no | Default `0` |
| `published_version_doi` | `TEXT` | yes | Set by the `preprint_published` check |
| `preprint_checked_at` | `TIMESTAMP` | yes | |
| `version_label` | `TEXT` | yes | `v2`, "accepted manuscript" |
| `retraction_status` | `TEXT` | no | `none`, `retracted`, `corrected`, `expression_of_concern`, `withdrawn`, `unknown`. Closed vocabulary. Default `unknown` |
| `retraction_notice_doi` | `TEXT` | yes | |
| `retraction_checked_at` | `TIMESTAMP` | yes | |
| `item_trashed_at` | `TIMESTAMP` | yes | Mirrored from the parent; see §1.1 |
| `verification_status` | `TEXT` | no | `unverified`, `verified`, `disputed`, `unverifiable`. Closed vocabulary. Set by the `existence` and `doi_resolves` checks; `unverifiable` is the "possible fabrication" outcome of CONCEPT §5.5 |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |

**Constraints.**
- `ux_item_bibliographic_doi` unique on `doi`, partial `WHERE doi IS NOT NULL`. Two live items may
  not claim the same DOI; the record-layer deduplicator (CONCEPT §5.6) resolves the collision before insert.
  A merged (and therefore trashed) loser is excluded by an additional `AND` on a `trashed_at`
  predicate, which requires the column to be mirrored here — so the facet carries
  `item_trashed_at TIMESTAMP NULL`, maintained with the parent, purely so partial unique indexes can
  be written without a join.
- `ux_item_bibliographic_citation_key` unique on `citation_key`, partial `WHERE citation_key IS NOT
  NULL AND item_trashed_at IS NULL`. This is the `citation_key` collision check as a database
  constraint.
- `ck_item_bibliographic_pages`: `page_last IS NULL OR page_first IS NULL OR page_last >= page_first`.

**Indexes.** `ix_item_bib_issued_year`, `ix_item_bib_container_title`, `ix_item_bib_pmid` (partial),
`ix_item_bib_openalex_id` (partial), `ix_item_bib_arxiv_id` (partial), `ix_item_bib_isbn` (partial),
`ix_item_bib_issn_l` (partial), `ix_item_bib_retraction_status` (partial `WHERE retraction_status
NOT IN ('none','unknown')`).

**Invariants.**
- B1. Identifier columns are stored normalised: DOI lowercased and prefix-stripped, ISBN converted
  to hyphenless ISBN-13, arXiv ids in the modern form. Normalisation happens once, on write, so the
  deduplicator can compare with `=` rather than a function.
- B2. `is_preprint = 1` and `published_version_doi IS NOT NULL` together are the trigger condition
  for the `preprint_published` check; they are not automatically resolved into a merge.
- B3. Any column in this table may be locked against enrichment; see §3.6.

### 3.6 `field_provenance`

**Purpose.** Per-field source, confidence, timestamp and manual lock (P4, CONCEPT §5.4: "manual edits locked
per field and never overwritten"). Generic over entity type so that the same mechanism covers the
bibliographic facet, the office facet and creator identity, rather than three parallel designs.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `entity_type` | `TEXT` | no | `item_bibliographic`, `item_office`, `creators`, `item_creators`. Closed vocabulary |
| `entity_id` | `ID` | no | The `item_id` or `creator_id`. No SQL foreign key — polymorphic (§12, open question O5) |
| `field_path` | `TEXT` | no | Column name, e.g. `doi`, `container_title`. A dotted path for nested JSON values |
| `source` | `TEXT` | no | `manual`, `import:zotero`, `crossref`, `openalex`, `pubmed`, `semantic_scholar`, `datacite`, `arxiv`, `openlibrary`, `google_books`, `orcid`, `unpaywall`, `grobid`, `heuristic`, `rule`, `plugin:<name>` |
| `source_record_id` | `TEXT` | yes | The upstream record the value came from, so a claim can be re-fetched and re-checked |
| `source_version` | `TEXT` | yes | Upstream version or `indexed` timestamp where the API provides one |
| `confidence` | `REAL` | yes | `CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))` |
| `fetched_at` | `TIMESTAMP` | no | When the value was obtained |
| `applied_at` | `TIMESTAMP` | no | When it was written to the facet column |
| `locked` | `BOOLEAN` | no | Default `0`. `1` means no resolver may overwrite this field |
| `locked_at` | `TIMESTAMP` | yes | |
| `locked_by_user_id` | `ID` | yes | FK → `users(id)` |
| `previous_value` | `TEXT` | yes | The value this one replaced, as text. A convenience duplicate of the `audit_log` entry, kept so that a per-field history is one indexed query |

**Constraints.** `ux_field_provenance_current` unique on `(entity_type, entity_id, field_path)` —
one current provenance row per field. History lives in `audit_log`.

**Indexes.** `ix_field_provenance_entity` (`entity_type, entity_id`), `ix_field_provenance_locked`
(partial `WHERE locked = 1`), `ix_field_provenance_source`.

**Invariants (the P4 contract).**
- P4-1. Every non-null value in `item_bibliographic` and `item_office` that was **not** typed by a
  human has a `field_provenance` row. Manually typed values get one too, with `source = 'manual'`
  and `locked = 1` — editing a field by hand locks it. This is the rule that makes "manual edits
  never overwritten" a property of the data rather than of a code path.
- P4-2. A resolver merge writes a field only if there is no row for it, or the existing row has
  `locked = 0` **and** the resolver's source outranks the stored `source` in the configured
  preference order, or the stored `confidence` is lower. The merge policy is configuration; the lock
  is not overridable by configuration.
- P4-3. Unlocking is an explicit user action, recorded in `audit_log`. Clearing a field does not
  clear its provenance row: `previous_value` is retained.
- P4-4. Bulk enrichment reports how many fields it skipped because of locks; a run that silently
  overwrites nothing and says nothing is a bug.

### 3.7 `item_office`

**Purpose.** The private/office facet (CONCEPT.md §5.2 "Item.Office"), covering the Paperless-ngx
mapping: correspondent, document date, archive serial number, amounts and reference numbers.

| Column | Type | Null | Notes |
|---|---|---|---|
| `item_id` | `ID` | no | PK **and** FK → `items(id)` `ON DELETE RESTRICT` |
| `correspondent` | `TEXT` | no | Free text as extracted or entered |
| `correspondent_normalised` | `TEXT` | yes | For grouping and rule matching |
| `correspondent_creator_id` | `ID` | yes | FK → `creators(id)`, `kind = 'organisation'`. Optional promotion of a correspondent to a first-class entity |
| `office_document_type` | `TEXT` | yes | `invoice`, `letter`, `contract`, `receipt`, `statement`, `certificate`, `payslip`, `tax`, `medical`, `other`. Open vocabulary — the Paperless importer carries user-defined types across |
| `document_date` | `DATE` | yes | The date printed on the document, not the ingest date |
| `asn` | `INTEGER` | yes | Paperless archive serial number |
| `reference_number` | `TEXT` | yes | Invoice number, case number, contract number |
| `amount_minor` | `INTEGER` | yes | Minor units. Never `REAL` |
| `amount_currency` | `TEXT` | yes | ISO-4217, three uppercase letters |
| `due_date` | `DATE` | yes | |
| `period_start` | `DATE` | yes | For statements and contracts |
| `period_end` | `DATE` | yes | |
| `item_trashed_at` | `TIMESTAMP` | yes | Mirrored from the parent, for partial unique indexes |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |

**Constraints.**
- `ux_item_office_asn` unique on `asn`, partial `WHERE asn IS NOT NULL AND item_trashed_at IS NULL`.
  The ASN is a physical filing number and must be unique in the library.
- `ck_item_office_amount`: `(amount_minor IS NULL) = (amount_currency IS NULL)`.
- `ck_item_office_period`: `period_end IS NULL OR period_start IS NULL OR period_end >= period_start`.

**Indexes.** `ix_item_office_correspondent_normalised`, `ix_item_office_document_date`,
`ix_item_office_type_date` (`office_document_type, document_date`).

**Invariants.**
- O1. Fields beyond this set go to `custom_fields`/`field_values`, not to new columns. The facet
  covers what the ingestion rule engine and the Paperless importer need; everything else is
  user-defined by design (CONCEPT §5.2, "CustomField / FieldValue").
- O2. `document_date` participates in the same provenance mechanism as bibliographic fields: a
  heuristic date extraction (CONCEPT §5.3 stage 6) writes `field_provenance` with `source = 'heuristic'` and
  a confidence, and a user correction locks it.

### 3.8 `attachments`

**Purpose.** The many-to-many between items and documents, carrying the role the file plays for that
item. This table is the reason a single PDF shared by two items is stored once (ADR-0004) and the
reason an item can have a scan, a supplement and a web snapshot at the same time.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `item_id` | `ID` | no | FK → `items(id)` `ON DELETE RESTRICT` |
| `document_id` | `ID` | yes | FK → `documents(id)` `ON DELETE RESTRICT`. `NULL` only for `link_mode = 'linked_url'` |
| `role` | `TEXT` | no | `primary`, `supplement`, `snapshot`, `scan`, `preprint`, `accepted_manuscript`, `data`, `code`, `cover`, `source_export`, `other`. Closed vocabulary |
| `link_mode` | `TEXT` | no | `stored` (bytes in a Recueil backend), `linked_file` (a path outside the store, desktop only), `linked_url` (a bookmark, no bytes). Closed vocabulary |
| `title` | `TEXT` | yes | Display label; defaults to the document filename |
| `url` | `TEXT` | yes | Required for `linked_url`; the capture URL for `snapshot` |
| `linked_path` | `TEXT` | yes | Required for `linked_file`; absolute path on the machine that owns the link |
| `content_type_hint` | `TEXT` | yes | Declared MIME for linked attachments, where nothing can be sniffed |
| `has_annotations` | `BOOLEAN` | no | Default `0`. Denormalised from `annotations`; CONCEPT §5.2 names it explicitly because the reader needs it without a join |
| `annotation_count` | `INTEGER` | no | Default `0` |
| `position` | `INTEGER` | no | Sort order within the item. Default `0` |
| `added_at` | `TIMESTAMP` | no | |
| `added_by_user_id` | `ID` | yes | FK → `users(id)` |
| `source` | `TEXT` | no | `manual`, `ingest`, `import`, `connector`, `resolver` (an OA PDF fetched by the `oa_status` check), `merge` (re-parented from a merge loser). Closed vocabulary |
| `updated_at` | `TIMESTAMP` | no | |
| `trashed_at` | `TIMESTAMP` | yes | |

**Constraints.**
- `ck_attachments_link_mode`:
  `(link_mode = 'linked_url' AND document_id IS NULL AND url IS NOT NULL)`
  `OR (link_mode = 'linked_file' AND document_id IS NULL AND linked_path IS NOT NULL)`
  `OR (link_mode = 'stored' AND document_id IS NOT NULL)`.
- `ux_attachments_item_document` unique on `(item_id, document_id)`, partial `WHERE document_id IS
  NOT NULL AND trashed_at IS NULL`. The same file is never attached to the same item twice.
- `ux_attachments_primary` unique on `(item_id)`, partial `WHERE role = 'primary' AND trashed_at IS
  NULL`. At most one primary attachment per item.

**Indexes.** `ix_attachments_document_id` (partial `WHERE trashed_at IS NULL`) — the reverse lookup
"which items use this file", which the deduplicator and the storage garbage report both need;
`ix_attachments_item_position` (`item_id, position`); `ix_attachments_role`.

**Invariants (the item ↔ document many-to-many).**
- AT1. Attaching an already-known file creates an `attachments` row and no `documents` row (D1).
  Two items citing the same supplementary dataset share one blob.
- AT2. Detaching is a soft delete of the attachment row only. The document survives; storage
  reclamation is a separate, explicit operation over documents with no live attachment.
- AT3. A merge (CONCEPT §5.6) re-parents attachments by rewriting `item_id` to the winner and setting
  `source = 'merge'`; the previous `item_id` is in the `trash.restore_payload` of the loser, so the
  merge is reversible.
- AT4. `has_annotations` and `annotation_count` are maintained by the annotation service in the same
  transaction as the annotation write. They are a cache; a nightly job asserts they agree with
  `annotations`, and a disagreement is a bug, not a repair-and-forget.
- AT5. `linked_file` attachments only make sense in the desktop shell and are never exported to a
  server deployment without a warning: the path is not portable and the bytes are not in the store,
  which is a P10 hazard.

### 3.9 `item_metrics`

**Purpose.** The metric time series required by CONCEPT §5.4 ("metrics stored with timestamp for time
series") and shipped as the `metrics` table of the ADR-0008 Parquet bundle. Separate from
`item_bibliographic` because a metric is an observation with a date, not a property of the work.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `item_id` | `ID` | no | FK → `items(id)` `ON DELETE RESTRICT` |
| `metric` | `TEXT` | no | `cited_by_count`, `influential_citation_count`, `reference_count`, `fwci`, `venue_2yr_mean_citedness`, `altmetric_score`, … Open vocabulary (plugins contribute) |
| `metric_value` | `REAL` | no | |
| `source` | `TEXT` | no | `openalex`, `crossref`, `semantic_scholar`, `pubmed`, `plugin:<name>` |
| `observed_at` | `TIMESTAMP` | no | When the value was read from the source |
| `source_as_of` | `TIMESTAMP` | yes | The source's own "as of" date, where it publishes one |
| `job_id` | `ID` | yes | FK → `jobs(id)`; the batch that collected it |

**Constraints.** `ux_item_metrics_observation` unique on `(item_id, metric, source, observed_at)` —
re-running a collection job on the same day with the same source does not double-count.

**Indexes.** `ix_item_metrics_item_metric` (`item_id, metric, observed_at`),
`ix_item_metrics_observed_at`.

**Invariants.**
- M1. Rows are never updated, only inserted. A corrected value is a new observation.
- M2. "Current" is the newest `observed_at` per `(item_id, metric)` from the highest-ranked source.
  There is no `is_current` flag; the query does it, and the analytics export materialises it.
- M3. This table is exempt from soft delete (§1.5): it is derived data and is purged with its item.

---

## 4. Organisation and content

### 4.1 `collections`

**Purpose.** The hierarchical filing structure, plus saved searches. A saved search is a collection
whose membership is a query rather than a list (CONCEPT §5.7, "saved searches as smart collections"),
which keeps the UI, the API, the `.bib` endpoint and the export path identical for both.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `public_id` | `TEXT` | no | Used in `.bib` feed URLs |
| `name` | `TEXT` | no | |
| `name_normalised` | `TEXT` | no | Sibling-uniqueness key |
| `parent_id` | `ID` | yes | FK → `collections(id)` `ON DELETE RESTRICT`. `NULL` for a root |
| `parent_key` | `TEXT` | no | `COALESCE(parent_id, '')` maintained by the application, purely so sibling uniqueness can be a plain unique index — `NULL`s are distinct in both dialects, so a nullable `parent_id` cannot carry the constraint |
| `owner_user_id` | `ID` | no | FK → `users(id)` |
| `kind` | `TEXT` | no | `manual` or `smart`. Closed vocabulary. Default `manual` |
| `query` | `JSON` | yes | Required when `kind = 'smart'`: the saved search in the API's structured query form |
| `query_backend` | `TEXT` | yes | `fts5`, `meilisearch`, `sql` — recorded so a saved search built against one index is not silently reinterpreted by another (ADR-0011) |
| `description` | `TEXT` | yes | |
| `colour` | `TEXT` | yes | `#rrggbb` |
| `depth` | `INTEGER` | no | Root is `0`. Denormalised, maintained on move |
| `position` | `INTEGER` | no | Sort order among siblings. Default `0` |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `trashed_at` | `TIMESTAMP` | yes | |

**Constraints.**
- `ux_collections_public_id` unique.
- `ux_collections_sibling_name` unique on `(owner_user_id, parent_key, name_normalised)`, partial
  `WHERE trashed_at IS NULL`.
- `ck_collections_smart`: `(kind = 'smart') = (query IS NOT NULL)`.
- `ck_collections_depth`: `depth >= 0`.

**Indexes.** `ix_collections_parent` (`parent_id, position`), `ix_collections_owner_live` (partial).

**Invariants.**
- C1. The hierarchy is a forest: no cycles, and `depth = parent.depth + 1`. Cycle prevention is a
  service-layer check on move (walk the ancestor chain), because neither dialect can express it in a
  constraint. Subtree queries use a recursive CTE, which both dialects support; there is no
  materialised path column to fall out of step.
- C2. A `smart` collection has no rows in `collection_items`. Enforced in the service layer and
  asserted by a test.
- C3. Trashing a collection trashes its descendants but never its items. Membership rows are
  captured in the `restore_payload` and removed; restore puts them back.
- C4. Moving a collection rewrites `depth` for the whole subtree in one transaction.

### 4.2 `collection_items`

**Purpose.** Membership of manual collections. An item may be in any number of collections.

| Column | Type | Null | Notes |
|---|---|---|---|
| `collection_id` | `ID` | no | PK part, FK → `collections(id)` `ON DELETE CASCADE` |
| `item_id` | `ID` | no | PK part, FK → `items(id)` `ON DELETE CASCADE` |
| `position` | `INTEGER` | no | Manual ordering within the collection. Default `0` |
| `added_at` | `TIMESTAMP` | no | |
| `added_by_user_id` | `ID` | yes | FK → `users(id)` |
| `source` | `TEXT` | no | `manual`, `rule`, `import`, `connector`, `merge`, `plugin`. Closed vocabulary. Default `manual` |

**Constraints.** PK `(collection_id, item_id)`.

**Indexes.** `ix_collection_items_item_id` — the reverse lookup for the item pane.

**Invariants.** CI1. A merge unions the loser's memberships into the winner's (CONCEPT §5.6); duplicates
collapse into the existing row and the merge record notes which memberships were newly added, so the
union is reversible.

### 4.3 `tags`

**Purpose.** Flat, free-text labels. Distinct from `terms`: a tag is something the user typed, a term
is a controlled vocabulary entry. A tag may be bound to a term so that co-word maps can roll tags up
through a thesaurus (CONCEPT §5.8).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `name` | `TEXT` | no | As typed |
| `name_normalised` | `TEXT` | no | Uniqueness key |
| `colour` | `TEXT` | yes | `#rrggbb` |
| `scheme` | `TEXT` | no | `manual`, `automatic` (added by a rule or resolver — Zotero's tag type 1), `imported`. Closed vocabulary. Default `manual` |
| `term_id` | `ID` | yes | FK → `terms(id)` `ON DELETE SET NULL`. Optional controlled-vocabulary binding |
| `owner_user_id` | `ID` | no | FK → `users(id)` |
| `position` | `INTEGER` | no | Pinned-tag ordering. Default `0` |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `trashed_at` | `TIMESTAMP` | yes | |

**Constraints.** `ux_tags_owner_name` unique on `(owner_user_id, name_normalised)`, partial `WHERE
trashed_at IS NULL`.

**Indexes.** `ix_tags_term_id` (partial), `ix_tags_scheme`.

**Invariants.** TG1. Renaming a tag is an update, not a create-and-remap: assignments follow. TG2.
Merging two tags is a merge like any other and leaves a reversible record in `trash`.

### 4.4 `item_tags`

| Column | Type | Null | Notes |
|---|---|---|---|
| `item_id` | `ID` | no | PK part, FK → `items(id)` `ON DELETE CASCADE` |
| `tag_id` | `ID` | no | PK part, FK → `tags(id)` `ON DELETE CASCADE` |
| `source` | `TEXT` | no | `manual`, `rule`, `resolver`, `import`, `plugin`, `merge`. Closed vocabulary |
| `rule_ref` | `TEXT` | yes | Identifier of the ingestion rule that applied it (CONCEPT §5.3 stage 8), for "why is this tagged" |
| `confidence` | `REAL` | yes | For automatic tags; feeds the confidence gate |
| `added_at` | `TIMESTAMP` | no | |
| `added_by_user_id` | `ID` | yes | FK → `users(id)` |

**Constraints.** PK `(item_id, tag_id)`. **Indexes.** `ix_item_tags_tag_id`.

### 4.5 `annotation_tags`

**Purpose.** Tags on annotations. Zotero supports them and the importer must not drop them; the
screening workflow also tags highlights.

| Column | Type | Null | Notes |
|---|---|---|---|
| `annotation_id` | `ID` | no | PK part, FK → `annotations(id)` `ON DELETE CASCADE` |
| `tag_id` | `ID` | no | PK part, FK → `tags(id)` `ON DELETE CASCADE` |
| `added_at` | `TIMESTAMP` | no | |

**Indexes.** `ix_annotation_tags_tag_id`.

### 4.6 `custom_fields`

**Purpose.** User- and plugin-defined typed fields (CONCEPT §5.2 "CustomField / FieldValue"). The same
mechanism carries Paperless custom fields and systematic-review extraction variables, which is why
CONCEPT §5.10 can say extraction forms are "generated from custom-field schemas".

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `field_key` | `TEXT` | no | Stable slug, used in the API, in exports and as the Parquet column name |
| `name` | `TEXT` | no | Display label |
| `description` | `TEXT` | yes | |
| `data_type` | `TEXT` | no | `text`, `long_text`, `number`, `integer`, `boolean`, `date`, `datetime`, `choice`, `multi_choice`, `json`, `item_reference`, `url`, `monetary`. Closed vocabulary |
| `config` | `JSON` | no | Default `{}`. Type-dependent: `choices`, `min`, `max`, `step`, `unit`, `currency`, `pattern`, `target_item_types` for references |
| `applies_to_item_types` | `JSON` | yes | Array; `NULL` means "any item type" |
| `is_required` | `BOOLEAN` | no | Default `0`. Advisory — enforced by the `completeness` check, not by SQL, because requiredness is per item type |
| `is_repeatable` | `BOOLEAN` | no | Default `0`. When `1`, `field_values.ordinal` may exceed `0` |
| `scope` | `TEXT` | no | `library` or `review`. Closed vocabulary. `review`-scoped fields only appear on extraction forms |
| `plugin_id` | `ID` | yes | FK → `plugins(id)` `ON DELETE RESTRICT`. Set when a plugin declared the field |
| `position` | `INTEGER` | no | Default `0` |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |

**Constraints.** `ux_custom_fields_field_key` unique. `ck_custom_fields_key_shape`: lowercase
`[a-z][a-z0-9_]*`, checked in Zod (a portable regex `CHECK` is not available in SQLite without an
extension).

**Invariants.**
- CF1. `data_type` is immutable once any `field_values` row exists. Changing a field's type is a
  create-plus-migrate operation, never an in-place `ALTER`.
- CF2. Deleting a custom field is refused while values exist; it is disabled instead.

### 4.7 `field_values`

**Purpose.** The values of custom fields. Typed columns rather than a single stringly-typed one, so
that numbers sort, dates range-query and the analytics export can emit a correctly typed Parquet
column without inference. Also the storage for systematic-review extraction, including repeatable
arms and outcomes (CONCEPT §5.10).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `field_id` | `ID` | no | FK → `custom_fields(id)` `ON DELETE RESTRICT` |
| `item_id` | `ID` | no | FK → `items(id)` `ON DELETE CASCADE` |
| `review_id` | `ID` | yes | FK → `reviews(id)` `ON DELETE CASCADE`. Non-null for extraction data (Phase 7) |
| `extraction_form_id` | `ID` | yes | FK → `extraction_forms(id)` `ON DELETE RESTRICT`. Which form instance this value belongs to |
| `group_key` | `TEXT` | yes | The repeatable group instance: `arm:intervention`, `outcome:mortality_30d`. `NULL` for ungrouped values |
| `ordinal` | `INTEGER` | no | Position within a repeatable field. Default `0` |
| `value_text` | `TEXT` | yes | `text`, `long_text`, `choice`, `url` |
| `value_number` | `REAL` | yes | `number`, `monetary` (stored in major units here; `config.currency` names the unit) |
| `value_integer` | `INTEGER` | yes | `integer` |
| `value_boolean` | `BOOLEAN` | yes | `boolean` |
| `value_date` | `TEXT` | yes | `date` (`YYYY-MM-DD`) or `datetime` (ISO-8601 UTC) |
| `value_json` | `JSON` | yes | `json`, `multi_choice` |
| `value_item_id` | `ID` | yes | FK → `items(id)` `ON DELETE RESTRICT`. `item_reference` |
| `is_blank` | `BOOLEAN` | no | Default `0`. `1` records an explicit "not reported" — distinct from "not yet extracted", which is the absence of a row |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `created_by_user_id` | `ID` | yes | FK → `users(id)` |

**Constraints.**
- `ck_field_values_one_value`: exactly one of the six `value_*` columns is non-null, **or** all six
  are null and `is_blank = 1`.
- `ux_field_values_slot` unique on `(field_id, item_id, review_scope_key, form_scope_key,
  group_scope_key, ordinal)`, where the three `*_scope_key` columns are application-maintained
  `COALESCE(x, '')` mirrors of `review_id`, `extraction_form_id` and `group_key` — the same
  `NULL`-in-unique-index workaround as `collections.parent_key`.

**Indexes.** `ix_field_values_item` (`item_id, field_id`), `ix_field_values_field_text`
(`field_id, value_text`, partial `WHERE value_text IS NOT NULL`), `ix_field_values_field_number`
(`field_id, value_number`, partial), `ix_field_values_review` (`review_id, item_id`, partial
`WHERE review_id IS NOT NULL`), `ix_field_values_value_item_id` (partial).

**Invariants.**
- FV1. The populated `value_*` column is determined by `custom_fields.data_type`. Enforced in the
  service layer; a mismatch is a bug that the fixture tests catch.
- FV2. `review_id IS NULL` means library data; `review_id IS NOT NULL` means extraction data for
  that review, so the same item may hold different values of the same field in two reviews without
  collision. This is what lets extraction reuse the library's field machinery instead of a parallel
  one.
- FV3. `ordinal > 0` requires `custom_fields.is_repeatable = 1`.
- FV4. There is no separate "form instance" table: an instance is the tuple
  `(extraction_form_id, review_id, item_id)`, and repeatable structure within it is `group_key`.

### 4.8 `notes`

**Purpose.** Markdown notes, attached to an item or standalone (CONCEPT §5.2). Also the destination for IMAP
message bodies (CONCEPT §5.3) and for Citavi-style quotes and thoughts (CONCEPT §4).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `public_id` | `TEXT` | no | |
| `item_id` | `ID` | yes | FK → `items(id)` `ON DELETE RESTRICT`. `NULL` for a standalone note |
| `parent_annotation_id` | `ID` | yes | FK → `annotations(id)` `ON DELETE SET NULL`. A note written from a highlight keeps the link |
| `owner_user_id` | `ID` | no | FK → `users(id)` |
| `title` | `TEXT` | yes | Derived from the first heading or line; stored so lists need no parsing |
| `content_markdown` | `TEXT` | no | The canonical content |
| `source_format` | `TEXT` | no | `markdown` or `html`. Closed vocabulary. Default `markdown` |
| `content_original` | `TEXT` | yes | The imported HTML when `source_format = 'html'`, kept verbatim so a Zotero note round-trips losslessly (P10) |
| `note_kind` | `TEXT` | no | `note`, `quote`, `thought`, `summary`, `email_body`. Closed vocabulary. Default `note` |
| `version` | `INTEGER` | no | Default `1` |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `trashed_at` | `TIMESTAMP` | yes | |

**Constraints.** `ux_notes_public_id` unique.

**Indexes.** `ix_notes_item_id` (partial `WHERE item_id IS NOT NULL AND trashed_at IS NULL`),
`ix_notes_owner_updated`.

**Invariants.** N1. `content_markdown` is always populated, including for HTML imports (converted on
write) — the search index and the export path read one column. N2. Notes are full-text indexed
(§9).

### 4.9 `annotations`

**Purpose.** Reading annotations as first-class records in the W3C Web Annotation shape (ADR-0009,
ADR-0017). The target is a **document**, not an item, because the annotation belongs to the bytes;
`item_id` records the reading context so the item pane can show them without a join through
`attachments`.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `public_id` | `TEXT` | no | |
| `document_id` | `ID` | no | FK → `documents(id)` `ON DELETE RESTRICT`. The W3C target source |
| `item_id` | `ID` | yes | FK → `items(id)` `ON DELETE RESTRICT`. Reading context |
| `attachment_id` | `ID` | yes | FK → `attachments(id)` `ON DELETE SET NULL`. The route by which it was read |
| `annotation_type` | `TEXT` | no | `highlight`, `underline`, `strikeout`, `note`, `area`, `ink`, `text`. Closed vocabulary |
| `motivation` | `TEXT` | no | W3C motivation: `highlighting`, `commenting`, `describing`, `questioning`, `bookmarking`. Closed vocabulary |
| `selector` | `JSON` | no | The full W3C selector set — `TextQuoteSelector`, `TextPositionSelector`, `FragmentSelector` for the page, rectangles for area annotations, path data for ink. The one place where the model is deliberately document-format-dependent |
| `quoted_text` | `TEXT` | yes | `TextQuoteSelector.exact`, duplicated out of the JSON so it can be full-text indexed |
| `prefix_text` | `TEXT` | yes | `TextQuoteSelector.prefix` |
| `suffix_text` | `TEXT` | yes | `TextQuoteSelector.suffix` |
| `body_text` | `TEXT` | yes | The comment attached to the annotation |
| `body_format` | `TEXT` | no | `markdown` or `text`. Default `markdown` |
| `colour` | `TEXT` | yes | `#rrggbb` |
| `page_index` | `INTEGER` | yes | Zero-based physical page |
| `page_label` | `TEXT` | yes | Printed page label, which is frequently not the physical index |
| `position_sort_key` | `TEXT` | no | Fixed-width, lexicographically sortable reading-order key (page, y, x) — the portable equivalent of Zotero's `sortIndex` |
| `author_user_id` | `ID` | yes | FK → `users(id)`. `NULL` when imported from someone else's annotations |
| `author_name` | `TEXT` | yes | For imported external annotations |
| `is_external` | `BOOLEAN` | no | Default `0`. `1` when extracted from annotations already embedded in the PDF at ingest (the round-trip step ADR-0009 calls out) |
| `external_ref` | `TEXT` | yes | The embedded annotation's identity, so re-extraction does not duplicate |
| `version` | `INTEGER` | no | Default `1` |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `trashed_at` | `TIMESTAMP` | yes | |

**Constraints.**
- `ux_annotations_public_id` unique.
- `ux_annotations_external` unique on `(document_id, external_ref)`, partial `WHERE external_ref IS
  NOT NULL` — re-running the embedded-annotation extractor is idempotent (P9).
- `ck_annotations_body`: `annotation_type <> 'note' OR body_text IS NOT NULL`.

**Indexes.** `ix_annotations_document_sort` (`document_id, position_sort_key`, partial `WHERE
trashed_at IS NULL`) — the reader's primary query; `ix_annotations_item` (partial);
`ix_annotations_author`.

**Invariants.**
- AN1. The underlying document bytes are never modified to store an annotation. Export to embedded
  PDF annotations produces a **new** document with its own hash (ADR-0009, D3).
- AN2. If `item_id` is set, a live `attachments` row exists for `(item_id, document_id)`. Asserted
  on write.
- AN3. Because the target is the document, annotations made while reading through one item are
  visible from every item that shares the file. The reader filters by `item_id` when the user asks
  for "my annotations on this record"; the default is to show all of them, with the origin marked.
- AN4. `selector` always contains at least one selector that can be resolved without the extracted
  text (a page plus rectangles), so an annotation survives a text-layer change.

---

## 5. People, vocabulary and graph

### 5.1 `creators`

**Purpose.** A person or organisation as an entity, with identity resolution state. Distinct from
their appearance on a particular item, which is `item_creators`.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `kind` | `TEXT` | no | `person` or `organisation`. Closed vocabulary |
| `family_name` | `TEXT` | yes | |
| `given_name` | `TEXT` | yes | |
| `name_prefix` | `TEXT` | yes | `van`, `de` where the source separates it |
| `name_suffix` | `TEXT` | yes | `Jr`, `III` |
| `literal_name` | `TEXT` | yes | Single-field name; required for `kind = 'organisation'` and for persons whose name does not split (Zotero field mode 1) |
| `display_name` | `TEXT` | no | Rendered once on write |
| `sort_name` | `TEXT` | no | `family, given` normalised; the blocking key for dedup and the index for browsing |
| `initials` | `TEXT` | yes | bibliometrix `AU` uses the abbreviated form; `AF` uses `display_name` |
| `name_variants` | `JSON` | no | Default `[]`. Array of `{form, source, count}` — the "name forms" of CONCEPT §5.2. JSON because the set is opaque to SQL; the variants are pushed into the search index so they are still findable |
| `orcid` | `TEXT` | yes | Bare 16-digit form with hyphens |
| `openalex_author_id` | `TEXT` | yes | `A…` |
| `semantic_scholar_author_id` | `TEXT` | yes | |
| `scopus_author_id` | `TEXT` | yes | |
| `researcher_id` | `TEXT` | yes | |
| `isni` | `TEXT` | yes | |
| `viaf` | `TEXT` | yes | |
| `ror` | `TEXT` | yes | Organisations |
| `wikidata_id` | `TEXT` | yes | |
| `disambiguation_status` | `TEXT` | no | `unreviewed`, `confirmed`, `ambiguous`, `merged`. Closed vocabulary. Default `unreviewed` |
| `merged_into_creator_id` | `ID` | yes | FK → `creators(id)` |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `trashed_at` | `TIMESTAMP` | yes | |

**Constraints.**
- `ux_creators_orcid` unique on `orcid`, partial `WHERE orcid IS NOT NULL AND trashed_at IS NULL`.
- `ux_creators_openalex` unique on `openalex_author_id`, partial, same predicate.
- `ck_creators_name`: `literal_name IS NOT NULL OR family_name IS NOT NULL`.
- `ck_creators_org`: `kind <> 'organisation' OR literal_name IS NOT NULL`.

**Indexes.** `ix_creators_sort_name` (partial `WHERE trashed_at IS NULL`), `ix_creators_ror`
(partial), `ix_creators_disambiguation` (partial `WHERE disambiguation_status = 'ambiguous'`).

**Invariants.**
- CR1. `disambiguation_status = 'merged'` if and only if `merged_into_creator_id IS NOT NULL`, and
  the row is trashed. `item_creators` rows are re-pointed at the winner; the previous ids sit in the
  merge record.
- CR2. Two creators with different non-null ORCIDs are never merged automatically — the
  `author_consistency` check flags the conflict for the review queue (P3).

### 5.2 `item_creators`

**Purpose.** A creator's appearance on an item, with role, order and the affiliation as printed.
Affiliation lives here, not on `creators`, because it is a property of the publication event; this
is what makes bibliometrix `C1` and institutional collaboration networks possible.

| Column | Type | Null | Notes |
|---|---|---|---|
| `item_id` | `ID` | no | PK part, FK → `items(id)` `ON DELETE CASCADE` |
| `ordinal` | `INTEGER` | no | PK part. Zero-based position in the author list |
| `creator_id` | `ID` | no | FK → `creators(id)` `ON DELETE RESTRICT` |
| `role` | `TEXT` | no | `author`, `editor`, `translator`, `contributor`, `series_editor`, `recipient`, `interviewer`, `director`, `reviewed_author`, `sender`, `correspondent`. Closed vocabulary (extended by a migration, not by plugins) |
| `raw_name` | `TEXT` | yes | Exactly as printed on the item, preserved for BibTeX fidelity and for the `author_consistency` check |
| `affiliation_raw` | `TEXT` | yes | The affiliation string as printed — bibliometrix `C1` |
| `affiliation_ror` | `TEXT` | yes | Resolved institution |
| `affiliation_creator_id` | `ID` | yes | FK → `creators(id)` where the institution has been promoted to an organisation row |
| `country_code` | `TEXT` | yes | ISO-3166-1 alpha-2, for country collaboration maps |
| `is_corresponding` | `BOOLEAN` | no | Default `0` |
| `contribution_roles` | `JSON` | yes | CRediT taxonomy roles when the source supplies them |
| `created_at` | `TIMESTAMP` | no | |

**Constraints.** PK `(item_id, ordinal)`. `ck_item_creators_ordinal`: `ordinal >= 0`.

**Indexes.** `ix_item_creators_creator_id` (`creator_id, item_id`) — "everything by this author";
`ix_item_creators_role` (`item_id, role, ordinal`); `ix_item_creators_ror` (partial).

**Invariants.**
- IC1. `ordinal` is dense from `0` within an item. Reordering rewrites the block in one transaction.
- IC2. The same creator may appear twice on an item with different roles (author and editor of a
  collection). The primary key permits it; the service layer refuses a duplicate
  `(creator_id, role)`.
- IC3. First-author queries — which the record deduplicator and the citation key formula both need —
  are `role = 'author' AND ordinal = 0`.

### 5.3 `terms`

**Purpose.** The controlled vocabulary layer of CONCEPT §5.2: author keywords, MeSH, OpenAlex topics, tags
promoted to terms, and custom schemes. Hierarchy and thesaurus mapping live here so that co-word
maps can roll up (CONCEPT §5.8).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `scheme` | `TEXT` | no | `author_keyword`, `mesh`, `mesh_qualifier`, `tag`, `openalex_topic`, `openalex_concept`, `openalex_field`, `custom`. Open vocabulary — plugins may register schemes |
| `code` | `TEXT` | yes | Scheme-native identifier: MeSH descriptor UI `D000001`, OpenAlex `T10123` |
| `label` | `TEXT` | no | Preferred label |
| `normalised_label` | `TEXT` | no | Uniqueness and matching key |
| `parent_id` | `ID` | yes | FK → `terms(id)`. Broader term |
| `preferred_term_id` | `ID` | yes | FK → `terms(id)`. When set, this term is a non-preferred synonym and roll-ups substitute the target. This is the thesaurus map of CONCEPT §5.2 |
| `tree_numbers` | `JSON` | yes | Array of MeSH tree numbers; a term sits in several places in the tree, so this cannot be a column |
| `depth` | `INTEGER` | yes | |
| `external_uri` | `TEXT` | yes | |
| `scope_note` | `TEXT` | yes | |
| `is_active` | `BOOLEAN` | no | Default `1`. MeSH retires descriptors; retired terms stay for historical items |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |

**Constraints.**
- `ux_terms_scheme_code` unique on `(scheme, code)`, partial `WHERE code IS NOT NULL`.
- `ux_terms_scheme_label` unique on `(scheme, normalised_label)`.
- `ck_terms_preferred_not_self`: `preferred_term_id IS NULL OR preferred_term_id <> id`.

**Indexes.** `ix_terms_parent_id`, `ix_terms_preferred_term_id` (partial),
`ix_terms_normalised_label`.

**Invariants.**
- TM1. `preferred_term_id` chains are resolved to a fixed point at write time; a cycle is refused.
- TM2. A roll-up substitutes `preferred_term_id` and, when the map says so, an ancestor at a
  configured tree depth. The substitution is applied when a network is built, never destructively to
  `item_terms`.

### 5.4 `item_terms`

| Column | Type | Null | Notes |
|---|---|---|---|
| `item_id` | `ID` | no | PK part, FK → `items(id)` `ON DELETE CASCADE` |
| `term_id` | `ID` | no | PK part, FK → `terms(id)` `ON DELETE RESTRICT` |
| `source` | `TEXT` | no | `author`, `indexer` (MeSH from PubMed), `openalex`, `extracted` (from text), `manual`, `plugin:<name>`. Closed vocabulary plus the plugin form |
| `weight` | `REAL` | yes | Source-supplied relevance (OpenAlex topic score) |
| `position` | `INTEGER` | yes | Order as listed on the item — author keyword order carries meaning |
| `is_major_topic` | `BOOLEAN` | no | Default `0`. MeSH major topic marker |
| `qualifier_term_id` | `ID` | yes | FK → `terms(id)` with `scheme = 'mesh_qualifier'` — the MeSH subheading |
| `confidence` | `REAL` | yes | |
| `added_at` | `TIMESTAMP` | no | |

**Constraints.** PK `(item_id, term_id)`. A term with two different qualifiers on one item is two
rows, so the PK becomes `(item_id, term_id, qualifier_key)` where `qualifier_key` is the
application-maintained `COALESCE(qualifier_term_id, '')`.

**Indexes.** `ix_item_terms_term_id` (`term_id, item_id`) — the co-word projection reads this;
`ix_item_terms_source`.

### 5.5 `shadow_works`

**Purpose.** External work stubs discovered in reference lists or during a deep dive (CONCEPT §5.8). They
exist so the graph can be complete without the library filling up with records the user never chose.
They are promotable to items and never appear in library queries.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `source` | `TEXT` | no | `openalex`, `crossref`, `semantic_scholar`, `pubmed`, `arxiv`, `datacite`, `grobid`, `anystyle`, `manual` |
| `source_id` | `TEXT` | no | The identifier in that source |
| `doi` | `TEXT` | yes | Normalised as in B1 |
| `pmid` | `TEXT` | yes | |
| `arxiv_id` | `TEXT` | yes | |
| `openalex_id` | `TEXT` | yes | |
| `title` | `TEXT` | yes | |
| `normalised_title` | `TEXT` | yes | Fuzzy-match key |
| `container_title` | `TEXT` | yes | |
| `issued_year` | `INTEGER` | yes | |
| `first_author_family` | `TEXT` | yes | Blocking key |
| `authors` | `JSON` | no | Default `[]`. Array of `{family, given, orcid, position}` — not normalised into `creators`, deliberately: a shadow work is a stub, and materialising thousands of external authors as first-class creators is exactly the library pollution this table prevents |
| `raw_record` | `JSON` | yes | The upstream payload, so promotion needs no re-fetch |
| `raw_reference_string` | `TEXT` | yes | The unparsed reference as it appeared, when the origin was a PDF reference list |
| `cited_by_count` | `INTEGER` | yes | |
| `discovered_via` | `TEXT` | no | `reference_list`, `cited_by`, `deep_dive`, `search`, `import`. Closed vocabulary |
| `discovered_from_item_id` | `ID` | yes | FK → `items(id)`. The seed |
| `discovered_in_job_id` | `ID` | yes | FK → `jobs(id)` |
| `first_seen_at` | `TIMESTAMP` | no | |
| `last_seen_at` | `TIMESTAMP` | no | |
| `seen_count` | `INTEGER` | no | Default `1`. How often it turned up — the ranking signal for "what should I read next" |
| `promotion_status` | `TEXT` | no | `none`, `queued`, `promoted`, `rejected`. Closed vocabulary. Default `none` |
| `promoted_item_id` | `ID` | yes | FK → `items(id)` |
| `promoted_at` | `TIMESTAMP` | yes | |
| `matched_item_id` | `ID` | yes | FK → `items(id)`. Set when the stub turns out to describe an item already in the library — the local citation network depends on this link |

**Constraints.**
- `ux_shadow_works_source` unique on `(source, source_id)`.
- `ux_shadow_works_doi` unique on `doi`, partial `WHERE doi IS NOT NULL`.
- `ck_shadow_works_promotion`: `(promotion_status = 'promoted') = (promoted_item_id IS NOT NULL)`.

**Indexes.** `ix_shadow_works_match` (`normalised_title, issued_year`), `ix_shadow_works_matched_item`
(partial), `ix_shadow_works_seen_count`, `ix_shadow_works_discovered_from` (partial).

**Invariants.**
- SW1. Shadow works never appear in item endpoints, exports, `.bib` feeds or counts. They are a
  separate resource with a separate scope.
- SW2. Promotion creates an item, copies the metadata through the normal resolver merge (so it gets
  `field_provenance` rows), sets `promoted_item_id` and `items.promoted_from_shadow_work_id`, and
  re-points the graph node from the shadow work to the item in the same transaction.
- SW3. `matched_item_id` is set by the same matcher the record deduplicator uses (CONCEPT §5.6), so "which
  library items cite which" is a join over `graph_edges` and `matched_item_id`.

### 5.6 `graph_nodes`

**Purpose.** The vertex set of the bibliometric graph. A node is either a projection of a local
entity or an external identity that has no local table (a venue, an institution, a funder).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `node_type` | `TEXT` | no | `item`, `shadow_work`, `creator`, `venue`, `term`, `institution`, `funder`. Closed vocabulary |
| `item_id` | `ID` | yes | FK → `items(id)` `ON DELETE CASCADE` |
| `shadow_work_id` | `ID` | yes | FK → `shadow_works(id)` `ON DELETE CASCADE` |
| `creator_id` | `ID` | yes | FK → `creators(id)` `ON DELETE CASCADE` |
| `term_id` | `ID` | yes | FK → `terms(id)` `ON DELETE CASCADE` |
| `external_scheme` | `TEXT` | yes | `issn_l`, `ror`, `openalex`, `doi`, `fundref` — the identity scheme for node types with no local table |
| `external_id` | `TEXT` | yes | |
| `label` | `TEXT` | no | Display label, denormalised so a map renders without joining four tables |
| `external_ids` | `JSON` | no | Default `{}`. Everything else known about the node's identity |
| `first_seen_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |

**Constraints.**
- `ck_graph_nodes_ref`: exactly one of `item_id`, `shadow_work_id`, `creator_id`, `term_id`,
  `(external_scheme, external_id)` is populated, and it agrees with `node_type` — `item` ⇒ `item_id`,
  `venue`/`institution`/`funder` ⇒ the external pair.
- `ux_graph_nodes_item` unique on `item_id`, partial `WHERE item_id IS NOT NULL`; likewise
  `ux_graph_nodes_shadow_work`, `ux_graph_nodes_creator`, `ux_graph_nodes_term`.
- `ux_graph_nodes_external` unique on `(node_type, external_scheme, external_id)`, partial `WHERE
  external_id IS NOT NULL`.

**Indexes.** `ix_graph_nodes_type_label` (`node_type, label`).

**Invariants.**
- GN1. One node per underlying entity. Promotion of a shadow work (SW2) rewrites the node in place —
  `shadow_work_id` is cleared, `item_id` set, `node_type` changed — so no edge has to be rewritten.
  This is the reason edges reference nodes and not entities directly.
- GN2. Nodes are derived. They are rebuilt from scratch by a maintenance job and are not soft-deleted.

### 5.7 `graph_edges`

**Purpose.** The edge set: asserted relations (a citation) and derived projections (co-citation,
coupling, co-word, co-authorship). Every edge carries the provenance P4 requires, which is what makes
the coverage statistics beside every map (CONCEPT §5.8) possible.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `edge_type` | `TEXT` | no | Core vocabulary: `cites`, `co_cited`, `coupled`, `co_occurs`, `co_author`, `same_as`, `version_of`. **Open**: the `graphEdgeProvider` hook may register more, so there is no DB `CHECK` |
| `source_node_id` | `ID` | no | FK → `graph_nodes(id)` `ON DELETE CASCADE` |
| `target_node_id` | `ID` | no | FK → `graph_nodes(id)` `ON DELETE CASCADE` |
| `directed` | `BOOLEAN` | no | `1` for `cites` and `version_of`; `0` for the co-* family and `same_as` |
| `weight` | `REAL` | no | Default `1`. Raw count for derived edges |
| `normalised_weight` | `REAL` | yes | After the similarity measure |
| `normalisation` | `TEXT` | yes | `none`, `association_strength`, `salton`, `jaccard`, `fractional`, `inclusion`. Closed vocabulary |
| `occurrences` | `INTEGER` | yes | Co-occurrence count before normalisation |
| `scheme` | `TEXT` | yes | For `co_occurs`: which vocabulary scheme the projection used |
| `provenance_source` | `TEXT` | no | `openalex`, `crossref`, `semantic_scholar`, `pubmed`, `grobid`, `manual`, `derived`, `plugin:<name>` |
| `provenance_fetched_at` | `TIMESTAMP` | no | When the underlying fact was obtained |
| `confidence` | `REAL` | yes | `CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))` |
| `derivation` | `TEXT` | no | `asserted` or `derived`. Closed vocabulary |
| `run_id` | `ID` | yes | FK → `jobs(id)` `ON DELETE CASCADE`. The projection run that produced a derived edge |
| `params_digest` | `TEXT` | yes | Hash of the projection parameters, so two maps built with different thresholds coexist |
| `created_at` | `TIMESTAMP` | no | |

**Constraints.**
- `ux_graph_edges_identity` unique on `(edge_type, source_node_id, target_node_id,
  provenance_source, scheme_key, run_key)`, where the two `*_key` columns are the maintained
  `COALESCE(x, '')` mirrors.
- `ck_graph_edges_no_self`: `source_node_id <> target_node_id`.
- `ck_graph_edges_derived_run`: `derivation <> 'derived' OR run_id IS NOT NULL`.

**Indexes.** `ix_graph_edges_source` (`source_node_id, edge_type`), `ix_graph_edges_target`
(`target_node_id, edge_type`), `ix_graph_edges_type_run` (`edge_type, run_id`),
`ix_graph_edges_asserted` (partial `WHERE derivation = 'asserted'`).

**Invariants.**
- GE1. **Undirected canonical order.** When `directed = 0`, `source_node_id < target_node_id` as
  strings. Every writer applies the swap. Without it, a co-citation edge exists twice and every
  count is wrong.
- GE2. `derivation = 'derived'` rows belong to a run and are replaced wholesale: a new projection
  inserts a new `run_id` and the previous run's edges are hard-deleted once the new run commits.
  P5 does not apply — these are recomputable (§1.5).
- GE3. `derivation = 'asserted'` rows (citations from an API or a PDF reference list) are kept per
  source. The same citation reported by OpenAlex and by GROBID is two rows, not one, and coverage
  statistics count sources — this is deliberate and is what CONCEPT §5.8's "how many items had reference
  data, from which sources, fetched when" reads.
- GE4. A `cites` edge may point at a `shadow_work` node. That is the normal case: most cited works
  are not in the library.
- GE5. `same_as` edges are how two nodes that turn out to be one work are linked before, or instead
  of, a destructive merge.

### 5.8 `edge_evidence`

**Purpose.** The `evidence` property CONCEPT §5.2 gives `GraphEdge`, as a child table because one citation
can be supported by several in-text contexts. This is the storage for CONCEPT §5.8's citation contexts and
the SciCite intent classification.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `edge_id` | `ID` | no | FK → `graph_edges(id)` `ON DELETE CASCADE` |
| `kind` | `TEXT` | no | `citation_context`, `reference_string`, `api_record`. Closed vocabulary |
| `document_id` | `ID` | yes | FK → `documents(id)` `ON DELETE SET NULL`. The PDF the context was read from |
| `page_index` | `INTEGER` | yes | |
| `char_start` | `INTEGER` | yes | Offset into the extracted text |
| `char_end` | `INTEGER` | yes | |
| `section` | `TEXT` | yes | `introduction`, `methods`, `results`, `discussion`, … as GROBID reports it |
| `text_excerpt` | `TEXT` | yes | The surrounding sentences |
| `intent` | `TEXT` | yes | `background`, `method`, `result`. The SciCite classification |
| `intent_confidence` | `REAL` | yes | |
| `model` | `TEXT` | yes | Classifier name and version, so a reclassification can be scoped |
| `extracted_at` | `TIMESTAMP` | no | |

**Indexes.** `ix_edge_evidence_edge_id`, `ix_edge_evidence_intent` (partial `WHERE intent IS NOT
NULL`), `ix_edge_evidence_document_id` (partial).

**Invariants.** EV1. Evidence rows are full-text indexed, which is what makes "how does my corpus
cite X" a search rather than a scan. EV2. Reclassifying with a new model inserts new rows scoped by
`model`; the previous classification is not overwritten.

---

## 6. Operations

### 6.1 `review_queue`

**Purpose.** P3, "flag, never guess". Every ambiguous ingestion, dedup, enrichment or check outcome
becomes a row here with a machine-readable reason, a proposed action and a human-readable
explanation. Named `review_queue` and never `reviews` — the systematic-review table owns that name.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `subject_type` | `TEXT` | no | `document`, `item`, `attachment`, `creator`, `shadow_work`, `merge_candidate`, `ingest_batch`, `check_result`, `enrichment`, `job`. Closed vocabulary |
| `subject_id` | `TEXT` | no | Polymorphic; no SQL foreign key |
| `secondary_subject_type` | `TEXT` | yes | The other side of a pairwise decision (a merge candidate) |
| `secondary_subject_id` | `TEXT` | yes | |
| `reason_code` | `TEXT` | no | `low_confidence_metadata`, `near_duplicate_file`, `record_merge_candidate`, `no_identifier_match`, `ocr_failed`, `rule_conflict`, `resolver_disagreement`, `missing_file`, `hash_mismatch`, … Open vocabulary |
| `explanation` | `TEXT` | no | The human-readable sentence CONCEPT §5.5 requires. Not generated at render time — stored, so the reason a decision was queued in 2026 still reads correctly in 2029 |
| `proposed_action` | `TEXT` | yes | `merge`, `link`, `create_item`, `set_fields`, `discard`, `retry`, `none` |
| `proposed_payload` | `JSON` | yes | Exactly the request body that "accept" will execute |
| `confidence` | `REAL` | yes | The score that failed the gate |
| `severity` | `TEXT` | no | `info`, `warning`, `blocker`. Closed vocabulary. Default `warning` |
| `status` | `TEXT` | no | `open`, `accepted`, `rejected`, `deferred`, `superseded`. Closed vocabulary. Default `open` |
| `dedupe_key` | `TEXT` | no | Deterministic digest of `(subject, secondary_subject, reason_code)`; see the constraint |
| `source_stage` | `TEXT` | yes | Which pipeline stage raised it (`ingest.6`, `dedup.record`, `check.doi_resolves`) |
| `job_id` | `ID` | yes | FK → `jobs(id)` `ON DELETE SET NULL` |
| `plugin_id` | `ID` | yes | FK → `plugins(id)` `ON DELETE SET NULL` |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `resolved_at` | `TIMESTAMP` | yes | |
| `resolved_by_user_id` | `ID` | yes | FK → `users(id)` |
| `resolution_note` | `TEXT` | yes | |
| `resolution_payload` | `JSON` | yes | What was actually executed, which may differ from the proposal |

**Constraints.** `ux_review_queue_open` unique on `dedupe_key`, partial `WHERE status = 'open'`.
Re-running an idempotent import does not produce a second open entry for the same problem (P9).

**Indexes.** `ix_review_queue_open` (`severity, created_at`, partial `WHERE status = 'open'`),
`ix_review_queue_subject` (`subject_type, subject_id`), `ix_review_queue_reason`.

**Invariants.**
- RQ1. Accepting an entry executes `proposed_payload` through the normal API path, so the action is
  audited like any other write. The queue never has a private mutation route.
- RQ2. `superseded` is set when a later run resolves the situation without a human — for example the
  missing file reappears. Superseding is recorded, not silent.

### 6.2 `check_results`

**Purpose.** The output of the verification engine (CONCEPT §5.5), stored with a timestamp so that a
report can be exported and so that "this was clean last month" is answerable. Also the storage for
bibliography audit mode, where the subject is a parsed reference that is not in the library.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `check_id` | `TEXT` | no | `completeness`, `identifier_syntax`, `doi_resolves`, `existence`, `retraction`, `preprint_published`, `version_duplicate`, `author_consistency`, `venue_issn`, `plausibility`, `oa_status`, `citation_key`, `attachment_integrity`. Open vocabulary — the `check` hook adds more |
| `check_version` | `TEXT` | yes | So a rule change can be told from a data change |
| `subject_type` | `TEXT` | no | `item`, `attachment`, `document`, `creator`, `audit_reference`. Closed vocabulary |
| `subject_id` | `TEXT` | no | For `audit_reference`, an id within an audit run rather than a library row |
| `item_id` | `ID` | yes | FK → `items(id)` `ON DELETE CASCADE`. Denormalised for the common case, so a report filters without a polymorphic join |
| `status` | `TEXT` | no | `pass`, `fail`, `warn`, `error`, `skipped`. Closed vocabulary |
| `severity` | `TEXT` | no | `info`, `warning`, `error`. Closed vocabulary |
| `message` | `TEXT` | no | Human-readable explanation |
| `detail` | `JSON` | no | Default `{}`. Structured evidence: what was compared, what the source said |
| `auto_fixable` | `BOOLEAN` | no | Default `0` |
| `auto_fix_payload` | `JSON` | yes | |
| `fixed_at` | `TIMESTAMP` | yes | |
| `acknowledged_at` | `TIMESTAMP` | yes | A user may accept a `fail` as expected |
| `acknowledged_by_user_id` | `ID` | yes | FK → `users(id)` |
| `run_id` | `ID` | yes | FK → `jobs(id)` `ON DELETE SET NULL` |
| `audit_run_id` | `ID` | yes | Groups the results of one bibliography audit (CONCEPT §5.5) |
| `checked_at` | `TIMESTAMP` | no | |

**Constraints.** `ux_check_results_current` unique on `(check_id, subject_type, subject_id,
run_scope_key)` where `run_scope_key` is the maintained `COALESCE(audit_run_id, '')` — one current
result per check per subject per audit run; the library-wide scope uses the empty string and is
overwritten on each run.

**Indexes.** `ix_check_results_item` (`item_id, check_id`, partial), `ix_check_results_open`
(`severity, checked_at`, partial `WHERE status IN ('fail','warn') AND acknowledged_at IS NULL AND
fixed_at IS NULL`), `ix_check_results_audit_run` (partial).

**Invariants.** CK1. A check that finds nothing writes a `pass` row; absence of a row means "not
checked", which is a different statement and one the report has to make. CK2. A `fail` that a user
cannot act on becomes a `review_queue` entry only when there is a proposed action; otherwise it stays
a check result.

### 6.3 `jobs`

**Purpose.** The persistent queue of ADR-0010, and the record of every long-running operation. P9
lives here: an import, an enrichment sweep or a dedup run can be re-run safely because of
`idempotency_key`, and can be resumed because of `cursor`.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `job_type` | `TEXT` | no | `ingest.file`, `import.zotero`, `enrich.batch`, `check.run`, `dedup.records`, `graph.expand`, `graph.project`, `analytics.export`, `backup`, `plugin.<name>`, … Open vocabulary |
| `idempotency_key` | `TEXT` | yes | See the constraint and IK1–IK4 below |
| `params` | `JSON` | no | Default `{}`. The complete input; a job is re-runnable from this alone |
| `state` | `TEXT` | no | `queued`, `running`, `succeeded`, `failed`, `cancelled`, `waiting_review`, `dead`. Closed vocabulary. Default `queued` |
| `priority` | `INTEGER` | no | Higher runs first. Default `0` |
| `run_after` | `TIMESTAMP` | no | Scheduling and backoff. Default = creation time |
| `started_at` | `TIMESTAMP` | yes | |
| `finished_at` | `TIMESTAMP` | yes | |
| `heartbeat_at` | `TIMESTAMP` | yes | |
| `lease_expires_at` | `TIMESTAMP` | yes | A crashed worker's job returns to `queued` when its lease lapses |
| `worker_id` | `TEXT` | yes | Process identity |
| `attempts` | `INTEGER` | no | Default `0` |
| `max_attempts` | `INTEGER` | no | Default `5` |
| `progress_done` | `INTEGER` | no | Default `0` |
| `progress_total` | `INTEGER` | yes | `NULL` when not known in advance |
| `cursor` | `JSON` | yes | The resume point: last processed id, last page token, last offset. Written at every checkpoint |
| `result` | `JSON` | yes | Summary the API returns and the report renders |
| `error_code` | `TEXT` | yes | |
| `error_message` | `TEXT` | yes | |
| `error_detail` | `JSON` | yes | |
| `parent_job_id` | `ID` | yes | FK → `jobs(id)` `ON DELETE SET NULL` |
| `root_job_id` | `ID` | yes | FK → `jobs(id)`. Denormalised so a whole tree is one indexed query |
| `batch_id` | `TEXT` | yes | Groups jobs submitted by one bulk API call |
| `created_by_user_id` | `ID` | yes | FK → `users(id)` |
| `created_by_token_id` | `ID` | yes | FK → `api_tokens(id)` |
| `plugin_id` | `ID` | yes | FK → `plugins(id)` `ON DELETE SET NULL` |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |

**Constraints.**
- `ux_jobs_idempotency_key` unique on `idempotency_key`, partial `WHERE idempotency_key IS NOT NULL`.
  Global, not scoped by `job_type`, because the key is constructed to be self-describing.
- `ck_jobs_attempts`: `attempts >= 0 AND attempts <= max_attempts`.

**Indexes.** `ix_jobs_claim` (`state, priority, run_after`, partial `WHERE state = 'queued'`) — the
only index the claim query needs; `ix_jobs_state_updated`; `ix_jobs_root` (partial);
`ix_jobs_type_created` (`job_type, created_at`).

**Invariants (idempotency, P9).**
- IK1. **Key construction.** An internal job builds its key from the work it does, not from when it
  was asked: `ingest.file:<sha256>:<source_kind>:<source_ref>`,
  `enrich.item:<item_id>:<resolver>:<yyyy-mm-dd>`, `import.zotero:<library_hash>:<run_label>`,
  `graph.project:<projection>:<params_digest>`. Two identical requests collide on the unique index.
- IK2. **Client keys.** Bulk API endpoints accept an `Idempotency-Key` header; the server stores it
  as `api:<token_id>:<header value>`. A repeat with the same key returns the original job — including
  its `result` — rather than enqueuing a second one. This is what makes a retried mobile upload or a
  flaky CLI run safe.
- IK3. **Re-runs are explicit.** A job whose key already exists and which the caller genuinely wants
  to run again is submitted with `force = true`, which appends a run counter to the key. Nothing is
  ever silently duplicated and nothing is ever silently skipped.
- IK4. **Resumability.** Every job type writes `cursor` at a checkpoint boundary and, on restart,
  begins from it. Re-processing a checkpoint's worth of work must be harmless — which it is, because
  every write the pipeline makes is itself keyed (document by hash, item by `(source_system,
  source_id)`, queue entry by `dedupe_key`).
- IK5. **Claim protocol.** A worker claims with a single statement:
  `UPDATE jobs SET state='running', worker_id=?, started_at=?, lease_expires_at=?, attempts=attempts+1
   WHERE id = (SELECT id FROM jobs WHERE state='queued' AND run_after<=? ORDER BY priority DESC,
   run_after ASC LIMIT 1) RETURNING *`. Both dialects support this; SQLite's single-writer model
  makes it atomic, Postgres needs `FOR UPDATE SKIP LOCKED` in the subselect, which is the second and
  last dialect-specific fragment in the schema.
- IK6. A job in `waiting_review` has produced `review_queue` entries and will not proceed until they
  are resolved; it is not a failure.

### 6.4 `job_logs`

**Purpose.** The `log` property CONCEPT §5.2 gives `Job`, as a child table because an import writes
thousands of lines and a JSON column would be rewritten on every append.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK; ULID, so `ORDER BY id` is append order |
| `job_id` | `ID` | no | FK → `jobs(id)` `ON DELETE CASCADE` |
| `logged_at` | `TIMESTAMP` | no | |
| `level` | `TEXT` | no | `debug`, `info`, `warn`, `error`. Closed vocabulary |
| `message` | `TEXT` | no | |
| `data` | `JSON` | yes | Structured context |
| `subject_type` | `TEXT` | yes | Lets a report answer "what happened to this file during the import" |
| `subject_id` | `TEXT` | yes | |

**Indexes.** `ix_job_logs_job` (`job_id, id`), `ix_job_logs_subject` (partial `WHERE subject_id IS
NOT NULL`).

**Invariants.** JL1. Append-only. JL2. `debug` rows are pruned by retention policy; `info` and above
are kept as long as the job row is. This is the one place where data is removed on a timer, and it
is not audited data.

### 6.5 `audit_log`

**Purpose.** P5's append-only record of who did what. Every write through the API — including writes
made by MCP tools and by plugins — lands here.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK; ULID, monotonic, so `(occurred_at, id)` is a total order |
| `occurred_at` | `TIMESTAMP` | no | |
| `actor_type` | `TEXT` | no | `user`, `token`, `system`, `plugin`, `job`, `mcp`, `import`. Closed vocabulary |
| `actor_user_id` | `ID` | yes | FK → `users(id)` `ON DELETE RESTRICT` |
| `actor_token_id` | `ID` | yes | FK → `api_tokens(id)` `ON DELETE RESTRICT` |
| `actor_plugin_id` | `ID` | yes | FK → `plugins(id)` `ON DELETE RESTRICT` |
| `actor_job_id` | `ID` | yes | FK → `jobs(id)` `ON DELETE RESTRICT` |
| `action` | `TEXT` | no | Dotted verb: `item.created`, `item.updated`, `item.merged`, `item.trashed`, `item.restored`, `document.ingested`, `attachment.added`, `annotation.created`, `check.completed`, `field.locked`, `screening.decided`, `token.revoked`, `plugin.enabled` |
| `entity_type` | `TEXT` | no | |
| `entity_id` | `TEXT` | no | |
| `before` | `JSON` | yes | The changed fields only, not the whole row |
| `after` | `JSON` | yes | |
| `reason` | `TEXT` | yes | Free text, or a reason code from a queue resolution |
| `request_id` | `TEXT` | yes | Correlates every row written by one HTTP request |
| `api_route` | `TEXT` | yes | |
| `ip_address` | `TEXT` | yes | |
| `user_agent` | `TEXT` | yes | |

**Indexes.** `ix_audit_log_entity` (`entity_type, entity_id, occurred_at`),
`ix_audit_log_occurred_at`, `ix_audit_log_actor_user` (partial), `ix_audit_log_request`
(partial `WHERE request_id IS NOT NULL`), `ix_audit_log_action`.

**Invariants.**
- AL1. Insert-only. No `UPDATE`, no `DELETE`, no retention policy. Enforced by the service layer and,
  in both dialects, by a rejecting trigger — the trigger body is the third and last dialect-specific
  fragment (`RAISE(ABORT, …)` in SQLite, a `RAISE EXCEPTION` function in Postgres).
- AL2. Exactly one `actor_*` column is populated, and it agrees with `actor_type`.
- AL3. MCP writes are indistinguishable in privilege from any other token write and distinguishable
  in the record by `actor_type = 'mcp'` (CONCEPT §5.12).
- AL4. `before`/`after` hold the delta, not the document. A full snapshot is reconstructed by
  replaying, or read from `trash.restore_payload` for a trashed entity.
- AL5. The audit log is exported by `recueil backup` and is part of the restore test.

### 6.6 `trash`

**Purpose.** P5's "never delete": the restore record for every soft-deleted entity, and the
reversible merge record the record deduplicator writes (CONCEPT §5.6, the Argus One behaviour).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `entity_type` | `TEXT` | no | `item`, `document`, `attachment`, `collection`, `note`, `annotation`, `tag`, `creator`, `review`, `curated_network`. Closed vocabulary |
| `entity_id` | `TEXT` | no | Polymorphic; no SQL foreign key |
| `group_id` | `ID` | yes | Groups the rows written by one cascading trash operation, so restore puts back exactly what was removed together |
| `trashed_at` | `TIMESTAMP` | no | |
| `trashed_by_user_id` | `ID` | yes | FK → `users(id)` |
| `reason` | `TEXT` | no | `user`, `merge`, `import_rollback`, `cascade`, `plugin`. Closed vocabulary |
| `reason_detail` | `TEXT` | yes | |
| `restore_payload` | `JSON` | no | Everything needed to undo: detached collection memberships, tag assignments, previous `attachments.item_id` values, the parent id of a moved collection |
| `merge_target_item_id` | `ID` | yes | FK → `items(id)`. Set when `reason = 'merge'`; the winner |
| `merge_record` | `JSON` | yes | Field-by-field account of what the winner took from the loser, so the merge is reversible field by field, not only wholesale |
| `expires_at` | `TIMESTAMP` | yes | Auto-purge horizon. `NULL` by default — nothing expires unless the operator configures it |
| `restored_at` | `TIMESTAMP` | yes | |
| `restored_by_user_id` | `ID` | yes | FK → `users(id)` |
| `purged_at` | `TIMESTAMP` | yes | Hard deletion, only ever on an explicit request |
| `purged_by_user_id` | `ID` | yes | FK → `users(id)` |

**Constraints.**
- `ux_trash_open` unique on `(entity_type, entity_id)`, partial `WHERE restored_at IS NULL AND
  purged_at IS NULL`. One open trash record per entity — the other half of invariant T1.
- `ck_trash_merge`: `reason <> 'merge' OR merge_target_item_id IS NOT NULL`.

**Indexes.** `ix_trash_open` (`trashed_at`, partial as above), `ix_trash_group` (partial),
`ix_trash_merge_target` (partial), `ix_trash_expires` (partial `WHERE expires_at IS NOT NULL AND
purged_at IS NULL`).

**Invariants (soft delete, P5).**
- TR1. See T1 in §1.5: `trashed_at` on the entity and an open row here are written and cleared in the
  same transaction.
- TR2. Purging is the only operation that removes data, is never automatic without configuration, is
  refused while a restore would still be meaningful (a merge loser cannot be purged while the winner
  exists unless the merge is first confirmed), and writes an `audit_log` row that survives it.
- TR3. Trashing a document is refused while any live attachment references it (D4).
- TR4. A restore is a normal write: it re-runs the inverse of `restore_payload` through the service
  layer, bumps `version`, and is audited.

### 6.7 `plugins`

**Purpose.** Installed plugins, their manifests and their settings (CONCEPT §5.13, ADR-0012). The
row exists so that data created by a plugin — custom fields, jobs, edges, queue entries — keeps a
resolvable owner after the plugin is disabled.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `name` | `TEXT` | no | npm package name, e.g. `@recueil/resolver-openalex` |
| `version` | `TEXT` | no | Installed semver |
| `plugin_api_range` | `TEXT` | no | The declared compatible plugin-API range, copied out of the manifest for a cheap compatibility query |
| `source` | `TEXT` | no | `builtin`, `npm`, `url`, `local`. Closed vocabulary |
| `source_ref` | `TEXT` | yes | Registry entry, tarball URL or path |
| `checksum` | `TEXT` | yes | SHA-256 of the installed artefact |
| `manifest` | `JSON` | no | The verbatim `recueil.plugin.json` |
| `permissions` | `JSON` | no | Default `[]`. Declared permissions. Recorded and displayed but not enforced by isolation in v1 (ADR-0012) |
| `hooks` | `JSON` | no | Default `[]`. Hook names implemented, denormalised from the manifest so the host can build its dispatch table without parsing every manifest |
| `settings` | `JSON` | no | Default `{}`. Validated against the manifest's settings schema |
| `enabled` | `BOOLEAN` | no | Default `0`. A plugin is installed and then enabled — never enabled by installation |
| `install_state` | `TEXT` | no | `installed`, `pending_update`, `failed`, `incompatible`. Closed vocabulary |
| `last_error` | `TEXT` | yes | |
| `installed_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |

**Constraints.** `ux_plugins_name` unique.

**Invariants.**
- PL1. A plugin row is never deleted while any row references it (`custom_fields.plugin_id`,
  `jobs.plugin_id`, `review_queue.plugin_id`, `audit_log.actor_plugin_id`). Uninstalling sets
  `enabled = 0` and `install_state = 'failed'` at worst.
- PL2. Secrets (API keys for resolvers) do **not** live in `settings`. They are environment
  references — `settings` holds the name of the variable, the value comes from the environment
  (CONCEPT §5.15).

---

## 7. Curated networks — Phase 6

Specified now, built in Phase 6. CONCEPT §5.9 defines a CuratedNetwork as a versioned JSON document
whose nodes reference item ids so that metadata updates propagate. The relational part is therefore
thin on purpose: identity, ownership and version history are rows; the network itself is a document.

### 7.1 `curated_networks`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `public_id` | `TEXT` | no | |
| `name` | `TEXT` | no | |
| `description` | `TEXT` | yes | |
| `owner_user_id` | `ID` | no | FK → `users(id)` |
| `review_id` | `ID` | yes | FK → `reviews(id)` `ON DELETE SET NULL`. A PRISMA or citation figure belonging to a review |
| `current_version_id` | `ID` | yes | FK → `curated_network_versions(id)` `ON DELETE SET NULL`. The head |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `trashed_at` | `TIMESTAMP` | yes | |

**Constraints.** `ux_curated_networks_public_id` unique. The `current_version_id` foreign key is
deferred in Postgres and created after both tables exist in SQLite — a mutual reference, resolved by
creating the network first and setting the head in the same transaction as the first version.

### 7.2 `curated_network_versions`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `network_id` | `ID` | no | FK → `curated_networks(id)` `ON DELETE CASCADE` |
| `version` | `INTEGER` | no | Monotonic from `1` within the network |
| `parent_version_id` | `ID` | yes | FK → `curated_network_versions(id)`. Linear in v1; the column allows branching later |
| `document` | `JSON` | no | The network: `nodes` (item references, free nodes, groups), `edges` (manual or inherited, each with provenance), `layout` (positions, pinned nodes, algorithm, parameters, optional timeline axis), `style` (field-to-channel maps and manual overrides), `annotations` (labels, callouts, hulls, legends, text boxes) |
| `is_frozen` | `BOOLEAN` | no | Default `0` |
| `frozen_at` | `TIMESTAMP` | yes | |
| `frozen_snapshot` | `JSON` | yes | Item metadata embedded at freeze time, for reproducibility. Present if and only if `is_frozen = 1` |
| `message` | `TEXT` | yes | Version note |
| `created_by_user_id` | `ID` | yes | FK → `users(id)` |
| `created_at` | `TIMESTAMP` | no | |

**Constraints.** `ux_curated_network_versions_number` unique on `(network_id, version)`.
`ck_curated_network_versions_frozen`: `(is_frozen = 1) = (frozen_snapshot IS NOT NULL)`.

**Invariants.**
- CN1. A frozen version is immutable. Editing a frozen version creates a new version whose parent is
  the frozen one.
- CN2. Node references into `items` are **not** SQL foreign keys — the document is JSON, and a node
  may legitimately reference an item that was later trashed. Resolution happens at render time and a
  dangling reference is displayed as such, not silently dropped. This is the price of the document
  model and it is the right price: it is what lets a published figure survive a library
  reorganisation.
- CN3. Live versions resolve item metadata at read time (so corrections propagate); frozen versions
  read `frozen_snapshot`. This is the whole point of the freeze.

---

## 8. Systematic review — Phase 7

Specified now, built in Phase 7, which gets its own spec before work starts (CONCEPT §7). The
tables here are the schema commitments that Phase 5's graph and analytics work must not contradict:
the unit of PRISMA counting, per-source tracking, and the fact that extraction data reuses
`field_values` rather than a parallel store.

### 8.1 `reviews`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `public_id` | `TEXT` | no | |
| `title` | `TEXT` | no | |
| `question` | `TEXT` | yes | |
| `protocol` | `JSON` | no | Default `{}`. PICO, eligibility criteria, planned analyses, deviations |
| `registration_id` | `TEXT` | yes | PROSPERO or OSF id |
| `registration_url` | `TEXT` | yes | |
| `status` | `TEXT` | no | `draft`, `searching`, `screening`, `full_text`, `extraction`, `analysis`, `complete`, `archived`. Closed vocabulary |
| `screener_count` | `INTEGER` | no | Default `1`. `2` enables the second-screener paths that are reserved in v1 |
| `blind_mode` | `BOOLEAN` | no | Default `0` |
| `conflict_policy` | `TEXT` | yes | `discuss`, `third_screener`, `inclusive` — reserved for the multi-screener case |
| `exclusion_reasons` | `JSON` | no | Default `[]`. Ordered array of `{code, label, stage}`. Ordered because PRISMA reports reasons in a fixed order |
| `automation_disclosure` | `BOOLEAN` | no | Default `0`. ADR-020: records which decisions were tool-assisted and exports that with the audit trail when on |
| `owner_user_id` | `ID` | no | FK → `users(id)` |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |
| `trashed_at` | `TIMESTAMP` | yes | |

**Constraints.** `ux_reviews_public_id` unique.

### 8.2 `search_runs`

**Purpose.** One executed search against one database, with everything PRISMA-S wants reported. The
export file itself is kept as a `documents` row, so the search is reproducible from the library
alone (P10).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `review_id` | `ID` | no | FK → `reviews(id)` `ON DELETE CASCADE` |
| `source_database` | `TEXT` | no | `pubmed`, `embase`, `web_of_science`, `scopus`, `cochrane`, `cinahl`, `psycinfo`, `openalex`, `registry`, `grey_literature`, `citation_search`, `manual`, `other`. Open vocabulary |
| `interface` | `TEXT` | yes | `Ovid`, `EBSCOhost`, native — PRISMA-S asks for the platform, not just the database |
| `query_string` | `TEXT` | no | Verbatim, in the syntax of that interface |
| `query_translated` | `TEXT` | yes | The adapted form, when the query was translated from a master strategy |
| `filters` | `JSON` | no | Default `{}`. Date limits, language limits, publication-type limits |
| `date_limit_from` | `TEXT` | yes | |
| `date_limit_to` | `TEXT` | yes | |
| `executed_at` | `TIMESTAMP` | no | |
| `executed_by_user_id` | `ID` | yes | FK → `users(id)` |
| `records_returned` | `INTEGER` | yes | What the database said |
| `records_imported` | `INTEGER` | yes | What actually arrived |
| `duplicates_removed` | `INTEGER` | yes | Attributed to this run by the dedup pass |
| `source_file_document_id` | `ID` | yes | FK → `documents(id)` `ON DELETE RESTRICT`. The RIS/CSV/NBIB export, kept as bytes |
| `import_job_id` | `ID` | yes | FK → `jobs(id)` `ON DELETE SET NULL` |
| `rerun_of_search_run_id` | `ID` | yes | FK → `search_runs(id)`. An update search points at the original |
| `notes` | `TEXT` | yes | |
| `created_at` | `TIMESTAMP` | no | |

**Indexes.** `ix_search_runs_review` (`review_id, executed_at`).

**Invariants.** SR1. `records_returned` is what the database reported and is never recomputed from
the import — the discrepancy between the two is itself reportable. SR2. Deleting a search run is
refused once records are attributed to it; PRISMA counts would silently change.

### 8.3 `review_records`

**Purpose.** The unit PRISMA counts: one record considered in one review. The join between `reviews`
and `items` — every imported record becomes an item (so it gets deduplication, enrichment, checks and
attachments for free) and a `review_records` row that carries its state within this review.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `review_id` | `ID` | no | FK → `reviews(id)` `ON DELETE CASCADE` |
| `item_id` | `ID` | no | FK → `items(id)` `ON DELETE RESTRICT` |
| `stage` | `TEXT` | no | `identified`, `deduplicated`, `title_abstract`, `full_text`, `included`, `excluded`. Closed vocabulary. The furthest stage reached |
| `dedup_status` | `TEXT` | no | `unique`, `duplicate`, `merged_master`. Closed vocabulary. Default `unique` |
| `duplicate_of_id` | `ID` | yes | FK → `review_records(id)`. Set when `dedup_status = 'duplicate'` |
| `screening_status` | `TEXT` | no | `pending`, `included`, `excluded`, `maybe`, `conflict`. Closed vocabulary. Denormalised from the current decisions so a worklist query is one table |
| `exclusion_reason_code` | `TEXT` | yes | Denormalised from the current full-text decision, for the PRISMA "reports excluded, with reasons" box |
| `retrieval_status` | `TEXT` | no | `not_attempted`, `sought`, `retrieved`, `not_retrieved`. Closed vocabulary. Default `not_attempted`. This is the PRISMA "reports sought for retrieval / not retrieved" pair |
| `retrieval_note` | `TEXT` | yes | |
| `full_text_document_id` | `ID` | yes | FK → `documents(id)` `ON DELETE SET NULL` |
| `extraction_status` | `TEXT` | no | `not_started`, `in_progress`, `complete`, `not_applicable`. Closed vocabulary |
| `is_snowballed` | `BOOLEAN` | no | Default `0`. Identified by deep dive rather than by a database search — a separate PRISMA 2020 box |
| `snowball_from_item_id` | `ID` | yes | FK → `items(id)`. Which included study led here (PRISMA-S) |
| `study_group_key` | `TEXT` | yes | Groups multiple reports of one study — PRISMA counts studies and reports separately |
| `added_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |

**Constraints.** `ux_review_records_review_item` unique on `(review_id, item_id)` — an item appears
once per review. `ck_review_records_duplicate`: `(dedup_status = 'duplicate') = (duplicate_of_id IS
NOT NULL)`.

**Indexes.** `ix_review_records_worklist` (`review_id, screening_status, added_at`),
`ix_review_records_item` (`item_id`), `ix_review_records_stage` (`review_id, stage`),
`ix_review_records_study_group` (partial).

**Invariants.**
- RR1. Every PRISMA number is a `COUNT` over this table joined to `review_record_sources`. Nothing
  is tallied incrementally, which is what "PRISMA counts computed live" means.
- RR2. `screening_status` and `exclusion_reason_code` are caches of the current rows in
  `screening_decisions`; the decisions are the record of truth, and a consistency test asserts they
  agree.
- RR3. Duplicates are kept, not deleted. "Duplicates removed" is a count of rows with
  `dedup_status = 'duplicate'`, and the reviewer can inspect every one of them.

### 8.4 `review_record_sources`

**Purpose.** Which searches found this record. Many-to-many, because after deduplication one record
is typically attributable to several databases — and PRISMA 2020 asks for "records identified" per
source, which is impossible to report from a single-source column.

| Column | Type | Null | Notes |
|---|---|---|---|
| `review_record_id` | `ID` | no | PK part, FK → `review_records(id)` `ON DELETE CASCADE` |
| `search_run_id` | `ID` | no | PK part, FK → `search_runs(id)` `ON DELETE RESTRICT` |
| `external_record_id` | `TEXT` | yes | The accession in that database (PMID, WoS UT, Scopus EID) |
| `raw_record` | `JSON` | yes | The imported record as received, before mapping |
| `is_primary_source` | `BOOLEAN` | no | Default `0`. Exactly one per record: the run credited in the "identified" count |
| `imported_at` | `TIMESTAMP` | no | |

**Constraints.** PK `(review_record_id, search_run_id)`. `ux_review_record_sources_primary` unique on
`(review_record_id)`, partial `WHERE is_primary_source = 1`.

**Indexes.** `ix_review_record_sources_run` (`search_run_id`).

### 8.5 `screening_decisions`

**Purpose.** Every screening decision, append-only, with undo modelled as supersession rather than
mutation — because CONCEPT §5.10 item 11 requires an audit trail for every decision.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `review_id` | `ID` | no | FK → `reviews(id)` `ON DELETE CASCADE`. Denormalised from the record for cheap per-review queries |
| `review_record_id` | `ID` | no | FK → `review_records(id)` `ON DELETE CASCADE` |
| `stage` | `TEXT` | no | `title_abstract` or `full_text`. Closed vocabulary |
| `screener_user_id` | `ID` | no | FK → `users(id)` |
| `decision` | `TEXT` | no | `include`, `exclude`, `maybe`. Closed vocabulary |
| `exclusion_reason_code` | `TEXT` | yes | Must be one of `reviews.exclusion_reasons`. Mandatory at `full_text` when `decision = 'exclude'` |
| `exclusion_reason_note` | `TEXT` | yes | |
| `decided_at` | `TIMESTAMP` | no | |
| `duration_ms` | `INTEGER` | yes | Time on the record; a quality signal, not a target |
| `is_current` | `BOOLEAN` | no | Default `1` |
| `supersedes_id` | `ID` | yes | FK → `screening_decisions(id)` |
| `superseded_by_id` | `ID` | yes | FK → `screening_decisions(id)` |
| `tool_assisted` | `BOOLEAN` | no | Default `0`. ADR-020 |
| `tool_detail` | `JSON` | yes | What assisted, which model, what it suggested, whether the human agreed |
| `is_conflict_resolution` | `BOOLEAN` | no | Default `0` |
| `resolves_conflict_between` | `JSON` | yes | Array of decision ids — reserved for the second-screener case |
| `created_at` | `TIMESTAMP` | no | |

**Constraints.**
- `ux_screening_decisions_current` unique on `(review_record_id, stage, screener_user_id)`, partial
  `WHERE is_current = 1`.
- `ck_screening_full_text_reason`: `NOT (stage = 'full_text' AND decision = 'exclude' AND
  exclusion_reason_code IS NULL)` — CONCEPT §5.10 makes the reason mandatory at full text, so the
  database makes it mandatory too.

**Indexes.** `ix_screening_decisions_record` (`review_record_id, stage`),
`ix_screening_decisions_review_current` (`review_id, stage, decision`, partial `WHERE is_current = 1`),
`ix_screening_decisions_screener` (`screener_user_id, decided_at`).

**Invariants.**
- SD1. Rows are never updated except to set `is_current = 0` and `superseded_by_id`. An undo inserts
  a new row. The count of decisions is therefore also a count of actions, which is what an audit
  trail means.
- SD2. `tool_assisted` is set by the server from the calling token's identity, not by the client. A
  decision written through the MCP tool set is tool-assisted by construction.
- SD3. Blind mode hides other screeners' decisions at read time. Nothing is hidden in storage,
  because unblinding after the fact is a normal step.

### 8.6 `extraction_forms`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `review_id` | `ID` | no | FK → `reviews(id)` `ON DELETE CASCADE` |
| `name` | `TEXT` | no | |
| `version` | `INTEGER` | no | Default `1` |
| `template` | `TEXT` | yes | `rct`, `observational`, `diagnostic`, `qualitative`, `custom` |
| `schema_json` | `JSON` | no | Ordered array of sections, each an ordered array of `custom_fields.field_key` references with per-form overrides (label, help text, requiredness) |
| `repeatable_groups` | `JSON` | no | Default `[]`. Group definitions — `arm`, `outcome`, `timepoint` — each with a key prefix that `field_values.group_key` uses |
| `status` | `TEXT` | no | `draft`, `active`, `locked`. Closed vocabulary. Default `draft` |
| `created_at` | `TIMESTAMP` | no | |
| `updated_at` | `TIMESTAMP` | no | |

**Constraints.** `ux_extraction_forms_version` unique on `(review_id, name, version)`.

**Invariants.**
- EF1. A form references custom fields; it does not define them. That is why extraction data can be
  exported by the same code path as library custom fields, and why an extraction variable can be
  reused across reviews.
- EF2. `status = 'locked'` after the first extraction is complete; a change then requires a new
  `version`, and existing `field_values` keep pointing at the version they were entered under.

### 8.7 `rob_assessments`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `review_id` | `ID` | no | FK → `reviews(id)` `ON DELETE CASCADE` |
| `review_record_id` | `ID` | no | FK → `review_records(id)` `ON DELETE CASCADE` |
| `tool` | `TEXT` | no | `rob2`, `rob2_cluster`, `rob2_crossover`, `robins_i`, `robins_e`, `newcastle_ottawa`, `quadas2`, `custom`. Open vocabulary — the `srTemplate` hook adds instruments |
| `tool_version` | `TEXT` | yes | |
| `instrument` | `JSON` | no | The instrument definition as it stood at assessment time — signalling questions, algorithms, domain names. Frozen here rather than referenced, so a later revision of RoB 2 cannot retroactively change a published judgement |
| `signalling_answers` | `JSON` | no | Default `{}`. Question key → `{answer, support, quote, document_id, page_index}` |
| `domain_judgements` | `JSON` | no | Default `{}`. Domain key → `{judgement, rationale}` |
| `overall_judgement` | `TEXT` | yes | `low`, `some_concerns`, `high`, `critical`, `serious`, `moderate`, `unclear`, `not_applicable`. Open vocabulary because the level set differs per instrument |
| `outcome_label` | `TEXT` | yes | RoB 2 is assessed per outcome, not per study |
| `arm_label` | `TEXT` | yes | |
| `assessor_user_id` | `ID` | no | FK → `users(id)` |
| `assessed_at` | `TIMESTAMP` | no | |
| `is_current` | `BOOLEAN` | no | Default `1` |
| `superseded_by_id` | `ID` | yes | FK → `rob_assessments(id)` |
| `notes` | `TEXT` | yes | |

**Constraints.** `ux_rob_assessments_current` unique on `(review_record_id, tool, outcome_key,
assessor_user_id)`, partial `WHERE is_current = 1`, with `outcome_key` the maintained
`COALESCE(outcome_label, '')`.

**Indexes.** `ix_rob_assessments_review` (`review_id, tool`).

**Invariants.** RB1. The `robvis` traffic-light export reads `domain_judgements` and
`overall_judgement` directly; no reshaping in R (CONCEPT G5).

### 8.8 `prisma_counts`

**Purpose.** Frozen snapshots of the PRISMA 2020 flow. The live counts are a query over
`review_records` and `review_record_sources` (RR1); this table exists so that the numbers printed in
a submitted manuscript can be reproduced later even though the review has moved on.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `ID` | no | PK |
| `review_id` | `ID` | no | FK → `reviews(id)` `ON DELETE CASCADE` |
| `snapshot_at` | `TIMESTAMP` | no | Identifies the snapshot |
| `snapshot_label` | `TEXT` | yes | `submission`, `revision 1` |
| `stage_key` | `TEXT` | no | `records_identified_databases`, `records_identified_registers`, `records_identified_other`, `records_removed_duplicates`, `records_removed_automation`, `records_removed_other`, `records_screened`, `records_excluded`, `reports_sought`, `reports_not_retrieved`, `reports_assessed`, `reports_excluded`, `studies_included`, `reports_of_included_studies`. Closed vocabulary — it is the PRISMA 2020 diagram |
| `source_label` | `TEXT` | yes | Per-database breakdown; `NULL` for the total |
| `search_run_id` | `ID` | yes | FK → `search_runs(id)` `ON DELETE SET NULL` |
| `exclusion_reason_code` | `TEXT` | yes | For the "excluded, with reasons" box |
| `count_value` | `INTEGER` | no | |
| `computed_by` | `TEXT` | no | `live` or `frozen`. Closed vocabulary |
| `created_at` | `TIMESTAMP` | no | |

**Constraints.** `ux_prisma_counts_cell` unique on `(review_id, snapshot_at, stage_key,
source_scope_key, reason_scope_key)` with the two maintained `COALESCE` mirrors.

**Invariants.** PC1. A frozen snapshot is never recomputed. PC2. The live query and a snapshot taken
at the same instant must agree; a test asserts it against the fixture review.

---

## 9. Search index

The index is **not** part of the portable schema, because FTS5 virtual tables and Postgres
`tsvector` columns have nothing in common (ADR-0011). It is built by a dialect-specific migration
behind one interface, and it is derived data: it can be dropped and rebuilt from the tables above at
any time.

One logical document per indexed entity, with these fields:

| Source | Indexed content |
|---|---|
| `items` + `item_bibliographic` | title, subtitle, short title, container title, abstract, all identifiers, citation key, `extra` |
| `item_creators` + `creators` | display names, raw names, name variants, affiliations |
| `item_office` | correspondent, reference number |
| `item_terms` + `terms` | term labels, including the preferred form of a non-preferred term |
| `tags` | tag names |
| `notes` | `content_markdown` |
| `annotations` | `quoted_text`, `body_text` |
| `documents` | extracted text (the largest field by far; stored in the index, not in a table column) |
| `edge_evidence` | `text_excerpt` — this is what makes "how does my corpus cite X" a query |

Facets exposed for filtering: `item_type`, `issued_year`, collection, tag, term, creator, language,
`retraction_status`, `oa_status`, `verification_status`, `has_attachment`, `has_annotations`,
review and screening status.

Notes on the extracted text of a document: it is not a column on `documents` because a large text
column on a hot table hurts every query that touches the row. It lives in the index and, for the
analytics path, in the Parquet bundle. `documents.text_char_count` is the queryable summary.

---

## 10. Analytics export (ADR-0008)

`GET /analytics/export` emits the Parquet bundle. The mapping from tables to bundle members, stated
here because it constrains the schema:

| Bundle member | Built from |
|---|---|
| `works` | `items` ⋈ `item_bibliographic`, one row per item, plus the current value per metric |
| `creators` | `creators` |
| `works_creators` | `item_creators` — carries `ordinal`, `role`, `affiliation_raw`, `country_code` |
| `terms` | `terms`, with the resolved preferred form |
| `works_terms` | `item_terms` |
| `edges` | `graph_edges` ⋈ `graph_nodes` on both ends, with node type and external ids denormalised |
| `metrics` | `item_metrics`, full time series |
| `sr_*` | `reviews`, `search_runs`, `review_records`, `review_record_sources`, `screening_decisions`, `field_values` (extraction), `rob_assessments`, `prisma_counts` |

The bibliometrix `M` data frame (goal G4) is a projection of `works`, `works_creators`,
`works_terms`, `edges` and `metrics`:

| WoS tag | Source |
|---|---|
| `AU` | `creators.initials` via `item_creators`, in `ordinal` order |
| `AF` | `creators.display_name` |
| `TI` | `item_bibliographic.title` |
| `SO` | `item_bibliographic.container_title` |
| `DT` | `items.item_type` (mapped) |
| `DE` | `item_terms` where `terms.scheme = 'author_keyword'` |
| `ID` | `item_terms` where `terms.scheme IN ('mesh','openalex_topic')` |
| `AB` | `item_bibliographic.abstract` |
| `C1` | `item_creators.affiliation_raw` |
| `CR` | `graph_edges` where `edge_type = 'cites'`, rendered as reference strings from the target node |
| `TC` | `item_metrics` where `metric = 'cited_by_count'`, most recent observation |
| `PY` | `item_bibliographic.issued_year` |
| `DI` | `item_bibliographic.doi` |
| `SR` | `item_bibliographic.citation_key` |

Every one of these is a column or a documented join, which is the test of whether the schema is
right: nothing in the `M` mapping requires a heuristic.

---

## 11. Migration order and phasing

Migrations are numbered and forward-only; each is written against the dialect intersection (§1.1).
The grouping follows the roadmap, so that a Phase 1 deployment carries no unused Phase 7 tables
until Phase 7 lands.

| Migration group | Tables |
|---|---|
| `0001_core` | `users`, `api_tokens`, `documents`, `items`, `item_bibliographic`, `attachments`, `collections`, `collection_items`, `tags`, `item_tags`, `custom_fields`, `field_values`, `notes`, `creators`, `item_creators`, `jobs`, `job_logs`, `audit_log`, `trash` |
| `0002_ingestion` | `item_office`, `review_queue`, and the `documents` OCR/simhash columns |
| `0003_enrichment` | `field_provenance`, `check_results`, `plugins`, `item_metrics` |
| `0004_reading` | `annotations`, `annotation_tags`, plus the dialect-specific search index |
| `0005_graph` | `terms`, `item_terms`, `shadow_works`, `graph_nodes`, `graph_edges`, `edge_evidence` |
| `0006_networks` | `curated_networks`, `curated_network_versions` |
| `0007_sr` | `reviews`, `search_runs`, `review_records`, `review_record_sources`, `screening_decisions`, `extraction_forms`, `rob_assessments`, `prisma_counts`, plus the `field_values` review columns |

Columns that later groups add to earlier tables are listed with the group that adds them, so that
`0001_core` is exactly what Phase 1 needs and nothing more.

The fixture library (Phase 0 exit criterion) must exercise: an item with two attachments sharing one
document with another item; a locked field that survives an enrichment run; a trashed and restored
item; a reversed merge; a job re-run under the same idempotency key; an annotation on a document
reachable from two items; a shadow work promoted to an item; and a review with two search runs whose
PRISMA counts add up.

---

## 12. Open questions

Things CONCEPT.md leaves genuinely underspecified, listed so they are decided deliberately rather
than by whoever writes the migration first.

**O1. Where does extracted document text live?**
§9 puts it in the search index only. That is right for search, but the analytics bundle, GROBID
re-runs and the near-duplicate simhash all want the text without a reindex. The alternatives are a
`document_texts` side table (one row per document, one large column, never joined to a hot query) or
a file in the content store beside the blob. The side table is probably correct; it is not specified
above because it is an implementation detail that the Phase 2 OCR work should settle with real
data in front of it.

**O2. Are ingestion and dedup rules a table or a file?**
CONCEPT §5.3 stage 8 describes a rule engine and CONCEPT §5.6 says merge rules are "editable as
YAML/JSON in the UI". Editable in the UI implies a table (`rules`: id, kind, priority, match, action,
enabled, dry-run statistics); a file implies version control and portability. No table is specified
here. Recommendation: a table, with import/export to YAML, decided in the Phase 2 ingestion spec.

**O3. Item type vocabulary: closed with a lookup table, or open with Zod validation?**
§3.4 chooses open. Zotero uses a lookup table with per-type valid fields, which is what makes its
field validation possible. If Recueil wants "which fields are valid for a thesis" to be data rather
than code — and the `completeness` check probably does — then `item_types` and `item_type_fields`
tables are needed. Deferred to the Phase 1 spec; the column is `TEXT` either way, so the decision
does not block.

**O4. Does the office facet need its own correspondent table?**
§3.7 keeps `correspondent` as text with an optional promotion to a `creators` organisation row.
Paperless-ngx has first-class correspondents with rules and statistics, and the importer will carry
a correspondent list across. If office use grows, `creators` with `kind = 'organisation'` may be the
wrong home for what is really a filing dimension.

**O5. Polymorphic references have no foreign keys.**
`field_provenance`, `review_queue`, `trash`, `check_results` and `audit_log` all store
`(entity_type, entity_id)` with no referential integrity. The alternatives — one child table per
entity type, or a shared `entities` supertable that everything inherits from — are both worse in
different ways. The chosen mitigation is a periodic integrity job that reports dangling references
and a test that every write goes through a helper that resolves the type. Stated here so it is a
known, accepted risk rather than an oversight.

**O6. What is the unit of the review queue for a bulk import?**
Ten thousand low-confidence records from one import should not be ten thousand queue entries.
CONCEPT §5.3 stage 9 describes a per-record confidence gate; the UI needs batch review. Either
`review_queue` gains a `batch_id` and the UI groups, or the pipeline raises one entry per
`(reason_code, job_id)` with a payload listing the subjects. Not decided.

**O7. Multi-user scope: `owner_user_id` or a `libraries` table?**
§1.4 puts an owner on top-level records. Zotero's model is libraries (personal and group) with items
belonging to a library, which is what makes a group library a single unit to share, sync and export.
If shared group libraries are ever wanted, `library_id` is the better column and it is cheaper to
add now than later. The counter-argument is that CONCEPT §2 lists multi-user as a non-goal and
speculative columns rot. Recommendation: revisit at the M4 open-the-repo decision (ADR-014), not
before.

**O8. Versioning granularity for notes and annotations.**
§1.7 gives them an optimistic-concurrency `version` counter but no history. Zotero keeps no note
history either and users lose work to it. A `note_revisions` table is cheap. Not specified because
the retention policy — every keystroke, every save, or daily — is a product decision.

**O9. How are derived graph edges garbage-collected?**
GE2 replaces a projection run wholesale, but nothing above says when an old `run_id` is dropped. If
two saved maps reference two different runs, neither can be dropped. Either curated networks pin
their run, or projections are cached with a TTL and rebuilt. Needs deciding with the Phase 5 graph
work.

**O10. Do office documents need their own facet-specific check set?**
CONCEPT §5.5 lists thirteen checks, all bibliographic. Invoices have their own integrity questions
(duplicate invoice number, amount not matching the extracted text, missing due date). The
`check_results` table is facet-agnostic and needs no change, but the check catalogue does.

**O11. Storage of the resolver cache.**
CONCEPT §5.4 specifies "batch jobs with cache and TTL". No cache table is specified here because it
is infrastructure rather than library data, and because it may be better as a separate database file
that a backup can skip. If it becomes a table, it should not live in the same migration series as
the library.
