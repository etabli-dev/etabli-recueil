/**
 * `recueil import zotero` (CONCEPT.md §6, §7 Phase 1).
 *
 * The migration is the exit criterion of the whole phase — "own library imported at 100% item
 * count with attachment-hash coverage report" — so the command's job is not only to run the
 * importer but to put the verdict in front of the person running it. Three things follow:
 *
 * - **The report is written to disk and summarised on stdout.** `report.json` is what a test or a
 *   later run reads; the table is what a person reads at the end of a four-minute import. They are
 *   the same numbers, because the table is rendered from the report.
 * - **The exit code carries the verdict.** Non-zero when the parity check fails, because a
 *   migration script that carries on to "now delete Zotero" after a failed parity check is the
 *   accident this criterion exists to prevent. A run that passed but left entries in `_REVIEW/`
 *   exits 4, which is the documented "finished, but there is work in the queue".
 * - **A dry run is a real run.** It maps every item, resolves every attachment and hashes every
 *   file, against a consistent copy of the library taken with the backup API and a store that
 *   discards its bytes. Nothing else could answer "what would this do to *my* library", which is
 *   the only question a dry run is asked.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MEMORY_DATABASE, createBackup, createRecueil } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { importZoteroLibrary } from '@recueil/import-zotero';
import type { ZoteroImportOptions, ZoteroImportReport } from '@recueil/import-zotero';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';

import { DryRunStorage } from '../dry-run-storage.js';
import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, withLibrary, type LibraryFlags, type ResolvedLibrary } from '../library.js';
import { Progress } from '../progress.js';
import { findInterruptedZoteroImport } from '../queries.js';
import { count, duration, renderTable } from '../table.js';
import type { Ui } from '../ui.js';

export interface ZoteroFlags extends LibraryFlags {
  dryRun?: boolean;
  resume?: boolean;
  report?: string | false;
  zoteroStorage?: string;
  betterBibtex?: string;
  linkedBase?: string;
  webdav?: string;
  library?: number;
  runLabel?: string;
  linkedFiles?: 'store' | 'link';
  progress?: boolean;
}

const DEFAULT_REPORT_DIRECTORY = './zotero-import';

const parseLibraryId = (value: string): number => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new InvalidArgumentError('expected the numeric libraryID of a Zotero library.');
  }
  return id;
};

const parseLinkedFiles = (value: string): 'store' | 'link' => {
  if (value !== 'store' && value !== 'link') {
    throw new InvalidArgumentError("expected `store` (hash the file into the library) or `link` (keep the path).");
  }
  return value;
};

/** The per-type parity table: the thing "100% item count" is actually measured on. */
const parityTable = (report: ZoteroImportReport): string[] =>
  renderTable(
    [
      { header: 'Zotero type' },
      { header: 'Recueil type' },
      { header: 'Zotero', align: 'right' },
      { header: 'Recueil', align: 'right' },
      { header: 'Δ', align: 'right' },
    ],
    [
      ...report.items.byType.map((row) => [
        row.zoteroType,
        row.recueilType,
        count(row.zoteroTotal),
        count(row.recueilTotal),
        row.delta === 0 ? '0' : (row.delta > 0 ? `+${row.delta}` : String(row.delta)),
      ]),
      [
        'all regular items',
        '',
        count(report.items.zoteroRegularTotal),
        count(report.items.recueilRegularTotal),
        report.items.delta === 0 ? '0' : String(report.items.delta),
      ],
    ],
  );

/** A digest in an `expected`/`actual` cell is 64 characters wide and no more legible for it. */
const short = (value: number | string): string => {
  const text = String(value);
  return /^[0-9a-f]{40,}$/u.test(text) ? `${text.slice(0, 12)}…` : text;
};

/** The named checks, which is where `pass` comes from and therefore where the exit code comes from. */
const checksTable = (report: ZoteroImportReport): string[] =>
  renderTable(
    [
      { header: 'Check' },
      { header: 'Expected', align: 'right' },
      { header: 'Actual', align: 'right' },
      { header: 'Result' },
    ],
    report.checks.map((check) => [
      check.name,
      short(check.expected),
      short(check.actual),
      check.pass ? 'pass' : check.blocking ? 'FAIL' : 'note',
    ]),
  );

