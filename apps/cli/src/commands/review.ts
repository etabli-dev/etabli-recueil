/**
 * `recueil review` — the queue P3 fills.
 *
 * "Flag, never guess" is only a principle if there is somewhere for the flags to go and a way to
 * work through them. The pipeline's confidence gate puts a row in `review_queue` with a reason
 * code, a sentence a person can read, and — for the common case — exactly the proposal that
 * accepting will execute. This command lists those rows, executes one, and rejects one.
 *
 * Accepting is a write to the library and goes through `CliReviewQueue` in `src/review.ts`; the
 * header of that file says what it duplicates and what should replace it.
 *
 * `accept` is deliberately not "accept everything that looks fine". It takes ids, or `--all` with
 * a filter, and it prints what each one did — because the whole point of the queue is that a person
 * looked, and a command that emptied it in one keystroke would defeat the mechanism it serves.
 */
import { NotFoundError, RecueilError } from '@recueil/core';
import type { ReviewQueueRow } from '@recueil/ingest';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, withLibrary, type LibraryFlags } from '../library.js';
import { CliReviewQueue } from '../review.js';
import { count, renderTable } from '../table.js';
import type { Ui } from '../ui.js';

const STATUSES = ['open', 'accepted', 'rejected', 'superseded'] as const;
const SEVERITIES = ['info', 'warning', 'blocker'] as const;

type Status = (typeof STATUSES)[number];
type Severity = (typeof SEVERITIES)[number];

export interface ReviewListFlags extends LibraryFlags {
  status?: Status;
  reason?: string;
  severity?: Severity;
  subject?: string;
  job?: string;
  limit?: number;
  full?: boolean;
}

export interface ReviewActionFlags extends LibraryFlags {
  note?: string;
  all?: boolean;
  reason?: string;
  severity?: Severity;
  limit?: number;
}

const parseStatus = (value: string): Status => {
  if (!(STATUSES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`expected one of ${STATUSES.join(', ')}.`);
  }
  return value as Status;
};

const parseSeverity = (value: string): Severity => {
  if (!(SEVERITIES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`expected one of ${SEVERITIES.join(', ')}.`);
  }
  return value as Severity;
};

const parsePositiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('expected a positive integer.');
  return parsed;
};

const toWire = (row: ReviewQueueRow): Record<string, unknown> => ({
  id: row.id,
  subjectType: row.subjectType,
  subjectId: row.subjectId,
  reasonCode: row.reasonCode,
  explanation: row.explanation,
  proposedAction: row.proposedAction,
  proposedPayload: row.proposedPayload === null ? null : (JSON.parse(row.proposedPayload) as unknown),
  confidence: row.confidence,
  severity: row.severity,
  status: row.status,
  sourceStage: row.sourceStage,
  jobId: row.jobId,
  createdAt: row.createdAt,
  resolvedAt: row.resolvedAt,
  resolutionNote: row.resolutionNote,
});

/* ------------------------------------------------------------------------------------------- */

export const runReviewList = async (flags: ReviewListFlags, ui: Ui): Promise<void> => {
  const location = resolveLibraryLocation(flags);

  await withLibrary(location, { mustExist: true }, async (recueil) => {
    const queue = new CliReviewQueue(recueil);
    const rows = queue.list({
      status: flags.status ?? 'open',
      ...(flags.reason === undefined ? {} : { reasonCode: flags.reason }),
      ...(flags.severity === undefined ? {} : { severity: flags.severity }),
      ...(flags.subject === undefined ? {} : { subjectId: flags.subject }),
      ...(flags.job === undefined ? {} : { jobId: flags.job }),
      ...(flags.limit === undefined ? {} : { limit: flags.limit }),
    });

    if (ui.json) {
      ui.outJson({ command: 'review.list', open: queue.openCounts(), entries: rows.map(toWire) });
      return undefined;
    }

    const counts = queue.openCounts();
    if (rows.length === 0) {
      ui.out(`Nothing to review (${count(counts.blocker)} blocker, ${count(counts.warning)} warning, ${count(counts.info)} info open).`);
      return undefined;
    }

    ui.out('');
    for (const line of renderTable(
      [
        { header: 'Id' },
        { header: 'Sev' },
        { header: 'Reason' },
        { header: 'Conf.', align: 'right' },
        { header: 'Action' },
        { header: 'Why' },
      ],
      rows.map((row) => [
        flags.full === true ? row.id : row.id.slice(0, 10),
        row.severity,
        row.reasonCode,
        row.confidence === null ? '—' : row.confidence.toFixed(2),
        row.proposedAction ?? 'none',
        flags.full === true ? row.explanation : row.explanation.slice(0, 80),
      ]),
    )) {
      ui.out(`  ${line}`);
    }
    ui.out('');
    ui.out(
      `  ${count(counts.blocker)} blocker · ${count(counts.warning)} warning · ${count(counts.info)} info open.`,
    );
    ui.out(`  ${ui.colour.dim('recueil review accept <id>  ·  recueil review reject <id> --note "…"')}`);
    ui.out('');
    return undefined;
  });
};

