/**
 * `recueil import paperless` (CONCEPT.md §6, §7 Phase 2).
 *
 * Phase 2's exit criterion is "Paperless decommissioned after verified import", so this command's
 * job is the same as `import zotero`'s: run the migration, and put the verdict in front of the
 * person about to delete something. The same three rules hold, for the same reasons.
 *
 * - **The report is written to disk and summarised on stdout**, and the table is rendered from the
 *   report, so the number a person reads and the number a test asserts against are one number.
 * - **The exit code carries the verdict.** Non-zero when parity fails, because a shell script that
 *   carries on to `docker compose down paperless` after a failed parity check is the accident this
 *   criterion exists to prevent.
 * - **A dry run is a real run** against a consistent copy of the library and a store that hashes
 *   and discards, because "what would this do to *my* library" cannot be answered against an empty
 *   one.
 *
 * One thing this command must not overstate. `@recueil/import-paperless` has never spoken to a real
 * Paperless-ngx server: it was transcribed from the published source of the release it names, and
 * its tests run against an in-process fake of that. The report says which version it modelled and
 * whether the server that answered agrees, and the summary below prints that line rather than
 * hiding it, because it is the fact that tells a reader how much of the report is a claim about
 * their server rather than about the fake.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MEMORY_DATABASE, createBackup, createRecueil } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { JOB_TYPE, importPaperless } from '@recueil/import-paperless';
import type { PaperlessImportOptions, PaperlessImportReport } from '@recueil/import-paperless';
import { schema } from '@recueil/core';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import { eq } from 'drizzle-orm';

import { DryRunStorage } from '../dry-run-storage.js';
import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, withLibrary, type LibraryFlags, type ResolvedLibrary } from '../library.js';
import { Progress } from '../progress.js';
import { count, duration, renderTable } from '../table.js';
import type { Ui } from '../ui.js';

export interface PaperlessFlags extends LibraryFlags {
  url?: string;
  token?: string;
  apiVersion?: string;
  pageSize?: number;
  dryRun?: boolean;
  resume?: boolean;
  report?: string | false;
  runLabel?: string;
  originals?: boolean;
  currency?: string;
  correspondent?: string;
  progress?: boolean;
  timeout?: number;
}

const DEFAULT_REPORT_DIRECTORY = './paperless-import';

const parsePositiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('expected a positive integer.');
  return parsed;
};

/** The token, from the flag or from the environment. Never from an argument, so it stays off `ps`. */
const resolveToken = (flags: PaperlessFlags, env: NodeJS.ProcessEnv): string => {
  const token = flags.token ?? env['PAPERLESS_TOKEN'];
  if (token === undefined || token.length === 0) {
    throw new CliError('no Paperless-ngx API token.', {
      exitCode: ExitCode.Auth,
      detail: [
        '',
        '  Pass --token, or set PAPERLESS_TOKEN. A token is created in Paperless under',
        "  Settings → My Profile, and this importer only ever reads: it issues GET requests and",
        '  nothing else.',
      ],
      payload: { error: 'no_token' },
    });
  }
  return token;
};

const resolveUrl = (flags: PaperlessFlags, env: NodeJS.ProcessEnv): string => {
  const url = flags.url ?? env['PAPERLESS_URL'];
  if (url === undefined || url.length === 0) {
    throw new CliError('no Paperless-ngx URL.', {
      exitCode: ExitCode.Usage,
      detail: ['', '  Pass --url https://paperless.example, or set PAPERLESS_URL.'],
      payload: { error: 'no_url' },
    });
  }
  return url;
};

/** An interrupted run of this import, if there is one, so `--resume` can be demanded rather than assumed. */
interface Interrupted {
  jobId: string;
  stage: string;
  index: number;
  attempts: number;
}

export const findInterruptedImport = (recueil: Recueil, baseUrl: string): Interrupted | null => {
  const rows = recueil.db.select().from(schema.jobs).where(eq(schema.jobs.jobType, JOB_TYPE)).all();

  for (const row of rows) {
    if (row.state === 'succeeded' || row.cursor === null) continue;

    let recorded: unknown;
    try {
      recorded = (JSON.parse(row.params) as { baseUrl?: unknown }).baseUrl;
    } catch {
      continue;
    }
    if (typeof recorded !== 'string' || !sameServer(recorded, baseUrl)) continue;

    let cursor: { stage?: unknown; index?: unknown } = {};
    try {
      cursor = JSON.parse(row.cursor) as { stage?: unknown; index?: unknown };
    } catch {
      cursor = {};
    }

    return {
      jobId: row.id,
      stage: typeof cursor.stage === 'string' ? cursor.stage : 'unknown',
      index: typeof cursor.index === 'number' ? cursor.index : 0,
      attempts: row.attempts,
    };
  }
  return null;
};

