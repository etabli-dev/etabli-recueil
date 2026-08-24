/**
 * `recueil import` (CONCEPT.md §5.12, §6).
 *
 * Two shapes of import live under one verb, and they are genuinely different operations. A Zotero
 * migration is a whole library — items, files, annotations, collections, trash — and gets its own
 * module and its own verification report. A `.bib`, a `.ris` or a CSL-JSON file is a bibliography:
 * records and nothing else, no files, no annotations, and the only interesting question is what
 * the format could not carry.
 *
 * What they share is the rule that makes both trustworthy: an import reports what it dropped.
 * Never a silent success, never a count that flatters itself by not counting what went missing
 * (P3, P10).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { importBiblatex, importBibtex, importCslJson, importRis } from '@recueil/formats';
import type { ImportResult } from '@recueil/formats';
import type { Command } from 'commander';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, withLibrary, type LibraryFlags } from '../library.js';
import { Progress } from '../progress.js';
import { count, renderTable } from '../table.js';
import type { Ui } from '../ui.js';
import { registerImportPaperless } from './import-paperless.js';
import { registerImportZotero } from './import-zotero.js';
import { droppedFromLosses, importRecords } from './import-records.js';
import type { DroppedValue, RecordImportOutcome } from './import-records.js';

/** The bibliography formats, and how each is parsed. Mirrors `recueil export` exactly (P10). */
const PARSERS = {
  bibtex: { parse: (source: string): ImportResult => importBibtex(source), label: 'BibTeX' },
  biblatex: { parse: (source: string): ImportResult => importBiblatex(source), label: 'BibLaTeX' },
  ris: { parse: (source: string): ImportResult => importRis(source), label: 'RIS' },
  'csl-json': { parse: (source: string): ImportResult => importCslJson(source), label: 'CSL-JSON' },
} as const;

export type BibliographyFormat = keyof typeof PARSERS;

export const BIBLIOGRAPHY_FORMATS = Object.keys(PARSERS) as BibliographyFormat[];

export interface BibliographyFlags extends LibraryFlags {
  dryRun?: boolean;
  progress?: boolean;
  /** Show every dropped value rather than the first few. */
  full?: boolean;
}

/** How many dropped values are printed before the table says "and N more". */
const DROPPED_PREVIEW = 20;

const readSource = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    throw new CliError(`could not read '${path}': ${cause instanceof Error ? cause.message : String(cause)}`, {
      exitCode: ExitCode.Usage,
      cause,
    });
  }
};

const droppedTable = (dropped: readonly DroppedValue[], full: boolean): string[] => {
  const shown = full ? dropped : dropped.slice(0, DROPPED_PREVIEW);
  const lines = renderTable(
    [{ header: '#', align: 'right' }, { header: 'Entry' }, { header: 'Field' }, { header: 'Reason' }],
    shown.map((entry) => [
      String(entry.recordIndex + 1),
      entry.recordKey ?? '—',
      entry.field,
      entry.reason,
    ]),
  );
  if (!full && dropped.length > shown.length) {
    lines.push(`… and ${dropped.length - shown.length} more (run again with --full)`);
  }
  return lines;
};

/**
 * The exit code of a bibliography import.
 *
 * A field the format could not carry is normal and is reported, not escalated: `.bib` cannot hold
 * an abstract's provenance and never will, and a script that treated that as failure would fail
 * every time. What does escalate is a record that could not be written and a file that would not
 * parse — those are things a person has to look at, which is what exit code 4 means.
 */
const exitCodeFor = (outcome: RecordImportOutcome, syntaxErrors: number): number => {
  if (outcome.created + outcome.updated === 0) return ExitCode.JobFailed;
  return outcome.failed > 0 || syntaxErrors > 0 ? ExitCode.Review : ExitCode.Success;
};

