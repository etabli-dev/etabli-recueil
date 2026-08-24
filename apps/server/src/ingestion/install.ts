/**
 * The three configuration tables Phase 2's API surface needs, installed idempotently.
 *
 * `spec/data-model.md` §11 puts `review_queue` in core's `0002_ingestion` migration and
 * `@recueil/ingest` installs it from `db/install.ts` until that lands. These three are a different
 * case: none of them is in the data model at all.
 *
 * - `ingestion_sources` is the configured folder, WebDAV share and mailbox of CONCEPT §5.3. The
 *   model has no table for it because Phase 0 had no ingestion; the shape below is the union of
 *   what `FolderSourceOptions`, `WebDavSourceOptions` and `ImapSourceOptions` take, split into the
 *   part that may be shown (`config`) and the part that may not (`secret_ciphertext`).
 * - `rules` is O2's recommendation taken literally: "a table, with import/export to YAML". One row
 *   per rule, holding the `when`/`then` of one `@recueil/rules` rule, so the stored set can be
 *   assembled into a `RuleSetLike` and evaluated by the engine unchanged.
 * - `storage_backends` is the WebDAV and S3 configuration of CONCEPT §5.1. Note what it is *not*:
 *   the backend the running process writes through is chosen at boot from the environment, because
 *   swapping the store under a live library mid-request would strand every blob written before the
 *   swap. A row here is a configuration that a health check can exercise and that the operator can
 *   point `RECUEIL_STORAGE_*` at, not a live rebind.
 *
 * All three are `create table if not exists` and every column is verified after creation, for the
 * reason `@recueil/ingest` gives: a table left by an older build is a real possibility and a
 * `no such column` at write time tells an operator nothing.
 */
import type { SqliteConnection } from '@recueil/core';

interface ColumnInfo {
  name: string;
}

const SOURCES_DDL = `
create table if not exists ingestion_sources (
  id text primary key not null,
  name text not null,
  kind text not null,
  enabled integer not null default 1,
  source_kind text not null,
  config text not null default '{}',
  secret_ciphertext text,
  secret_names text not null default '[]',
  consume_mode text not null default 'leave',
  consume_to text,
  last_run_job_id text references jobs(id) on delete set null,
  last_run_at text,
  last_error text,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null,
  constraint ck_ingestion_sources_kind check (kind in ('folder','webdav','imap')),
  constraint ck_ingestion_sources_consume check (consume_mode in ('leave','move','delete')),
  constraint ck_ingestion_sources_config_json check (json_valid(config)),
  constraint ck_ingestion_sources_secret_names_json check (json_valid(secret_names))
)`;

const SOURCES_INDEXES = [
  `create unique index if not exists ux_ingestion_sources_name on ingestion_sources (name)`,
  `create index if not exists ix_ingestion_sources_kind on ingestion_sources (kind, enabled)`,
];

const RULES_DDL = `
create table if not exists rules (
  id text primary key not null,
  rule_id text not null,
  kind text not null,
  description text,
  enabled integer not null default 1,
  priority integer not null default 0,
  definition text not null,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null,
  constraint ck_rules_kind check (kind in ('ingestion','dedup')),
  constraint ck_rules_definition_json check (json_valid(definition))
)`;

const RULES_INDEXES = [
  `create unique index if not exists ux_rules_rule_id on rules (kind, rule_id)`,
  `create index if not exists ix_rules_kind_priority on rules (kind, priority, rule_id)`,
];

const BACKENDS_DDL = `
create table if not exists storage_backends (
  id text primary key not null,
  name text not null,
  kind text not null,
  enabled integer not null default 1,
  config text not null default '{}',
  secret_ciphertext text,
  secret_names text not null default '[]',
  last_checked_at text,
  last_status text,
  last_detail text,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null,
  constraint ck_storage_backends_kind check (kind in ('webdav','s3')),
  constraint ck_storage_backends_config_json check (json_valid(config)),
  constraint ck_storage_backends_secret_names_json check (json_valid(secret_names))
)`;

const BACKENDS_INDEXES = [
  `create unique index if not exists ux_storage_backends_name on storage_backends (name)`,
];

const SOURCE_COLUMNS = [
  'id',
  'name',
  'kind',
  'enabled',
  'source_kind',
  'config',
  'secret_ciphertext',
  'secret_names',
  'consume_mode',
  'consume_to',
  'last_run_job_id',
  'last_run_at',
  'last_error',
  'version',
  'created_at',
  'updated_at',
] as const;

const RULE_COLUMNS = [
  'id',
  'rule_id',
  'kind',
  'description',
  'enabled',
  'priority',
  'definition',
  'version',
  'created_at',
  'updated_at',
] as const;

const BACKEND_COLUMNS = [
  'id',
  'name',
  'kind',
  'enabled',
  'config',
  'secret_ciphertext',
  'secret_names',
  'last_checked_at',
  'last_status',
  'last_detail',
  'version',
  'created_at',
  'updated_at',
] as const;

/** Create the Phase 2 configuration tables if they are absent, then verify their columns. */
export const ensureIngestionConfigSchema = (connection: SqliteConnection): void => {
  connection.exec(SOURCES_DDL);
  connection.exec(RULES_DDL);
  connection.exec(BACKENDS_DDL);

  assertColumns(connection, 'ingestion_sources', SOURCE_COLUMNS);
  assertColumns(connection, 'rules', RULE_COLUMNS);
  assertColumns(connection, 'storage_backends', BACKEND_COLUMNS);

  for (const statement of [...SOURCES_INDEXES, ...RULES_INDEXES, ...BACKENDS_INDEXES]) {
    connection.exec(statement);
  }
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
        'created it; migrate the library rather than letting the server write into it.',
    );
  }
};
