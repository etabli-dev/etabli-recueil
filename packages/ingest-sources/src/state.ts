/**
 * What each source remembers between polls, and across a restart.
 *
 * Three questions need durable answers, and none of them can be answered from the far side alone:
 *
 *   - *Have I already dealt with this?* A watched folder with the `leave` policy would otherwise
 *     offer the same file on every poll for ever, and a mailbox that was read but whose flag write
 *     was lost would re-ingest the message. The answer is a row keyed by `(source_id, external_id)`
 *     carrying the revision it was handled at, so new content at the same name is a new arrival and
 *     the same content is not.
 *   - *Did I finish?* The gap between "the pipeline committed" and "the mail has been moved out of
 *     the inbox" is a crash window. A row is written into it, with `acknowledgement = 'pending'`,
 *     before `acknowledge` is called; the runner replays every pending row at start-up, which is
 *     exactly what §6.4 means by "`acknowledge` can be delivered twice after a crash".
 *   - *Where had I got to?* The poll cursor, and the label of a run that was interrupted, so the
 *     next attempt resumes the pipeline's own journal rather than starting a fresh run over the
 *     same twenty-minute OCR pass.
 *
 * The tables are installed from here rather than from `@recueil/core`'s migration series for the
 * reason `@recueil/ingest` gives for `review_queue`: they are not in `spec/data-model.md`, because
 * they are operational state rather than library data. P5 does not reach them, nothing outside this
 * package reads them, and `create table if not exists` means the day they are adopted into a core
 * migration this file becomes a no-op.
 */
import type { SqliteConnection } from '@recueil/core';
import { nowTimestamp } from '@recueil/core';
import type { IngestOutcome, IngestRef } from '@recueil/ingest';

import type { AcknowledgementAction } from './types.js';

/** `pending` is the crash window: the pipeline has answered and the far side has not been told. */
export type AcknowledgementState = 'pending' | AcknowledgementAction;

export interface SourceStateRow {
  sourceId: string;
  externalId: string;
  revision: string;
  sha256: string | null;
  status: string;
  outcome: IngestOutcome | null;
  acknowledgement: AcknowledgementState;
  detail: string | null;
  /** Whether the store verification passed at the time the acknowledgement was recorded. */
  verified: boolean;
  firstSeenAt: string;
  updatedAt: string;
}

interface RawStateRow {
  source_id: string;
  external_id: string;
  revision: string;
  sha256: string | null;
  status: string;
  outcome: string;
  acknowledgement: string;
  detail: string | null;
  verified: number;
  first_seen_at: string;
  updated_at: string;
}

interface RawCursorRow {
  source_id: string;
  cursor: string | null;
  open_run_label: string | null;
  last_polled_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
}

const STATE_DDL = `
create table if not exists ingest_source_state (
  source_id text not null,
  external_id text not null,
  revision text not null default '',
  sha256 text,
  status text not null,
  outcome text not null default 'null',
  acknowledgement text not null default 'pending',
  detail text,
  verified integer not null default 0,
  first_seen_at text not null,
  updated_at text not null,
  primary key (source_id, external_id),
  constraint ck_ingest_source_state_outcome_json check (json_valid(outcome)),
  constraint ck_ingest_source_state_ack check (acknowledgement in (
    'pending','left','moved','deleted','marked','refused','vanished'))
)`;

const CURSOR_DDL = `
create table if not exists ingest_source_cursor (
  source_id text primary key not null,
  cursor text,
  open_run_label text,
  last_polled_at text,
  consecutive_failures integer not null default 0,
  last_error text
)`;

const INDEXES = [
  `create index if not exists ix_ingest_source_state_pending
     on ingest_source_state (source_id) where acknowledgement = 'pending'`,
  `create index if not exists ix_ingest_source_state_sha on ingest_source_state (sha256)`,
];

const STATE_COLUMNS = [
  'source_id',
  'external_id',
  'revision',
  'sha256',
  'status',
  'outcome',
  'acknowledgement',
  'detail',
  'verified',
  'first_seen_at',
  'updated_at',
] as const;

