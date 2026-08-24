/**
 * Installing the Phase 2 tables.
 *
 * `spec/data-model.md` §11 puts `review_queue` in migration `0002_ingestion`, which belongs to
 * `@recueil/core`'s forward-only series. Core has not written it yet. Two bad options and one
 * tolerable one: reach into another package's migration folder (no — the series is generated from
 * `schema.ts` and hand-editing it desynchronises the two), keep the queue in a second database (no
 * — the commit of stage 10 has to be one transaction, and it writes both the item and, when the
 * gate fails, the queue entry), or install the table from here, idempotently, with the column list
 * of §6.1 verbatim.
 *
 * This is the third. It is `CREATE TABLE IF NOT EXISTS`, so the day core's `0002_ingestion` lands
 * the install becomes a no-op and this module can be deleted without touching a caller. The
 * statements are written by hand rather than generated because drizzle-kit would want to own the
 * whole series to emit them.
 *
 * `ensureIngestSchema` also checks, rather than assumes, that the columns it needs are present: a
 * table created by an older version of this file, or by a partially applied core migration, is a
 * real possibility and a silent `no such column` at commit time is the worst place to find out.
 */
import type { SqliteConnection } from '@recueil/core';

interface ColumnInfo {
  name: string;
}

const REVIEW_QUEUE_DDL = `
create table if not exists review_queue (
  id text primary key not null,
  subject_type text not null,
  subject_id text not null,
  secondary_subject_type text,
  secondary_subject_id text,
  reason_code text not null,
  explanation text not null,
  proposed_action text,
  proposed_payload text,
  confidence real,
  severity text not null default 'warning',
  status text not null default 'open',
  dedupe_key text not null,
  source_stage text,
  job_id text references jobs(id) on delete set null,
  plugin_id text,
  created_at text not null,
  updated_at text not null,
  resolved_at text,
  resolved_by_user_id text references users(id) on delete set null,
  resolution_note text,
  resolution_payload text,
  constraint ck_review_queue_subject_type check (subject_type in (
    'document','item','attachment','creator','shadow_work','merge_candidate','ingest_batch',
    'check_result','enrichment','job')),
  constraint ck_review_queue_severity check (severity in ('info','warning','blocker')),
  constraint ck_review_queue_status check (status in ('open','accepted','rejected','deferred','superseded')),
  constraint ck_review_queue_action check (
    proposed_action is null or proposed_action in ('merge','link','create_item','set_fields','discard','retry','none')),
  constraint ck_review_queue_confidence check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint ck_review_queue_proposed_payload_json check (proposed_payload is null or json_valid(proposed_payload)),
  constraint ck_review_queue_resolution_payload_json check (resolution_payload is null or json_valid(resolution_payload))
)`;

const REVIEW_QUEUE_INDEXES = [
  `create unique index if not exists ux_review_queue_open on review_queue (dedupe_key) where status = 'open'`,
  `create index if not exists ix_review_queue_open on review_queue (severity, created_at) where status = 'open'`,
  `create index if not exists ix_review_queue_subject on review_queue (subject_type, subject_id)`,
  `create index if not exists ix_review_queue_reason on review_queue (reason_code)`,
];

const CHECKPOINTS_DDL = `
create table if not exists ingest_checkpoints (
  run_id text not null,
  candidate_key text not null,
  stage text not null,
  sha256 text,
  payload text not null default '{}',
  created_at text not null,
  constraint ck_ingest_checkpoints_payload_json check (json_valid(payload))
)`;

const CHECKPOINTS_INDEXES = [
  `create unique index if not exists ux_ingest_checkpoints on ingest_checkpoints (run_id, candidate_key, stage)`,
  `create index if not exists ix_ingest_checkpoints_candidate on ingest_checkpoints (run_id, candidate_key)`,
];

const REVIEW_QUEUE_COLUMNS = [
  'id',
  'subject_type',
  'subject_id',
  'secondary_subject_type',
  'secondary_subject_id',
  'reason_code',
  'explanation',
  'proposed_action',
  'proposed_payload',
  'confidence',
  'severity',
  'status',
  'dedupe_key',
  'source_stage',
  'job_id',
  'plugin_id',
  'created_at',
  'updated_at',
  'resolved_at',
  'resolved_by_user_id',
  'resolution_note',
  'resolution_payload',
] as const;

const CHECKPOINT_COLUMNS = ['run_id', 'candidate_key', 'stage', 'sha256', 'payload', 'created_at'] as const;

/** Create the Phase 2 tables if they are absent, then verify the columns are the ones expected. */
export const ensureIngestSchema = (connection: SqliteConnection): void => {
  connection.exec(REVIEW_QUEUE_DDL);
  connection.exec(CHECKPOINTS_DDL);

  // Checked before the indexes are built, not after: an index over a column that is not there
  // fails with `no such column`, which tells the operator nothing about which version of which
  // table they are looking at.
  assertColumns(connection, 'review_queue', REVIEW_QUEUE_COLUMNS);
  assertColumns(connection, 'ingest_checkpoints', CHECKPOINT_COLUMNS);

  for (const statement of REVIEW_QUEUE_INDEXES) connection.exec(statement);
  for (const statement of CHECKPOINTS_INDEXES) connection.exec(statement);
};

const assertColumns = (
  connection: SqliteConnection,
  table: string,
  expected: readonly string[],
): void => {
  const rows = connection.prepare(`pragma table_info(${table})`).all() as ColumnInfo[];
  const present = new Set(rows.map((row) => row.name));
  const missing = expected.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Table '${table}' exists but is missing ${missing.join(', ')}. A newer or older Recueil ` +
        'created it; migrate the library rather than letting the pipeline write into it.',
    );
  }
};
