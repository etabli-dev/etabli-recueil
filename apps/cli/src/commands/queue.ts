/**
 * `recueil queue` — the work queue of ADR-0010.
 *
 * Every long-running operation in Recueil is a `jobs` row: an ingest run, a Zotero migration, a
 * Paperless import, a source poll. This command lists them, retries one, and cancels one, over the
 * library directly, the same way `import`, `export`, `backup` and `restore` do.
 *
 * Two things about retry and cancel that are easy to get wrong and are therefore explicit here.
 *
 * **Retrying is re-queueing, not re-running.** A job is picked up by whatever runs jobs — the
 * server's runner, or the command that owns that job type — and this command's part is to put the
 * row back in a state that will be picked up: `queued`, no lease, no worker, the error cleared and
 * the cursor *kept*, because the cursor is what makes the second attempt resume rather than start
 * over (IK4). A `running` job is refused rather than re-queued: it may have a live worker on it,
 * and two workers on one job is the failure mode the lease exists to prevent.
 *
 * **Cancelling does not undo.** It marks the row `cancelled` so nothing picks it up again; whatever
 * the job already committed stays committed, because every one of these jobs commits incrementally
 * and there is no transaction spanning the run to roll back. The message says so.
 */
import { nowTimestamp, schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import { and, desc, eq } from 'drizzle-orm';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, withLibrary, type LibraryFlags } from '../library.js';
import { count, duration, renderTable } from '../table.js';
import type { Ui } from '../ui.js';

type JobRow = typeof schema.jobs.$inferSelect;

const JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'waiting_review',
  'dead',
] as const;

type JobState = (typeof JOB_STATES)[number];

/**
 * The states a job may be retried from.
 *
 * `succeeded` is on the list on purpose — "poll that folder again" is the commonest reason anybody
 * retries a source job. `queued` and `running` are not: one is already waiting, and the other may
 * have a worker holding its lease.
 */
const RETRYABLE: readonly JobState[] = ['succeeded', 'failed', 'cancelled', 'dead', 'waiting_review'];

/** The states a job may be cancelled from. A finished job has nothing left to cancel. */
const CANCELLABLE: readonly JobState[] = ['queued', 'running', 'waiting_review'];

export interface QueueListFlags extends LibraryFlags {
  state?: JobState;
  type?: string;
  limit?: number;
  full?: boolean;
}

export interface QueueActionFlags extends LibraryFlags {
  note?: string;
}

const parseState = (value: string): JobState => {
  if (!(JOB_STATES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`expected one of ${JOB_STATES.join(', ')}.`);
  }
  return value as JobState;
};

const parsePositiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('expected a positive integer.');
  return parsed;
};

const listJobs = (recueil: Recueil, flags: QueueListFlags): JobRow[] => {
  const clauses = [];
  if (flags.state !== undefined) clauses.push(eq(schema.jobs.state, flags.state));
  if (flags.type !== undefined) clauses.push(eq(schema.jobs.jobType, flags.type));

  const query = recueil.db.select().from(schema.jobs);
  const filtered = clauses.length === 0 ? query : query.where(and(...clauses));
  return filtered
    .orderBy(desc(schema.jobs.createdAt))
    .limit(flags.limit ?? 50)
    .all();
};

/** A job by id, or by an unambiguous prefix of one — a ULID is 26 characters and nobody types it. */
const findJob = (recueil: Recueil, reference: string): JobRow => {
  const exact = recueil.db.select().from(schema.jobs).where(eq(schema.jobs.id, reference)).get();
  if (exact !== undefined) return exact;

  const matches = recueil.connection
    .prepare(`select id from jobs where id like ? limit 5`)
    .all(`${reference}%`) as { id: string }[];

  if (matches.length === 0) {
    throw new CliError(`no job with id '${reference}'.`, {
      exitCode: ExitCode.Usage,
      detail: ['', '  `recueil queue list` shows the jobs this library holds.'],
      payload: { error: 'no_such_job', id: reference },
    });
  }
  if (matches.length > 1) {
    throw new CliError(`'${reference}' matches ${String(matches.length)} jobs.`, {
      exitCode: ExitCode.Usage,
      detail: ['', ...matches.map((match) => `  ${match.id}`)],
      payload: { error: 'ambiguous_job', id: reference, matches: matches.map((match) => match.id) },
    });
  }

  const row = recueil.db.select().from(schema.jobs).where(eq(schema.jobs.id, matches[0]!.id)).get();
  if (row === undefined) throw new CliError(`no job with id '${reference}'.`, { exitCode: ExitCode.Usage });
  return row;
};

