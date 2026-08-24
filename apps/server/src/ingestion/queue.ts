/**
 * The work queue's read side: the `jobs` rows, their logs, and the stage trace.
 *
 * The stage trace is the part that is not obvious. `job_logs` (§6.4) is a narration — what the run
 * *said* it was doing — and `ingest_checkpoints` is the resume point: the row a resumed run reads
 * to decide which stage to start from. Showing the second rather than the first is the difference
 * between a trace that agrees with the run's own bookkeeping by construction and one that agrees
 * with what the run will actually do next time. Both are returned, and they are labelled.
 *
 * The review entries a run raised are queried by `job_id` over `review_queue`, not counted from the
 * job's `result` blob. A run that recorded "3 queued" in its result and left two rows in the queue
 * is exactly the disagreement a detail view exists to surface.
 */
import { NotFoundError, nowTimestamp, schema } from '@recueil/core';
import type { Actor, Recueil } from '@recueil/core';
import { reviewQueue } from '@recueil/ingest';
import { and, asc, desc, eq, inArray, like, lt, gt } from 'drizzle-orm';

import type * as z from 'zod';

import type { IngestionJobSchema, JobLogEntrySchema } from '../schemas-ingestion.js';
import { INGESTION_JOB_TYPES } from './runner.js';

export type JobRow = typeof schema.jobs.$inferSelect;
export type JobLogRow = typeof schema.jobLogs.$inferSelect;

export interface StageTraceRow {
  /** Which pipeline run wrote the row. A source job retried twice has three, and they differ. */
  jobId: string;
  candidateKey: string;
  stage: string;
  sha256: string | null;
  payload: unknown;
  createdAt: string;
}

export interface ListJobsFilter {
  state?: JobRow['state'];
  jobType?: string;
  sourceId?: string;
  limit: number;
  cursor?: string;
  order: 'asc' | 'desc';
}

/**
 * The states from which a job may be retried.
 *
 * `succeeded` is on the list on purpose: "poll that folder again" is the commonest reason anybody
 * presses retry on a source job, and a run that ended cleanly is exactly the one they mean. What
 * is *not* on the list is `running` and `queued`, which are refused with their own sentence below.
 */
const RETRYABLE_STATES: readonly JobRow['state'][] = [
  'succeeded',
  'failed',
  'cancelled',
  'dead',
  'waiting_review',
];

export class QueueService {
  constructor(private readonly recueil: Recueil) {}

