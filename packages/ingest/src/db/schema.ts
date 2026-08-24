/**
 * The two tables Phase 2 adds, as Drizzle definitions.
 *
 * `review_queue` is specified in `spec/data-model.md` §6.1 and is not in `@recueil/core`'s schema
 * yet: §11 assigns it to migration `0002_ingestion`, and core is at `0003_trash_merge_scope` with
 * the ingestion columns of `documents` and the `item_office` facet already in `0000_core` but the
 * queue itself still missing. Rather than reach into another package's migration series, this
 * package installs the table itself, idempotently, from `install.ts`. The column list is §6.1's,
 * verbatim, so that when core adopts it the definitions match and the install becomes a no-op.
 *
 * `ingest_checkpoints` is not in the data model, and the reason is that it is not library data. It
 * is the resume point CONCEPT §5.3 requires ("resumable") at a finer grain than `jobs.cursor` can
 * express: `jobs.cursor` says which candidate a run had reached, and this says which *stage* of
 * that candidate had finished and what it produced, so that a run interrupted after a
 * twenty-minute OCR pass does not pay for it twice. Rows are keyed by the run and by the
 * candidate, and a run that completes drops its own.
 */
import { sql } from 'drizzle-orm';
import { index, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const REVIEW_SUBJECT_TYPES = [
  'document',
  'item',
  'attachment',
  'creator',
  'shadow_work',
  'merge_candidate',
  'ingest_batch',
  'check_result',
  'enrichment',
  'job',
] as const;

export type ReviewSubjectType = (typeof REVIEW_SUBJECT_TYPES)[number];

export const REVIEW_SEVERITIES = ['info', 'warning', 'blocker'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export const REVIEW_STATUSES = ['open', 'accepted', 'rejected', 'deferred', 'superseded'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_ACTIONS = [
  'merge',
  'link',
  'create_item',
  'set_fields',
  'discard',
  'retry',
  'none',
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/**
 * The reason codes this pipeline raises. `spec/data-model.md` §6.1 calls the vocabulary open, so
 * this is a list of what Recueil itself writes, not a constraint on what a plugin may write.
 */
export const INGEST_REASON_CODES = {
  lowConfidence: 'low_confidence_metadata',
  noIdentifierMatch: 'no_identifier_match',
  ocrFailed: 'ocr_failed',
  ruleConflict: 'rule_conflict',
  ruleRequested: 'rule_requested_review',
  archiveUnreadable: 'archive_unreadable',
  unsafeArchivePath: 'unsafe_archive_path',
  archiveLimitExceeded: 'archive_limit_exceeded',
  stageFailed: 'ingest_stage_failed',
  pluginRequested: 'plugin_requested_review',
} as const;

export const reviewQueue = sqliteTable(
  'review_queue',
  {
    id: text('id').primaryKey(),
    subjectType: text('subject_type', { enum: REVIEW_SUBJECT_TYPES }).notNull(),
    /** Polymorphic; no SQL foreign key, exactly as §6.1 says. */
    subjectId: text('subject_id').notNull(),
    secondarySubjectType: text('secondary_subject_type'),
    secondarySubjectId: text('secondary_subject_id'),
    reasonCode: text('reason_code').notNull(),
    /**
     * Stored, not generated at render time, "so the reason a decision was queued in 2026 still
     * reads correctly in 2029" (§6.1).
     */
    explanation: text('explanation').notNull(),
    proposedAction: text('proposed_action', { enum: REVIEW_ACTIONS }),
    /** Exactly the request body that "accept" will execute (RQ1). */
    proposedPayload: text('proposed_payload'),
    /** The score that failed the gate. */
    confidence: real('confidence'),
    severity: text('severity', { enum: REVIEW_SEVERITIES }).notNull().default('warning'),
    status: text('status', { enum: REVIEW_STATUSES }).notNull().default('open'),
    /** Deterministic digest of `(subject, secondary subject, reason)`; see the partial index. */
    dedupeKey: text('dedupe_key').notNull(),
    /** `ingest.6`, `dedup.record`, `check.doi_resolves`. */
    sourceStage: text('source_stage'),
    jobId: text('job_id'),
    pluginId: text('plugin_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    resolvedAt: text('resolved_at'),
    resolvedByUserId: text('resolved_by_user_id'),
    resolutionNote: text('resolution_note'),
    resolutionPayload: text('resolution_payload'),
  },
  (table) => [
    /** Re-running an idempotent import does not produce a second open entry (§6.1, P9). */
    uniqueIndex('ux_review_queue_open')
      .on(table.dedupeKey)
      .where(sql`status = 'open'`),
    index('ix_review_queue_open')
      .on(table.severity, table.createdAt)
      .where(sql`status = 'open'`),
    index('ix_review_queue_subject').on(table.subjectType, table.subjectId),
    index('ix_review_queue_reason').on(table.reasonCode),
  ],
);

export type ReviewQueueRow = typeof reviewQueue.$inferSelect;

export const ingestCheckpoints = sqliteTable(
  'ingest_checkpoints',
  {
    /** The `jobs.id` of the run. */
    runId: text('run_id').notNull(),
    /** A digest of `(sourceId, externalId, revision)` — the candidate's identity within the run. */
    candidateKey: text('candidate_key').notNull(),
    /** One of `PIPELINE_ANCHORS`, or `commit` for the terminal row that holds the outcome. */
    stage: text('stage').notNull(),
    sha256: text('sha256'),
    /** What the stage produced, as JSON. Read back verbatim when the run resumes. */
    payload: text('payload').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('ux_ingest_checkpoints').on(table.runId, table.candidateKey, table.stage),
    index('ix_ingest_checkpoints_candidate').on(table.runId, table.candidateKey),
  ],
);

export type IngestCheckpointRow = typeof ingestCheckpoints.$inferSelect;