const progressOf = (row: JobRow): string =>
  row.progressTotal === null
    ? count(row.progressDone)
    : `${count(row.progressDone)}/${count(row.progressTotal)}`;

const elapsedOf = (row: JobRow): string => {
  if (row.startedAt === null) return '—';
  const end = row.finishedAt === null ? Date.now() : Date.parse(row.finishedAt);
  return duration(end - Date.parse(row.startedAt));
};

const toWire = (row: JobRow): Record<string, unknown> => ({
  id: row.id,
  jobType: row.jobType,
  state: row.state,
  idempotencyKey: row.idempotencyKey,
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  progressDone: row.progressDone,
  progressTotal: row.progressTotal,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  errorCode: row.errorCode,
  errorMessage: row.errorMessage,
  cursor: row.cursor,
});

/* ------------------------------------------------------------------------------------------- */

export const runQueueList = async (flags: QueueListFlags, ui: Ui): Promise<void> => {
  const location = resolveLibraryLocation(flags);

  await withLibrary(location, { mustExist: true }, async (recueil) => {
    const rows = listJobs(recueil, flags);

    if (ui.json) {
      ui.outJson({ command: 'queue.list', jobs: rows.map(toWire) });
      return undefined;
    }

    if (rows.length === 0) {
      ui.out('No jobs match.');
      return undefined;
    }

    ui.out('');
    for (const line of renderTable(
      [
        { header: 'Id' },
        { header: 'Type' },
        { header: 'State' },
        { header: 'Progress', align: 'right' },
        { header: 'Attempts', align: 'right' },
        { header: 'Elapsed', align: 'right' },
        { header: 'Error' },
      ],
      rows.map((row) => [
        flags.full === true ? row.id : row.id.slice(0, 10),
        row.jobType,
        row.state,
        progressOf(row),
        `${String(row.attempts)}/${String(row.maxAttempts)}`,
        elapsedOf(row),
        row.errorMessage === null ? '—' : row.errorMessage.slice(0, 60),
      ]),
    )) {
      ui.out(`  ${line}`);
    }
    ui.out('');
    return undefined;
  });
};

export const runQueueRetry = async (references: readonly string[], flags: QueueActionFlags, ui: Ui): Promise<void> => {
  const location = resolveLibraryLocation(flags);

  await withLibrary(location, { mustExist: true }, async (recueil) => {
    const retried: Array<{ id: string; from: JobState }> = [];
    const refused: Array<{ id: string; reason: string }> = [];

    for (const reference of references) {
      const row = findJob(recueil, reference);
      if (!RETRYABLE.includes(row.state)) {
        refused.push({
          id: row.id,
          reason:
            row.state === 'running'
              ? 'it is running: a worker may hold its lease, and two workers on one job is what the lease prevents'
              : `it is ${row.state}, and only ${RETRYABLE.join(', ')} jobs can be retried`,
        });
        continue;
      }

      const now = nowTimestamp();
      recueil.db
        .update(schema.jobs)
        .set({
          state: 'queued',
          runAfter: now,
          startedAt: null,
          finishedAt: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          workerId: null,
          errorCode: null,
          errorMessage: null,
          errorDetail: null,
          // `attempts` must stay within `max_attempts` (ck_jobs_attempts), and a retry is a new
          // attempt the operator asked for, so the ceiling is lifted rather than the count reset:
          // the history of how often this job has run is a fact and is not rewritten.
          maxAttempts: Math.max(row.maxAttempts, row.attempts + 1),
          updatedAt: now,
        })
        .where(eq(schema.jobs.id, row.id))
        .run();

      recueil.audit.record({
        actor: recueil.actor,
        action: 'job.retried',
        entityType: 'job',
        entityId: row.id,
        before: { state: row.state, attempts: row.attempts },
        after: { state: 'queued' },
        reason: flags.note ?? 'retried from the command line',
      });

      retried.push({ id: row.id, from: row.state });
    }

    report(ui, 'queue.retry', retried, refused, (entry) =>
      `  ${entry.id} was ${entry.from} and is queued again; its cursor was kept, so it resumes.`,
    );
    return undefined;
  });
};