export const runImportBibliography = async (
  format: BibliographyFormat,
  path: string,
  flags: BibliographyFlags,
  ui: Ui,
): Promise<void> => {
  const parser = PARSERS[format];
  const file = resolve(path);
  const location = resolveLibraryLocation(flags);

  const parsed = parser.parse(readSource(file));
  const syntaxErrors = parsed.losses.filter((loss) => loss.field === '@syntax').length;

  ui.info(`${parser.label}  ${file}`);
  ui.info(`library   ${location.databaseUrl} (${location.origin.database})`);
  ui.info(`parsed    ${parsed.records.length} records, ${parsed.losses.length} values the format could not carry`);
  ui.info('');

  if (parsed.records.length === 0) {
    throw new CliError(`no records in '${file}'.`, {
      exitCode: ExitCode.JobFailed,
      detail: [
        '',
        `  The parser read the file and found nothing it could turn into an item${
          syntaxErrors > 0 ? `, and reported ${syntaxErrors} syntax problem${syntaxErrors === 1 ? '' : 's'}` : ''
        }.`,
        '',
        ...parsed.losses.slice(0, 5).map((loss) => `  ${loss.field}: ${loss.reason}`),
      ],
      payload: { error: 'no_records', file, losses: parsed.losses.length },
    });
  }

  // A dry run parses, reports and writes nothing. There is no partial state to roll back from:
  // the whole question a dry run answers is "what would go in", and the parse answers it.
  if (flags.dryRun === true) {
    printSummary(
      ui,
      format,
      { created: 0, updated: 0, failed: 0, creatorsLinked: 0, tagsAssigned: 0, notesWritten: 0, dropped: droppedFromLosses(parsed.losses), failures: [] },
      { file, dryRun: true, records: parsed.records.length, full: flags.full === true },
    );
    return;
  }

  await withLibrary(location, { indexOnWrite: false }, async (recueil) => {
    const progress = new Progress(ui, { enabled: flags.progress !== false });
    let outcome: RecordImportOutcome;
    try {
      outcome = importRecords(recueil, parsed.records, {
        sourceSystem: format,
        provenanceSource: `import:${format}`,
        onRecord: (done, total) => {
          progress.update({ label: 'records', done, total });
        },
      });
    } finally {
      progress.finish();
    }

    if (recueil.search.available) recueil.search.rebuild();

    const merged: RecordImportOutcome = {
      ...outcome,
      dropped: [...droppedFromLosses(parsed.losses), ...outcome.dropped],
    };

    printSummary(ui, format, merged, {
      file,
      dryRun: false,
      records: parsed.records.length,
      full: flags.full === true,
    });

    process.exitCode = exitCodeFor(outcome, syntaxErrors);
    return undefined;
  });
};

const printSummary = (
  ui: Ui,
  format: BibliographyFormat,
  outcome: RecordImportOutcome,
  context: { file: string; dryRun: boolean; records: number; full: boolean },
): void => {
  if (ui.json) {
    ui.outJson({
      command: `import.${format}`,
      file: context.file,
      dryRun: context.dryRun,
      records: context.records,
      created: outcome.created,
      updated: outcome.updated,
      failed: outcome.failed,
      creators: outcome.creatorsLinked,
      tags: outcome.tagsAssigned,
      notes: outcome.notesWritten,
      dropped: outcome.dropped,
      failures: outcome.failures,
    });
    return;
  }

  const { bold, dim, yellow, red } = ui.colour;

  ui.out('');
  ui.out(bold(context.dryRun ? `${PARSERS[format].label} import — dry run` : `${PARSERS[format].label} import`));
  ui.out('');
  for (const line of renderTable(
    [{ header: 'What' }, { header: 'Count', align: 'right' }],
    [
      ['records in the file', count(context.records)],
      ['items created', count(outcome.created)],
      ['items updated', count(outcome.updated)],
      ['creator appearances', count(outcome.creatorsLinked)],
      ['tags assigned', count(outcome.tagsAssigned)],
      ['notes written', count(outcome.notesWritten)],
      ['values dropped', count(outcome.dropped.length)],
      ['records refused', count(outcome.failed)],
    ],
  )) {
    ui.out(`  ${line}`);
  }

  if (outcome.dropped.length > 0) {
    ui.out('');
    ui.out(`  ${yellow('dropped')} — reported rather than carried (P10):`);
    ui.out('');
    for (const line of droppedTable(outcome.dropped, context.full)) ui.out(`  ${line}`);
  }

  if (outcome.failures.length > 0) {
    ui.out('');
    ui.out(`  ${red('refused')} — these records were not written:`);
    ui.out('');
    for (const line of droppedTable(outcome.failures, true)) ui.out(`  ${line}`);
  }

  if (context.dryRun) {
    ui.out('');
    ui.out(dim('  Nothing was written: --dry-run parses the file and reports, and stops there.'));
  }
  ui.out('');
};