/** Two URLs naming the same server, ignoring a trailing slash and an `/api` suffix. */
const sameServer = (left: string, right: string): boolean => normalise(left) === normalise(right);

const normalise = (url: string): string => url.replace(/\/+$/u, '').replace(/\/api$/u, '');

/* ------------------------------------------------------------------------------------------- */
/* Reporting                                                                                     */
/* ------------------------------------------------------------------------------------------- */

const parityTable = (report: PaperlessImportReport): string[] =>
  renderTable(
    [
      { header: 'Paperless type' },
      { header: 'Recueil type' },
      { header: 'Paperless', align: 'right' },
      { header: 'Recueil', align: 'right' },
      { header: 'Mistyped', align: 'right' },
      { header: 'Δ', align: 'right' },
    ],
    [
      ...report.documents.byDocumentType.map((row) => [
        row.paperlessName ?? '(none)',
        row.recueilItemType,
        count(row.paperlessTotal),
        count(row.recueilTotal),
        count(row.recueilMistyped),
        row.delta === 0 ? '0' : row.delta > 0 ? `+${String(row.delta)}` : String(row.delta),
      ]),
      [
        'all documents',
        '',
        count(report.documents.apiReportedTotal),
        count(report.documents.recueilMatched),
        count(report.documents.recueilMistyped),
        report.documents.delta === 0 ? '0' : String(report.documents.delta),
      ],
    ],
  );

const short = (value: number | string): string => {
  const text = String(value);
  return /^[0-9a-f]{32,}$/u.test(text) ? `${text.slice(0, 12)}…` : text;
};

const checksTable = (report: PaperlessImportReport): string[] =>
  renderTable(
    [{ header: 'Check' }, { header: 'Expected', align: 'right' }, { header: 'Actual', align: 'right' }, { header: 'Result' }],
    report.checks.map((check) => [
      check.name,
      short(check.expected),
      short(check.actual),
      check.pass ? 'pass' : check.blocking ? 'FAIL' : 'note',
    ]),
  );

const printSummary = (
  report: PaperlessImportReport,
  ui: Ui,
  context: { dryRun: boolean; reportPaths: { json: string; markdown: string; review: string } | null },
): void => {
  const { bold, dim, green, red, yellow } = ui.colour;

  ui.out('');
  ui.out(bold(context.dryRun ? 'Paperless-ngx import — dry run' : 'Paperless-ngx import'));
  ui.out('');
  for (const line of parityTable(report)) ui.out(`  ${line}`);
  ui.out('');
  for (const line of checksTable(report)) ui.out(`  ${line}`);
  ui.out('');

  const originals = report.originals;
  ui.out(
    `  originals        ${count(originals.stored)}/${count(originals.attempted)} stored, ` +
      `${count(originals.missing)} missing, ${count(originals.checksumMismatches)} checksum mismatch(es)`,
  );
  ui.out(
    `  metadata         correspondents ${count(report.correspondents.recueilDistinct)} · ` +
      `document types ${count(report.documentTypes.recueilWithOfficeType)} · tags ${count(report.tags.recueilTotal)} · ` +
      `custom fields ${count(report.customFields.recueilDefined)}`,
  );
  ui.out(
    `  asn              ${count(report.asn.recueilWithAsn)} written, ` +
      `${count(report.asn.collisions.length)} collision(s), unique: ${report.asn.unique ? 'yes' : 'NO'}`,
  );
  ui.out(`  notes            ${count(report.notes.recueilTotal)} of ${count(report.notes.apiTotal)}`);
  ui.out(`  duration         ${duration(report.run.durationMs)}`);

  if (report.skipped.length > 0) ui.out(`  skipped          ${count(report.skipped.length)} records — see the report`);
  if (report.notCarried.length > 0) {
    ui.out(`  not carried      ${count(report.notCarried.length)} field(s) the model has no place for`);
  }
  if (report.review.length > 0) {
    ui.out(
      `  ${yellow('review')}           ${count(report.review.length)} entries need a decision` +
        (context.reportPaths === null ? '' : ` — ${context.reportPaths.review}`),
    );
  }

  ui.out('');
  ui.out(
    dim(
      `  The client was written against Paperless-ngx ${report.source.modelledAgainstVersion}; this ` +
        `server reports ${report.source.serverVersion ?? '(no X-Version header)'}` +
        `${report.source.versionMatchesModel ? '.' : ' — the mapping is unproven against it.'}`,
    ),
  );

  ui.out('');
  ui.out(
    report.pass
      ? `  ${green('PASS')} — document counts match and nothing was dropped unaccounted for.`
      : `  ${red('FAIL')} — the parity check did not pass. Do not decommission Paperless.`,
  );

  if (context.reportPaths !== null) {
    ui.out('');
    ui.out(dim(`  report  ${context.reportPaths.json}`));
    ui.out(dim(`          ${context.reportPaths.markdown}`));
  }
  if (context.dryRun) {
    ui.out('');
    ui.out(dim('  Nothing was written: this was a dry run against a consistent copy of the library.'));
  }
  ui.out('');
};