export const runQueueCancel = async (references: readonly string[], flags: QueueActionFlags, ui: Ui): Promise<void> => {
  const location = resolveLibraryLocation(flags);

  await withLibrary(location, { mustExist: true }, async (recueil) => {
    const cancelled: Array<{ id: string; from: JobState }> = [];
    const refused: Array<{ id: string; reason: string }> = [];

    for (const reference of references) {
      const row = findJob(recueil, reference);
      if (!CANCELLABLE.includes(row.state)) {
        refused.push({ id: row.id, reason: `it is already ${row.state}; there is nothing left to cancel` });
        continue;
      }

      const now = nowTimestamp();
      recueil.db
        .update(schema.jobs)
        .set({
          state: 'cancelled',
          finishedAt: now,
          leaseExpiresAt: null,
          workerId: null,
          updatedAt: now,
        })
        .where(eq(schema.jobs.id, row.id))
        .run();

      recueil.audit.record({
        actor: recueil.actor,
        action: 'job.cancelled',
        entityType: 'job',
        entityId: row.id,
        before: { state: row.state },
        after: { state: 'cancelled' },
        reason: flags.note ?? 'cancelled from the command line',
      });

      cancelled.push({ id: row.id, from: row.state });
    }

    report(ui, 'queue.cancel', cancelled, refused, (entry) =>
      `  ${entry.id} was ${entry.from} and is cancelled. Anything it had already committed stays committed.`,
    );
    return undefined;
  });
};

const report = (
  ui: Ui,
  command: string,
  done: ReadonlyArray<{ id: string; from: JobState }>,
  refused: ReadonlyArray<{ id: string; reason: string }>,
  line: (entry: { id: string; from: JobState }) => string,
): void => {
  if (ui.json) {
    ui.outJson({ command, changed: done, refused });
  } else {
    ui.out('');
    for (const entry of done) ui.out(line(entry));
    for (const entry of refused) ui.out(`  ${ui.colour.yellow('refused')} ${entry.id}: ${entry.reason}`);
    ui.out('');
  }
  if (refused.length > 0) process.exitCode = ExitCode.Usage;
};

/* ------------------------------------------------------------------------------------------- */

export const registerQueue = (
  parent: Command,
  describe: (name: string) => string,
  ui: () => Ui,
): Command => {
  const command = parent
    .command('queue')
    .description(describe('queue'))
    .addHelpText(
      'after',
      [
        '',
        'Every long-running operation is a row in `jobs` (ADR-0010): an ingest run, a migration, a',
        'source poll. This command reads and writes that table on the library directly.',
        '',
        'An id may be given as a unique prefix.',
      ].join('\n'),
    );

  const withLibraryFlags = (child: Command): Command =>
    child
      .option('-d, --database <url>', 'the library to read (RECUEIL_DATABASE_URL)')
      .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)');

  withLibraryFlags(
    command
      .command('list')
      .description('List the jobs in the queue, newest first')
      .option('--state <state>', `only this state: ${JOB_STATES.join(', ')}`, parseState)
      .option('--type <type>', 'only this job type, e.g. ingest.run')
      .option('--limit <n>', 'how many to show', parsePositiveInteger)
      .option('--full', 'print whole job ids rather than a prefix', false),
  ).action(async (flags: QueueListFlags) => {
    await runQueueList(flags, ui());
  });

  withLibraryFlags(
    command
      .command('retry')
      .description('Put a finished or failed job back in the queue')
      .argument('<id...>', 'job ids, or unique prefixes of them')
      .option('--note <text>', 'recorded on the audit row'),
  ).action(async (ids: string[], flags: QueueActionFlags) => {
    await runQueueRetry(ids, flags, ui());
  });

  withLibraryFlags(
    command
      .command('cancel')
      .description('Stop a queued or running job from being picked up again')
      .argument('<id...>', 'job ids, or unique prefixes of them')
      .option('--note <text>', 'recorded on the audit row'),
  ).action(async (ids: string[], flags: QueueActionFlags) => {
    await runQueueCancel(ids, flags, ui());
  });

  command.action(() => {
    command.help({ error: true });
  });

  return command;
};