const printSummary = (
  report: ZoteroImportReport,
  ui: Ui,
  context: { dryRun: boolean; reportPaths: { json: string; markdown: string; review: string } | null },
): void => {
  const { bold, dim, green, red, yellow } = ui.colour;

  ui.out('');
  ui.out(bold(context.dryRun ? 'Zotero import — dry run' : 'Zotero import'));
  ui.out('');
  for (const line of parityTable(report)) ui.out(`  ${line}`);
  ui.out('');
  for (const line of checksTable(report)) ui.out(`  ${line}`);
  ui.out('');

  const coverage = report.attachments;
  ui.out(
    `  attachments      ${count(coverage.resolved)}/${count(coverage.claimingFile)} files resolved ` +
      `(${coverage.hashCoveragePercent}% hash coverage), ${count(coverage.distinctDocuments)} distinct documents`,
  );
  ui.out(
    `  notes            ${count(report.notes.recueilTotal)} · annotations ${count(report.annotations.recueilTotal)} · ` +
      `collections ${count(report.collections.recueilTotal)} · tags ${count(report.tags.recueilTotal)} · ` +
      `creators ${count(report.creators.recueilTotal)}`,
  );
  ui.out(
    `  citation keys    ${count(report.citationKeys.itemsWithKey)} kept, ` +
      `${count(report.citationKeys.conflicts)} in conflict, ${count(report.citationKeys.collisions)} refused`,
  );
  ui.out(`  duration         ${duration(report.run.durationMs)}`);

  if (report.skipped.length > 0) {
    ui.out(`  skipped          ${count(report.skipped.length)} records — see the report`);
  }
  if (report.review.length > 0) {
    ui.out(
      `  ${yellow('review')}           ${count(report.review.length)} entries need a decision` +
        (context.reportPaths === null ? '' : ` — ${context.reportPaths.review}`),
    );
  }

  ui.out('');
  ui.out(report.pass ? `  ${green('PASS')} — item counts match and nothing was dropped unaccounted for.` : `  ${red('FAIL')} — the parity check did not pass; nothing about the source library has changed.`);

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

const exitCodeFor = (report: ZoteroImportReport): number => {
  const blocking = report.checks.filter((check) => check.blocking && !check.pass);
  if (!report.pass || blocking.length > 0) return ExitCode.JobFailed;
  return report.review.length > 0 ? ExitCode.Review : ExitCode.Success;
};

/**
 * Run the import against `recueil`, whatever `recueil` happens to be.
 *
 * The real run and the dry run differ only in the library they are handed, which is what makes the
 * dry run worth believing.
 */
const runAgainst = async (
  recueil: Recueil,
  databasePath: string,
  flags: ZoteroFlags,
  ui: Ui,
  reportDirectory: string | null,
): Promise<ZoteroImportReport> => {
  const progress = new Progress(ui, { enabled: flags.progress !== false });

  const options: ZoteroImportOptions = {
    databasePath,
    ...(flags.betterBibtex === undefined ? {} : { betterBibtexPath: flags.betterBibtex }),
    ...(flags.zoteroStorage === undefined ? {} : { storageDirectory: flags.zoteroStorage }),
    ...(flags.linkedBase === undefined ? {} : { linkedAttachmentBase: flags.linkedBase }),
    ...(flags.webdav === undefined ? {} : { webdavDirectory: flags.webdav }),
    ...(flags.library === undefined ? {} : { libraryId: flags.library }),
    ...(flags.runLabel === undefined ? {} : { runLabel: flags.runLabel }),
    ...(flags.linkedFiles === undefined ? {} : { linkedFilePolicy: flags.linkedFiles }),
    reportDirectory,
    abortAfter: (state) => {
      progress.update({ label: state.stage, done: state.index, total: state.total });
      return false;
    },
  };

  try {
    const { report } = await importZoteroLibrary(recueil, options);
    return report;
  } finally {
    progress.finish();
  }
};

export const runImportZotero = async (databaseArgument: string, flags: ZoteroFlags, ui: Ui): Promise<void> => {
  const started = Date.now();
  const zoteroDatabase = resolve(databaseArgument);
  const location = resolveLibraryLocation(flags);
  const reportDirectory = flags.report === false ? null : resolve(flags.report ?? DEFAULT_REPORT_DIRECTORY);

  ui.info(`Zotero    ${zoteroDatabase}`);
  ui.info(`library   ${location.databaseUrl} (${location.origin.database})`);
  ui.info(`storage   ${location.storagePath} (${location.origin.storage})`);
  ui.info(`report    ${reportDirectory ?? '(not written)'}`);
  ui.info('');

  if (flags.dryRun === true) {
    const report = await dryRun(zoteroDatabase, flags, ui, location, reportDirectory);
    finish(report, ui, { dryRun: true, reportDirectory, started });
    return;
  }

  await withLibrary(location, { indexOnWrite: false }, async (recueil) => {
    const interrupted = findInterruptedZoteroImport(recueil, zoteroDatabase);

    if (interrupted !== null && flags.resume !== true) {
      throw new CliError('an earlier import of this Zotero library was interrupted.', {
        exitCode: ExitCode.Usage,
        detail: [
          '',
          `  It stopped during the '${interrupted.stage}' stage, after ${interrupted.index} records,`,
          `  on attempt ${interrupted.attempts}.`,
          '',
          '  Pass --resume to carry on from that point. Resuming is safe: every write the importer',
          '  makes is keyed by something the Zotero library owns, so repeating a checkpoint\'s worth',
          '  of work changes nothing (P9).',
          '',
          '  To start a separate import instead, give it its own --run-label.',
        ],
        payload: { error: 'import_interrupted', stage: interrupted.stage, index: interrupted.index },
      });
    }

    if (interrupted === null && flags.resume === true) {
      ui.warn('there is no interrupted import of this library to resume; starting from the beginning.');
    } else if (interrupted !== null) {
      ui.info(`resuming from the '${interrupted.stage}' stage.`);
    }

    const report = await runAgainst(recueil, zoteroDatabase, flags, ui, reportDirectory);

    // The importer wrote with the index switched off; one rebuild costs far less than fifty
    // thousand incremental updates, and a library whose search index is empty is not imported.
    if (recueil.search.available) {
      ui.info('rebuilding the search index…');
      const rebuilt = recueil.search.rebuild();
      ui.detail(`indexed ${rebuilt.items} items and ${rebuilt.notes} notes`);
    }

    finish(report, ui, { dryRun: false, reportDirectory, started });
  });
};

/**
 * The dry run.
 *
 * A consistent copy of the real library is taken with the backup API — so the answer accounts for
 * what is already imported, which an empty scratch database could not — and the copy is opened
 * with a store that hashes and discards. Both go away with the temporary directory.
 */
const dryRun = async (
  zoteroDatabase: string,
  flags: ZoteroFlags,
  ui: Ui,
  location: ResolvedLibrary,
  reportDirectory: string | null,
): Promise<ZoteroImportReport> => {
  const scratch = mkdtempSync(join(tmpdir(), 'recueil-dry-run-'));
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
      const report = await runAgainst(recueil, zoteroDatabase, flags, ui, reportDirectory);
      const would = storage.summary;
      ui.detail(`would store ${would.blobs} blobs (${would.bytes} bytes)`);
      return report;
    } finally {
      recueil.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const finish = (
  report: ZoteroImportReport,
  ui: Ui,
  context: { dryRun: boolean; reportDirectory: string | null; started: number },
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
      command: 'import.zotero',
      dryRun: context.dryRun,
      pass: report.pass,
      exitCode: exitCodeFor(report),
      elapsedMs: Date.now() - context.started,
      report: paths,
      summary: report,
    });
  } else {
    printSummary(report, ui, { dryRun: context.dryRun, reportPaths: paths });
  }

  process.exitCode = exitCodeFor(report);
};