  /**
   * A page of jobs, newest first.
   *
   * The cursor is the job id, which is a ULID and therefore sorts by creation time: no offset, so a
   * run inserting rows while an operator pages through the queue cannot make a row appear twice or
   * not at all.
   */
  list(filter: ListJobsFilter): { rows: JobRow[]; nextCursor: string | null } {
    const clauses = [inArray(schema.jobs.jobType, [...INGESTION_JOB_TYPES])];
    if (filter.state !== undefined) clauses.push(eq(schema.jobs.state, filter.state));
    if (filter.jobType !== undefined) clauses.push(eq(schema.jobs.jobType, filter.jobType));
    if (filter.sourceId !== undefined) {
      // `params` is JSON in a text column; the source is what an operator filters by, and a `like`
      // over the serialised key is both indexable-enough at this scale and exact enough not to
      // match another job's free text, because the key is quoted on both sides.
      clauses.push(like(schema.jobs.params, `%"sourceId":"${filter.sourceId}"%`));
    }
    if (filter.cursor !== undefined) {
      clauses.push(
        filter.order === 'asc' ? gt(schema.jobs.id, filter.cursor) : lt(schema.jobs.id, filter.cursor),
      );
    }

    const rows = this.recueil.db
      .select()
      .from(schema.jobs)
      .where(and(...clauses))
      .orderBy(filter.order === 'asc' ? asc(schema.jobs.id) : desc(schema.jobs.id))
      .limit(filter.limit + 1)
      .all();

    const page = rows.slice(0, filter.limit);
    const hasMore = rows.length > filter.limit;
    return { rows: page, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
  }

  get(id: string): JobRow {
    const row = this.recueil.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
    if (row === undefined) throw new NotFoundError('job', id);
    return row;
  }

  /** The job's own log lines, oldest first — `job_logs.id` is a ULID, so id order is append order. */
  logs(jobId: string, limit = 500): JobLogRow[] {
    return this.recueil.db
      .select()
      .from(schema.jobLogs)
      .where(eq(schema.jobLogs.jobId, jobId))
      .orderBy(asc(schema.jobLogs.id))
      .limit(limit)
      .all();
  }

  /**
   * The stage trace: one row per candidate per stage that finished, across every run asked for.
   *
   * Read from `ingest_checkpoints` with plain SQL rather than through a Drizzle table, because the
   * table belongs to `@recueil/ingest` and is installed by it; borrowing its definition here would
   * be a second declaration of the same columns and one of them would eventually be wrong.
   *
   * A pipeline run compacts a candidate's intermediate checkpoints once it commits, keeping the
   * terminal `commit` row — so a finished run shows one row per candidate and a run that stopped
   * halfway shows where it stopped, which is exactly the two questions asked of a trace.
   *
   * Several run ids rather than one because a source job is not a pipeline run: it owns however
   * many the polls under it minted, and a retried poll mints another. Showing one of them would
   * mean the detail view of a retried source job showed the *first* pass and called it the trace.
   * Every row carries the run that wrote it, so the passes stay distinguishable.
   */
  stageTrace(jobIds: readonly string[], limit = 2000): StageTraceRow[] {
    if (jobIds.length === 0) return [];
    const placeholders = jobIds.map(() => '?').join(', ');
    const rows = this.recueil.connection
      .prepare(
        `select run_id, candidate_key, stage, sha256, payload, created_at
         from ingest_checkpoints where run_id in (${placeholders})
         order by created_at, candidate_key limit ?`,
      )
      .all(...jobIds, limit) as {
      run_id: string;
      candidate_key: string;
      stage: string;
      sha256: string | null;
      payload: string;
      created_at: string;
    }[];

    return rows.map((row) => ({
      jobId: row.run_id,
      candidateKey: row.candidate_key,
      stage: row.stage,
      sha256: row.sha256,
      payload: parseJson(row.payload),
      createdAt: row.created_at,
    }));
  }

  /**
   * The review entries this run raised, queried from the queue.
   *
   * A run's own `result` also carries a count. The two are deliberately not the same source: the
   * detail view shows this list, and a caller comparing it with `result.counts.review` is doing a
   * real check rather than reading one number twice.
   */
  reviewEntryIds(jobId: string): string[] {
    return this.recueil.db
      .select({ id: reviewQueue.id })
      .from(reviewQueue)
      .where(eq(reviewQueue.jobId, jobId))
      .orderBy(asc(reviewQueue.createdAt))
      .all()
      .map((row) => row.id);
  }

  /** The child runs of a source job — the pipeline row it produced, when it produced one. */
  children(jobId: string): JobRow[] {
    return this.recueil.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.parentJobId, jobId))
      .orderBy(asc(schema.jobs.id))
      .all();
  }

  /** Whether a job is in a state from which a retry makes sense, and why not when it is not. */
  retryability(row: JobRow): { ok: boolean; detail: string } {
    if (row.state === 'running' || row.state === 'queued') {
      return {
        ok: false,
        detail: `The job is ${row.state}. Cancel it first, or wait for it to finish.`,
      };
    }
    // Every remaining member of `JOB_STATES` is on the list today, so this is the guard for a
    // state added to the vocabulary later: an unknown state is refused rather than retried on the
    // assumption that it is finished.
    if (!RETRYABLE_STATES.includes(row.state)) {
      return { ok: false, detail: `A job in state '${row.state}' cannot be retried.` };
    }
    return { ok: true, detail: '' };
  }

  /**
   * Record that an operator asked for a retry, without touching the job's state.
   *
   * The state transition belongs to whatever actually re-runs the work — `IngestionRunner`, for a
   * source poll — and doing it here as well would leave the row `queued` at the moment the runner
   * checks whether a run is already in flight, which is the one state that makes it refuse.
   */
  auditRetry(id: string, actor: Actor, reason?: string): JobRow {
    const row = this.get(id);
    this.recueil.audit.record({
      actor,
      action: 'job.retry_requested',
      entityType: 'job',
      entityId: id,
      before: { state: row.state, errorCode: row.errorCode },
      reason: reason ?? 'an operator retried the run',
    });
    return row;
  }

  /**
   * Mark a job as queued again.
   *
   * Only the bookkeeping: the caller starts the actual work. Used for a job nothing in this process
   * will re-run — an upload's own pipeline row — where leaving the row in its failed state would
   * hide that somebody asked. A retry keeps the job's idempotency key, which is what makes a re-run
   * *resume*: the pipeline's journal skips every candidate that already committed (P9, IK4).
   */
  markQueued(id: string, actor: Actor, reason?: string): JobRow {
    const row = this.get(id);
    const now = nowTimestamp();
    const patch = {
      state: 'queued' as const,
      runAfter: now,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      errorDetail: null,
      updatedAt: now,
    };
    this.recueil.db.transaction((tx) => {
      tx.update(schema.jobs).set(patch).where(eq(schema.jobs.id, id)).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'job.retried',
          entityType: 'job',
          entityId: id,
          before: { state: row.state, errorCode: row.errorCode },
          after: { state: 'queued' },
          reason: reason ?? 'an operator retried the run',
        },
        tx,
      );
    });
    return { ...row, ...patch };
  }

  /**
   * Cancel a job the running process is not executing.
   *
   * Used for a row left `running` by a process that died: there is no signal to deliver, so the row
   * is closed and the audit says why. A job this process *is* running is cancelled through
   * `IngestionRunner.cancel`, which aborts it and lets the run close its own row.
   */
  markCancelled(id: string, actor: Actor, reason?: string): JobRow {
    const row = this.get(id);
    const now = nowTimestamp();
    const patch = { state: 'cancelled' as const, finishedAt: now, updatedAt: now };
    this.recueil.db.transaction((tx) => {
      tx.update(schema.jobs).set(patch).where(eq(schema.jobs.id, id)).run();
      this.recueil.audit.record(
        {
          actor,
          action: 'job.cancelled',
          entityType: 'job',
          entityId: id,
          before: { state: row.state },
          after: { state: 'cancelled' },
          reason: reason ?? 'an operator cancelled a job this process was not running',
        },
        tx,
      );
    });
    return { ...row, ...patch };
  }
}

/** The wire shape of a job row. Typed by the published schema, so the two cannot drift. */
export const jobToWire = (row: JobRow): z.input<typeof IngestionJobSchema> => ({
  id: row.id,
  jobType: row.jobType,
  state: row.state,
  idempotencyKey: row.idempotencyKey,
  params: (parseJson(row.params) ?? {}) as Record<string, unknown>,
  priority: row.priority,
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  progress: { done: row.progressDone, total: row.progressTotal },
  runAfter: row.runAfter,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  heartbeatAt: row.heartbeatAt,
  result: row.result === null ? null : ((parseJson(row.result) ?? {}) as Record<string, unknown>),
  error:
    row.errorCode === null && row.errorMessage === null
      ? null
      : { code: row.errorCode ?? 'unknown', message: row.errorMessage ?? '' },
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const jobLogToWire = (row: JobLogRow): z.input<typeof JobLogEntrySchema> => ({
  id: row.id,
  loggedAt: row.loggedAt,
  level: row.level,
  message: row.message,
  data: row.data === null ? null : ((parseJson(row.data) ?? {}) as Record<string, unknown>),
  subjectType: row.subjectType,
  subjectId: row.subjectId,
});

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