export const exitCodeFor = (report: PaperlessImportReport): number => {
  const blocking = report.checks.filter((check) => check.blocking && !check.pass);
  if (!report.pass || blocking.length > 0) return ExitCode.JobFailed;
  return report.review.length > 0 ? ExitCode.Review : ExitCode.Success;
};

/* ------------------------------------------------------------------------------------------- */

const runAgainst = async (
  recueil: Recueil,
  flags: PaperlessFlags,
  ui: Ui,
  context: { baseUrl: string; token: string; reportDirectory: string | null },
): Promise<PaperlessImportReport> => {
  const progress = new Progress(ui, { enabled: flags.progress !== false });

  const options: PaperlessImportOptions = {
    baseUrl: context.baseUrl,
    token: context.token,
    ...(flags.apiVersion === undefined ? {} : { apiVersion: flags.apiVersion }),
    ...(flags.pageSize === undefined ? {} : { pageSize: flags.pageSize }),
    ...(flags.timeout === undefined ? {} : { timeoutMs: flags.timeout }),
    ...(flags.runLabel === undefined ? {} : { runLabel: flags.runLabel }),
    ...(flags.currency === undefined ? {} : { defaultCurrency: flags.currency }),
    ...(flags.correspondent === undefined ? {} : { missingCorrespondentLabel: flags.correspondent }),
    ...(flags.originals === false ? { downloadOriginals: false } : {}),
    reportDirectory: context.reportDirectory,
    abortAfter: (state) => {
      progress.update({ label: state.stage, done: state.index, total: state.total });
      return false;
    },
  };

  try {
    const { report } = await importPaperless(recueil, options);
    return report;
  } finally {
    progress.finish();
  }
};

export const runImportPaperless = async (flags: PaperlessFlags, ui: Ui): Promise<void> => {
  const baseUrl = resolveUrl(flags, process.env);
  const token = resolveToken(flags, process.env);
  const location = resolveLibraryLocation(flags);
  const reportDirectory = flags.report === false ? null : resolve(flags.report ?? DEFAULT_REPORT_DIRECTORY);

  ui.info(`paperless  ${baseUrl}`);
  ui.info(`library    ${location.databaseUrl} (${location.origin.database})`);
  ui.info(`storage    ${location.storagePath} (${location.origin.storage})`);
  ui.info(`report     ${reportDirectory ?? '(not written)'}`);
  ui.info('');

  if (flags.dryRun === true) {
    const report = await dryRun(flags, ui, location, { baseUrl, token, reportDirectory });
    finish(report, ui, { dryRun: true, reportDirectory });
    return;
  }

  await withLibrary(location, { indexOnWrite: false }, async (recueil) => {
    const interrupted = findInterruptedImport(recueil, baseUrl);

    if (interrupted !== null && flags.resume !== true) {
      throw new CliError('an earlier import of this Paperless server was interrupted.', {
        exitCode: ExitCode.Usage,
        detail: [
          '',
          `  It stopped during the '${interrupted.stage}' stage, after ${String(interrupted.index)} records,`,
          `  on attempt ${String(interrupted.attempts)}.`,
          '',
          '  Pass --resume to carry on from that point. Resuming is safe: every write the importer',
          "  makes is keyed by something Paperless owns, so repeating a checkpoint's worth of work",
          '  changes nothing (P9).',
          '',
          '  To start a separate import instead, give it its own --run-label.',
        ],
        payload: { error: 'import_interrupted', stage: interrupted.stage, index: interrupted.index },
      });
    }

    if (interrupted === null && flags.resume === true) {
      ui.warn('there is no interrupted import of this server to resume; starting from the beginning.');
    } else if (interrupted !== null) {
      ui.info(`resuming from the '${interrupted.stage}' stage.`);
    }

    const report = await runAgainst(recueil, flags, ui, { baseUrl, token, reportDirectory });

    // The importer wrote with the index switched off, so it has to be rebuilt. This is safe here
    // in a way it is not after `recueil ingest`: rebuild() re-indexes items and notes, and this
    // importer writes no document text of its own for it to lose.
    if (recueil.search.available) {
      ui.info('rebuilding the search index…');
      const rebuilt = recueil.search.rebuild();
      ui.detail(`indexed ${String(rebuilt.items)} items and ${String(rebuilt.notes)} notes`);
    }

    finish(report, ui, { dryRun: false, reportDirectory });
    return undefined;
  });
};