export const registerImportZotero = (parent: Command, ui: () => Ui): Command =>
  parent
    .command('zotero')
    .description('Migrate a Zotero library (CONCEPT.md §6)')
    .argument('<zotero.sqlite>', "path to Zotero's database")
    .option('-d, --database <url>', 'the Recueil library to import into (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)')
    .option('-n, --dry-run', 'do the whole import against a throwaway copy and report what it would do', false)
    .option('--resume', 'carry on from where an interrupted import stopped', false)
    .option('--report <dir>', 'where report.json, report.md and _REVIEW/ are written', DEFAULT_REPORT_DIRECTORY)
    .option('--no-report', 'do not write the verification report to disk')
    .option('--zotero-storage <dir>', "Zotero's storage/ directory (default: beside zotero.sqlite)")
    .option('--better-bibtex <file>', 'better-bibtex.sqlite (default: beside zotero.sqlite)')
    .option('--linked-base <dir>', "Zotero's Linked Attachment Base Directory")
    .option('--webdav <dir>', 'a directory of <KEY>.zip files, as a WebDAV sync target holds them')
    .option('--library <id>', 'which Zotero library to read (default: the personal one)', parseLibraryId)
    .option('--run-label <label>', 'distinguishes two deliberate imports of the same library')
    .option('--linked-files <policy>', 'store | link — what to do with a linked file that is present', parseLinkedFiles)
    .option('--no-progress', 'do not draw the progress display')
    .addHelpText(
      'after',
      [
        '',
        'The source library is never written to: it is copied, opened read-only, and every',
        'statement that is not a SELECT is refused. Re-running is safe and produces the same',
        'library rather than a doubled one — every write is keyed by something Zotero owns.',
        '',
        'Exit codes',
        '  0  imported, and every check passed',
        '  4  imported, but entries were routed to _REVIEW/ and need a decision',
        '  5  the parity check failed — do not delete anything',
        '',
        'Examples:',
        '  recueil import zotero ~/Zotero/zotero.sqlite --dry-run',
        '  recueil import zotero ~/Zotero/zotero.sqlite --linked-base ~/Documents/Papers',
        '  recueil import zotero ~/Zotero/zotero.sqlite --resume',
      ].join('\n'),
    )
    .action(async (databasePath: string, flags: ZoteroFlags) => {
      await runImportZotero(databasePath, flags, ui());
    });