const registerBibliography = (parent: Command, format: BibliographyFormat, ui: () => Ui): Command =>
  parent
    .command(format)
    .description(`Import a ${PARSERS[format].label} file`)
    .argument('<file>', `the ${PARSERS[format].label} file to read`)
    .option('-d, --database <url>', 'the Recueil library to import into (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)')
    .option('-n, --dry-run', 'parse and report; write nothing', false)
    .option('--full', 'list every dropped value rather than the first few', false)
    .option('--no-progress', 'do not draw the progress display')
    .addHelpText(
      'after',
      [
        '',
        'The entry key is kept as the item\'s citation key and as its source id, so re-importing',
        'the same file updates the same items rather than doubling them, and every `\\cite{}`',
        'already written keeps resolving (ADR-0016, P9).',
        '',
        'A key or a DOI another live item already holds is dropped and reported, never reassigned.',
        'Files named in a `file` field are reported, not fetched: that is the ingestion pipeline\'s',
        'job and it arrives in Phase 2.',
        '',
        'Exit codes',
        '  0  imported, and everything the format carried went in',
        '  4  imported, but records were refused or the file had syntax problems',
        '  5  nothing could be imported',
      ].join('\n'),
    )
    .action(async (file: string, flags: BibliographyFlags) => {
      await runImportBibliography(format, file, flags, ui());
    });

export const registerImport = (
  parent: Command,
  describe: (name: string) => string,
  ui: () => Ui,
): Command => {
  const command = parent
    .command('import')
    .description(describe('import'))
    .addHelpText(
      'after',
      [
        '',
        'Sources',
        '  zotero     a whole Zotero library: items, files, annotations, collections and trash,',
        '             with the verification report the Phase 1 exit criterion is judged on',
        '  paperless  a whole Paperless-ngx server over its API: documents, tags, correspondents,',
        '             document types, custom fields, ASN and originals, into the Office facet',
        '  bibtex     a .bib file',
        '  biblatex   a .bib file, read as BibLaTeX',
        '  ris        an RIS file',
        '  csl-json   a CSL-JSON file',
        '',
        'EndNote XML, JabRef and CSV arrive in later phases (CONCEPT.md §6).',
      ].join('\n'),
    );

  registerImportZotero(command, ui);
  registerImportPaperless(command, ui);
  for (const format of BIBLIOGRAPHY_FORMATS) registerBibliography(command, format, ui);

  // Reached only when the first argument matched no source. `recueil import` on its own prints the
  // help and fails; `recueil import endnote refs.enl` says which sources exist, because "too many
  // arguments for 'import'" is a true statement that helps nobody.
  command
    .argument('[source]', 'zotero, paperless, bibtex, biblatex, ris or csl-json')
    .allowExcessArguments(true)
    .action((source?: string) => {
      if (source === undefined) command.help({ error: true });
      throw new CliError(`unknown import source '${String(source)}'.`, {
        exitCode: ExitCode.Usage,
        detail: [
          '',
          `  This build imports: zotero, paperless, ${BIBLIOGRAPHY_FORMATS.join(', ')}.`,
          '',
          '  EndNote XML, JabRef and CSV arrive in later phases (CONCEPT.md §6).',
        ],
        payload: { error: 'unknown_source', source, known: ['zotero', 'paperless', ...BIBLIOGRAPHY_FORMATS] },
      });
    });

  return command;
};