const dryRun = async (
  flags: PaperlessFlags,
  ui: Ui,
  location: ResolvedLibrary,
  context: { baseUrl: string; token: string; reportDirectory: string | null },
): Promise<PaperlessImportReport> => {
  const scratch = mkdtempSync(join(tmpdir(), 'recueil-paperless-dry-run-'));
  const storage = new DryRunStorage();

  try {
    let databaseFile = join(scratch, 'library.sqlite');

    if (location.databaseFile !== MEMORY_DATABASE && existsSync(location.databaseFile)) {
      ui.info('taking a consistent copy of the library to run against…');
      const snapshot = await createBackup({
        databaseUrl: location.databaseUrl,
        storagePath: null,
        out: join(scratch, 'snapshot'),
        includeBlobs: false,
        tableCounts: false,
      });
      databaseFile = join(snapshot.path, snapshot.manifest.database.path);
    }

    const recueil = createRecueil({ databaseUrl: databaseFile, storagePath: scratch, storage, indexOnWrite: false });
    try {
      const report = await runAgainst(recueil, flags, ui, context);
      const would = storage.summary;
      ui.detail(`would store ${String(would.blobs)} blob(s), ${String(would.bytes)} bytes`);
      return report;
    } finally {
      recueil.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const finish = (
  report: PaperlessImportReport,
  ui: Ui,
  context: { dryRun: boolean; reportDirectory: string | null },
): void => {
  const paths =
    context.reportDirectory === null
      ? null
      : {
          json: join(context.reportDirectory, 'report.json'),
          markdown: join(context.reportDirectory, 'report.md'),
          review: join(context.reportDirectory, '_REVIEW'),
        };

  if (ui.json) {
    ui.outJson({
      command: 'import.paperless',
      dryRun: context.dryRun,
      pass: report.pass,
      exitCode: exitCodeFor(report),
      report: paths,
      summary: report,
    });
  } else {
    printSummary(report, ui, { dryRun: context.dryRun, reportPaths: paths });
  }

  process.exitCode = exitCodeFor(report);
};

export const registerImportPaperless = (parent: Command, ui: () => Ui): Command =>
  parent
    .command('paperless')
    .description('Migrate a Paperless-ngx server (CONCEPT.md §6)')
    .option('--url <url>', 'the Paperless-ngx root (PAPERLESS_URL)')
    .option('--token <token>', 'an API token (PAPERLESS_TOKEN)')
    .option('-d, --database <url>', 'the Recueil library to import into (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)')
    .option('-n, --dry-run', 'do the whole import against a throwaway copy and report what it would do', false)
    .option('--resume', 'carry on from where an interrupted import stopped', false)
    .option('--report <dir>', 'where report.json, report.md and _REVIEW/ are written', DEFAULT_REPORT_DIRECTORY)
    .option('--no-report', 'do not write the verification report to disk')
    .option('--run-label <label>', 'distinguishes two deliberate imports of the same server')
    .option('--api-version <n>', 'the DRF Accept-header version to ask for')
    .option('--page-size <n>', 'records per page', parsePositiveInteger)
    .option('--timeout <ms>', 'per-request timeout', parsePositiveInteger)
    .option('--no-originals', 'import the metadata only; do not fetch the files')
    .option('--currency <code>', 'ISO-4217 code for a monetary value that carries none')
    .option('--correspondent <label>', 'what a document with no Paperless correspondent gets')
    .option('--no-progress', 'do not draw the progress display')
    .addHelpText(
      'after',
      [
        '',
        'The importer only reads: every request is a GET, and nothing in Paperless is changed. Both',
        'sides of every count in the report are queried — the Paperless side from what the API',
        'returned, the Recueil side from the target library\'s own tables — so a report and a',
        'library that disagree fail the check rather than agreeing with each other.',
        '',
        'This client has never spoken to a real Paperless-ngx server. It was transcribed from the',
        'published source of the release the report names and is tested against an in-process fake',
        'of it. The report says whether the server that answered is that release.',
        '',
        'Exit codes',
        '  0  imported, and every check passed',
        '  4  imported, but entries were routed to _REVIEW/ and need a decision',
        '  5  the parity check failed — do not decommission anything',
        '',
        'Examples:',
        '  recueil import paperless --url https://paperless.example --dry-run',
        '  PAPERLESS_TOKEN=… recueil import paperless --url https://paperless.example',
        '  recueil import paperless --url https://paperless.example --resume',
      ].join('\n'),
    )
    .action(async (flags: PaperlessFlags) => {
      await runImportPaperless(flags, ui());
    });