const CURSOR_COLUMNS = [
  'source_id',
  'cursor',
  'open_run_label',
  'last_polled_at',
  'consecutive_failures',
  'last_error',
] as const;

/** Create the two state tables if they are absent, then check they have the columns expected. */
export const ensureSourceSchema = (connection: SqliteConnection): void => {
  connection.exec(STATE_DDL);
  connection.exec(CURSOR_DDL);
  assertColumns(connection, 'ingest_source_state', STATE_COLUMNS);
  assertColumns(connection, 'ingest_source_cursor', CURSOR_COLUMNS);
  for (const statement of INDEXES) connection.exec(statement);
};

const assertColumns = (
  connection: SqliteConnection,
  table: string,
  expected: readonly string[],
): void => {
  const rows = connection.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  const missing = expected.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Table '${table}' exists but is missing ${missing.join(', ')}. A newer or older Recueil ` +
        'created it; migrate the library rather than letting a source write into it.',
    );
  }
};

/** The per-source memory. One instance per library; the source id keys every row. */
export class SourceStateStore {
  constructor(private readonly connection: SqliteConnection) {
    ensureSourceSchema(connection);
  }

  get(sourceId: string, externalId: string): SourceStateRow | null {
    const row = this.connection
      .prepare('select * from ingest_source_state where source_id = ? and external_id = ?')
      .get(sourceId, externalId) as RawStateRow | undefined;
    return row === undefined ? null : hydrate(row);
  }

  /**
   * True when this exact arrival has been dealt with already.
   *
   * "Dealt with" means an acknowledgement was recorded — the far side was left, moved, deleted or
   * flagged — at the same revision. A pending row is deliberately *not* handled: it is the crash
   * window, and the runner has to replay it.
   */
  isHandled(sourceId: string, externalId: string, revision: string): boolean {
    const row = this.get(sourceId, externalId);
    if (row === null) return false;
    if (row.acknowledgement === 'pending') return false;
    if (row.acknowledgement === 'refused') return false;
    return row.revision === revision;
  }

  /**
   * Record that the pipeline has answered, before the far side is touched.
   *
   * Written outside any pipeline transaction and deliberately so: the point of the row is to exist
   * when the process dies between the commit and the acknowledgement.
   */
  recordOutcome(input: { sourceId: string; ref: IngestRef; outcome: IngestOutcome }): void {
    const now = nowTimestamp();
    const sha256 = 'sha256' in input.outcome ? (input.outcome.sha256 ?? null) : null;
    this.connection
      .prepare(
        `insert into ingest_source_state
           (source_id, external_id, revision, sha256, status, outcome, acknowledgement, detail,
            verified, first_seen_at, updated_at)
         values (?, ?, ?, ?, ?, ?, 'pending', null, 0, ?, ?)
         on conflict (source_id, external_id) do update set
           revision = excluded.revision,
           sha256 = excluded.sha256,
           status = excluded.status,
           outcome = excluded.outcome,
           acknowledgement = 'pending',
           detail = null,
           verified = 0,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.sourceId,
        input.ref.externalId,
        input.ref.revision ?? '',
        sha256,
        input.outcome.status,
        JSON.stringify(input.outcome),
        now,
        now,
      );
  }

  /** Record what the acknowledgement did, and whether the store verification backed it. */
  recordAcknowledgement(input: {
    sourceId: string;
    externalId: string;
    action: AcknowledgementAction;
    detail: string;
    verified: boolean;
  }): void {
    this.connection
      .prepare(
        `update ingest_source_state
            set acknowledgement = ?, detail = ?, verified = ?, updated_at = ?
          where source_id = ? and external_id = ?`,
      )
      .run(
        input.action,
        input.detail,
        input.verified ? 1 : 0,
        nowTimestamp(),
        input.sourceId,
        input.externalId,
      );
  }

  /** Every arrival whose acknowledgement never completed. The crash window, in rows. */
  pending(sourceId: string): SourceStateRow[] {
    const rows = this.connection
      .prepare(
        `select * from ingest_source_state
          where source_id = ? and acknowledgement = 'pending'
          order by first_seen_at`,
      )
      .all(sourceId) as RawStateRow[];
    return rows.map(hydrate);
  }

  all(sourceId: string): SourceStateRow[] {
    const rows = this.connection
      .prepare('select * from ingest_source_state where source_id = ? order by external_id')
      .all(sourceId) as RawStateRow[];
    return rows.map(hydrate);
  }

  forget(sourceId: string, externalId: string): void {
    this.connection
      .prepare('delete from ingest_source_state where source_id = ? and external_id = ?')
      .run(sourceId, externalId);
  }

  cursor(sourceId: string): RawCursorRow {
    const row = this.connection
      .prepare('select * from ingest_source_cursor where source_id = ?')
      .get(sourceId) as RawCursorRow | undefined;
    return (
      row ?? {
        source_id: sourceId,
        cursor: null,
        open_run_label: null,
        last_polled_at: null,
        consecutive_failures: 0,
        last_error: null,
      }
    );
  }

  setCursor(sourceId: string, cursor: string | null): void {
    this.upsertCursor(sourceId, { cursor, last_polled_at: nowTimestamp() });
  }

  /** The label of a run that has not finished, so the next attempt resumes it. */
  setOpenRun(sourceId: string, label: string | null): void {
    this.upsertCursor(sourceId, { open_run_label: label });
  }

  recordPollFailure(sourceId: string, error: string): number {
    const current = this.cursor(sourceId);
    const failures = current.consecutive_failures + 1;
    this.upsertCursor(sourceId, { consecutive_failures: failures, last_error: error });
    return failures;
  }

  recordPollSuccess(sourceId: string): void {
    this.upsertCursor(sourceId, {
      consecutive_failures: 0,
      last_error: null,
      last_polled_at: nowTimestamp(),
    });
  }

  private upsertCursor(sourceId: string, patch: Partial<Omit<RawCursorRow, 'source_id'>>): void {
    const current = this.cursor(sourceId);
    const next: RawCursorRow = { ...current, ...patch, source_id: sourceId };
    this.connection
      .prepare(
        `insert into ingest_source_cursor
           (source_id, cursor, open_run_label, last_polled_at, consecutive_failures, last_error)
         values (?, ?, ?, ?, ?, ?)
         on conflict (source_id) do update set
           cursor = excluded.cursor,
           open_run_label = excluded.open_run_label,
           last_polled_at = excluded.last_polled_at,
           consecutive_failures = excluded.consecutive_failures,
           last_error = excluded.last_error`,
      )
      .run(
        next.source_id,
        next.cursor,
        next.open_run_label,
        next.last_polled_at,
        next.consecutive_failures,
        next.last_error,
      );
  }
}

const hydrate = (row: RawStateRow): SourceStateRow => ({
  sourceId: row.source_id,
  externalId: row.external_id,
  revision: row.revision,
  sha256: row.sha256,
  status: row.status,
  outcome: parseOutcome(row.outcome),
  acknowledgement: row.acknowledgement as AcknowledgementState,
  detail: row.detail,
  verified: row.verified === 1,
  firstSeenAt: row.first_seen_at,
  updatedAt: row.updated_at,
});

const parseOutcome = (raw: string): IngestOutcome | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as IngestOutcome;
  } catch {
    return null;
  }
};

/**
 * The state store for a library, created once and reused.
 *
 * Keyed by the connection rather than by the `Recueil` object so that two handles onto the same
 * database share one store, and held weakly so that a closed library is collectable.
 */
const stores = new WeakMap<object, SourceStateStore>();

export const sourceState = (recueil: { connection: SqliteConnection }): SourceStateStore => {
  const key = recueil.connection as unknown as object;
  const existing = stores.get(key);
  if (existing !== undefined) return existing;
  const created = new SourceStateStore(recueil.connection);
  stores.set(key, created);
  return created;
};