/**
 * Resolve the ids an action was given: the arguments, or `--all` over the filter.
 *
 * An id that names nothing is a typo, not a bug in Recueil, so it comes back as a `CliError` with
 * exit code 1 rather than as an unhandled `NotFoundError` with a stack trace under it. An id that
 * names an entry which is no longer open is *found* here and refused later, by name and status,
 * because "you already accepted that" and "there is no such entry" are different mistakes.
 */
const targets = (
  queue: CliReviewQueue,
  ids: readonly string[],
  flags: ReviewActionFlags,
): ReviewQueueRow[] => {
  if (ids.length > 0) {
    const open = queue.list({ status: 'open', limit: 1000 });
    return ids.map((id) => {
      const matches = open.filter((row) => row.id === id || row.id.startsWith(id));
      if (matches.length > 1) {
        throw new CliError(`'${id}' matches ${String(matches.length)} open entries.`, {
          exitCode: ExitCode.Usage,
          detail: ['', ...matches.map((row) => `  ${row.id}  ${row.reasonCode}`)],
          payload: { error: 'ambiguous_entry', id, matches: matches.map((row) => row.id) },
        });
      }
      if (matches.length === 1) return matches[0]!;

      try {
        // Not necessarily missing: it may be resolved already, and `get` distinguishes the two.
        return queue.get(id);
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new CliError(`no review queue entry with id '${id}'.`, {
            exitCode: ExitCode.Usage,
            detail: ['', '  `recueil review list` shows the entries this library holds.'],
            payload: { error: 'no_such_entry', id },
            cause: error,
          });
        }
        throw error;
      }
    });
  }

  if (flags.all !== true) {
    throw new CliError('give at least one entry id, or --all with a filter.', {
      exitCode: ExitCode.Usage,
      detail: [
        '',
        '  recueil review accept 01M0T5…',
        '  recueil review accept --all --reason low_confidence_metadata',
        '',
        '  --all on its own is accepted, and it does mean every open entry. The queue exists so',
        '  that a person looks; emptying it unread is a decision, not a default.',
      ],
    });
  }

  return queue.list({
    status: 'open',
    ...(flags.reason === undefined ? {} : { reasonCode: flags.reason }),
    ...(flags.severity === undefined ? {} : { severity: flags.severity }),
    ...(flags.limit === undefined ? {} : { limit: flags.limit }),
  });
};

export const runReviewAccept = async (ids: readonly string[], flags: ReviewActionFlags, ui: Ui): Promise<void> => {
  const location = resolveLibraryLocation(flags);

  await withLibrary(location, { mustExist: true }, async (recueil) => {
    const queue = new CliReviewQueue(recueil);
    const rows = targets(queue, ids, flags);

    const accepted: Array<{ id: string; itemId: string | null; attachmentId: string | null; warnings: string[] }> = [];
    const refused: Array<{ id: string; reason: string }> = [];

    for (const row of rows) {
      try {
        // Each entry in its own transaction, deliberately: a hundred scans accepted at once should
        // not all be rolled back because the fiftieth hits a duplicate ASN.
        const result = queue.accept(row.id, {
          actor: recueil.actor,
          ...(flags.note === undefined ? {} : { note: flags.note }),
        });
        accepted.push({
          id: row.id,
          itemId: result.itemId,
          attachmentId: result.attachmentId,
          warnings: result.warnings,
        });
      } catch (error) {
        refused.push({ id: row.id, reason: reasonOf(error) });
      }
    }

    if (ui.json) {
      ui.outJson({ command: 'review.accept', accepted, refused });
    } else {
      ui.out('');
      for (const entry of accepted) {
        ui.out(
          entry.itemId === null
            ? `  ${entry.id} accepted; nothing was filed (the proposal was a discard).`
            : `  ${entry.id} accepted — item ${entry.itemId}, attachment ${entry.attachmentId}.`,
        );
        for (const warning of entry.warnings) ui.out(`    ${ui.colour.yellow('note')} ${warning}`);
      }
      for (const entry of refused) {
        ui.out(`  ${ui.colour.red('refused')} ${entry.id}: ${entry.reason}`);
      }
      ui.out('');
    }

    if (refused.length > 0) process.exitCode = ExitCode.JobFailed;
    return undefined;
  });
};

export const runReviewReject = async (ids: readonly string[], flags: ReviewActionFlags, ui: Ui): Promise<void> => {
  const location = resolveLibraryLocation(flags);

  await withLibrary(location, { mustExist: true }, async (recueil) => {
    const queue = new CliReviewQueue(recueil);
    const rows = targets(queue, ids, flags);

    const rejected: string[] = [];
    const refused: Array<{ id: string; reason: string }> = [];

    for (const row of rows) {
      try {
        queue.reject(row.id, {
          actor: recueil.actor,
          ...(flags.note === undefined ? {} : { note: flags.note }),
        });
        rejected.push(row.id);
      } catch (error) {
        refused.push({ id: row.id, reason: reasonOf(error) });
      }
    }

    if (ui.json) {
      ui.outJson({ command: 'review.reject', rejected, refused });
    } else {
      ui.out('');
      for (const id of rejected) {
        ui.out(`  ${id} rejected. Nothing was created, and the document is still in the library.`);
      }
      for (const entry of refused) ui.out(`  ${ui.colour.red('refused')} ${entry.id}: ${entry.reason}`);
      ui.out('');
    }

    if (refused.length > 0) process.exitCode = ExitCode.JobFailed;
    return undefined;
  });
};

const reasonOf = (error: unknown): string =>
  error instanceof RecueilError || error instanceof Error ? error.message : String(error);

/* ------------------------------------------------------------------------------------------- */

export const registerReview = (
  parent: Command,
  describe: (name: string) => string,
  ui: () => Ui,
): Command => {
  const command = parent
    .command('review')
    .description(describe('review'))
    .addHelpText(
      'after',
      [
        '',
        'The pipeline routes anything it is not confident enough to file into `review_queue` with a',
        'reason code, an explanation and the proposal accepting will execute (P3,',
        'spec/data-model.md §6.1). This command works that queue on the library directly.',
        '',
        'This build can execute three of the seven proposed actions — create_item, discard and none.',
        'The other four are refused by name rather than marked accepted and quietly skipped.',
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
      .description('List review queue entries, oldest first')
      .option('--status <status>', `open, accepted, rejected or superseded (default open)`, parseStatus)
      .option('--reason <code>', 'only this reason code, e.g. low_confidence_metadata')
      .option('--severity <severity>', `info, warning or blocker`, parseSeverity)
      .option('--subject <id>', 'only entries about this document')
      .option('--job <id>', 'only entries raised by this job')
      .option('--limit <n>', 'how many to show', parsePositiveInteger)
      .option('--full', 'print whole ids and whole explanations', false),
  ).action(async (flags: ReviewListFlags) => {
    await runReviewList(flags, ui());
  });

  withLibraryFlags(
    command
      .command('accept')
      .description("Execute an entry's proposal and close it")
      .argument('[id...]', 'entry ids, or unique prefixes of them')
      .option('--all', 'every open entry matching the filters below', false)
      .option('--reason <code>', 'with --all: only this reason code')
      .option('--severity <severity>', 'with --all: only this severity', parseSeverity)
      .option('--limit <n>', 'with --all: at most this many', parsePositiveInteger)
      .option('--note <text>', 'stored on the entry and on the audit row'),
  ).action(async (ids: string[], flags: ReviewActionFlags) => {
    await runReviewAccept(ids, flags, ui());
  });

  withLibraryFlags(
    command
      .command('reject')
      .description('Close an entry without executing its proposal')
      .argument('[id...]', 'entry ids, or unique prefixes of them')
      .option('--all', 'every open entry matching the filters below', false)
      .option('--reason <code>', 'with --all: only this reason code')
      .option('--severity <severity>', 'with --all: only this severity', parseSeverity)
      .option('--limit <n>', 'with --all: at most this many', parsePositiveInteger)
      .option('--note <text>', 'stored on the entry and on the audit row'),
  ).action(async (ids: string[], flags: ReviewActionFlags) => {
    await runReviewReject(ids, flags, ui());
  });

  command.action(() => {
    command.help({ error: true });
  });

  return command;
};
