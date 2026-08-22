/**
 * `recueil export` (CONCEPT.md §5.11, §5.12, ADR-0016).
 *
 * The selection logic and the citation-key ledger are not reimplemented here. They live in
 * `@recueil/server`'s `export.ts`, behind `resolveSelection` and `renderExport`, and this command
 * calls them — which is P6 ("nothing is UI-only") read in the other direction: the `.bib` a LaTeX
 * build fetches over HTTP and the `.bib` this command writes have to be the same bytes, and the
 * only way to guarantee that is for there to be one implementation. A second one here would
 * eventually assign a different suffix to a colliding key, and a `\cite{}` in a manuscript would
 * stop resolving.
 *
 * The server module is loaded dynamically for the reason `server.ts` gives: `recueil --help` must
 * not pay for Fastify, and a tree where the server has not been built must still run everything
 * that does not need it.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Recueil } from '@recueil/core';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, withLibrary, type LibraryFlags } from '../library.js';
import { count, renderTable } from '../table.js';
import type { Ui } from '../ui.js';

export const EXPORT_FORMATS = ['bibtex', 'biblatex', 'csl-json', 'ris'] as const;

export type ExportFormatName = (typeof EXPORT_FORMATS)[number];

export interface ExportFlags extends LibraryFlags {
  collection?: string;
  search?: string;
  ids?: string[];
  all?: boolean;
  out?: string;
  limit?: number;
  full?: boolean;
}

/** The shape this command needs from `@recueil/server`, checked at run time. */
interface ExportApi {
  resolveSelection: (
    recueil: Recueil,
    selection: { collectionId?: string; ids?: readonly string[]; q?: string; limit?: number },
  ) => string[];
  renderExport: (
    recueil: Recueil,
    format: string,
    itemIds: readonly string[],
  ) => {
    text: string;
    recordCount: number;
    extension: string;
    losses: ReadonlyArray<{ recordIndex: number; recordKey?: string | undefined; field: string; reason: string }>;
  };
}

const loadExportApi = async (): Promise<ExportApi> => {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import('@recueil/server')) as Record<string, unknown>;
  } catch (cause) {
    throw new CliError('the export implementation in @recueil/server could not be loaded.', {
      exitCode: ExitCode.Usage,
      detail: [
        '',
        '  `recueil export` shares its selection and citation-key logic with the export endpoint,',
        '  so the server package has to be installed and built. From a source checkout:',
        '',
        '      pnpm install && pnpm -r build',
        '',
        `  The loader reported: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
      cause,
    });
  }

  if (typeof loaded['resolveSelection'] !== 'function' || typeof loaded['renderExport'] !== 'function') {
    throw new CliError('@recueil/server exports no `resolveSelection`/`renderExport` pair.', {
      detail: ['', '  The CLI and the server are versioned together; this pair is a build mismatch.'],
    });
  }
  return loaded as unknown as ExportApi;
};

/** `--ids a,b --ids c` accumulates: comma-separated, repeatable, order preserved. */
export const collectIds = (value: string, previous: string[] = []): string[] => [
  ...previous,
  ...value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
];

/**
 * Every live item, oldest first.
 *
 * The export *endpoint* refuses to serialise a whole library without a selection, and it is right
 * to: an accidental `GET /export/bibtex` should not produce fifty thousand entries. A command line
 * is a different setting — `--all` is four keystrokes nobody types by accident — and P10 says the
 * library has to be exportable in full. `listItems` is cursor-paged, so this walks the pages.
 */
const everyItemId = (recueil: Recueil, limit: number): string[] => {
  const ids: string[] = [];
  let cursor: string | undefined;

  while (ids.length < limit) {
    const page = recueil.library.listItems({
      limit: Math.min(200, limit - ids.length),
      order: 'asc',
      ...(cursor === undefined ? {} : { cursor }),
    });
    ids.push(...page.data.map((row) => row.id));
    if (page.page.nextCursor === null) break;
    cursor = page.page.nextCursor;
  }
  return ids;
};

export const runExport = async (format: ExportFormatName, flags: ExportFlags, ui: Ui): Promise<void> => {
  const chosen = [
    flags.collection === undefined ? null : 'collection',
    flags.search === undefined ? null : 'search',
    flags.ids === undefined || flags.ids.length === 0 ? null : 'ids',
    flags.all === true ? 'all' : null,
  ].filter((value): value is string => value !== null);

  if (chosen.length === 0) {
    throw new CliError('an export needs a selection.', {
      exitCode: ExitCode.Usage,
      detail: [
        '',
        '  Pass one of --collection, --search, --ids or --all. Exporting the whole library by',
        '  accident is not something this command makes easy: a fifty-thousand-entry `.bib` is',
        '  rarely what anybody meant, and never what a LaTeX build wanted — so it has to be asked',
        '  for by name.',
        '',
        'Examples:',
        '  recueil export bibtex --collection 01J8ZK… --out chapter3.bib',
        '  recueil export csl-json --search "climate danube"',
        '  recueil export ris --ids 01J8ZK…,01J8ZM…',
        '  recueil export biblatex --all --out library.bib',
      ],
      payload: { error: 'no_selection' },
    });
  }
  if (chosen.length > 1) {
    throw new CliError(`give one selection only; got ${chosen.join(' and ')}.`, {
      exitCode: ExitCode.Usage,
      payload: { error: 'ambiguous_selection', given: chosen },
    });
  }

  const api = await loadExportApi();
  const location = resolveLibraryLocation(flags);

  await withLibrary(location, { mustExist: true }, async (recueil) => {
    const ids =
      flags.all === true
        ? everyItemId(recueil, flags.limit ?? Number.MAX_SAFE_INTEGER)
        : api.resolveSelection(recueil, {
            ...(flags.collection === undefined ? {} : { collectionId: flags.collection }),
            ...(flags.search === undefined ? {} : { q: flags.search }),
            ...(flags.ids === undefined || flags.ids.length === 0 ? {} : { ids: flags.ids }),
            ...(flags.limit === undefined ? {} : { limit: flags.limit }),
          });

    if (ids.length === 0) {
      // Not an error: an empty collection is a legitimate answer, and a build that fetches an
      // empty bibliography should get one. It must not be silent, though.
      ui.warn('the selection matched no items; the export is empty.');
    }

    const rendered = api.renderExport(recueil, format, ids);

    if (flags.out === undefined) {
      process.stdout.write(rendered.text);
    } else {
      const target = resolve(flags.out);
      try {
        writeFileSync(target, rendered.text, 'utf8');
      } catch (cause) {
        throw new CliError(`could not write '${target}': ${cause instanceof Error ? cause.message : String(cause)}`, {
          exitCode: ExitCode.JobFailed,
          cause,
        });
      }
      ui.info(`wrote ${count(rendered.recordCount)} records to ${target}`);
    }

    if (rendered.losses.length > 0) {
      // On stderr without exception, including when the document went to stdout: `recueil export
      // bibtex … > chapter3.bib` has to produce a `.bib` file and not a `.bib` file with a table
      // of losses at the top of it.
      const shown = flags.full === true ? rendered.losses : rendered.losses.slice(0, 20);
      ui.info('');
      ui.info(`${rendered.losses.length} values the format could not carry:`);
      ui.info('');
      for (const line of renderTable(
        [{ header: '#', align: 'right' }, { header: 'Entry' }, { header: 'Field' }, { header: 'Reason' }],
        shown.map((loss) => [
          String(loss.recordIndex + 1),
          loss.recordKey ?? '—',
          loss.field,
          loss.reason,
        ]),
      )) {
        ui.info(`  ${line}`);
      }
      if (shown.length < rendered.losses.length) {
        ui.info(`  … and ${rendered.losses.length - shown.length} more (run again with --full)`);
      }
    }

    return undefined;
  });
};

const parseLimit = (value: string): number => {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidArgumentError('expected a positive integer.');
  }
  return limit;
};

const registerFormat = (parent: Command, format: ExportFormatName, ui: () => Ui): Command =>
  parent
    .command(format)
    .description(`Export the selection as ${format}`)
    .option('-d, --database <url>', 'the library to read (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)')
    .option('-c, --collection <id>', 'export a collection, or a saved search')
    .option('-q, --search <query>', "export everything matching a query, in Recueil's search syntax")
    .option('-i, --ids <ids>', 'export these items, in this order; comma-separated, repeatable', collectIds, [])
    .option('-a, --all', 'export every item in the library', false)
    .option('-o, --out <file>', 'write here instead of to stdout')
    .option('--limit <n>', 'cap the selection', parseLimit)
    .option('--full', 'list every loss rather than the first few', false)
    .addHelpText(
      'after',
      [
        '',
        'Exactly one of --collection, --search, --ids and --all. The document goes to stdout unless --out',
        'is given; everything else — the losses, the counts — goes to stderr, so redirecting stdout',
        'produces a file the format can read.',
        '',
        'Citation keys are stable (ADR-0016): a stored key is used as it stands, a pinned key is',
        'never recomputed, and only an item with no key at all is given a generated one.',
      ].join('\n'),
    )
    .action(async (flags: ExportFlags) => {
      await runExport(format, flags, ui());
    });

export const registerExport = (
  parent: Command,
  describe: (name: string) => string,
  ui: () => Ui,
): Command => {
  const command = parent
    .command('export')
    .description(describe('export'))
    .addHelpText(
      'after',
      [
        '',
        'Formats',
        '  bibtex     BibTeX, for a classic LaTeX toolchain',
        '  biblatex   BibLaTeX, which carries dates and DOIs properly',
        '  csl-json   CSL-JSON, for Pandoc, Quarto and citeproc',
        '  ris        RIS, for the reference managers that speak nothing else',
        '',
        'JSON-LD, CSV and Parquet arrive with the analytics bundle (ADR-0008).',
      ].join('\n'),
    );

  for (const format of EXPORT_FORMATS) registerFormat(command, format, ui);

  command
    .argument('[format]', EXPORT_FORMATS.join(', '))
    .allowExcessArguments(true)
    .action((format?: string) => {
      if (format === undefined) command.help({ error: true });
      throw new CliError(`unknown export format '${String(format)}'.`, {
        exitCode: ExitCode.Usage,
        detail: [
          '',
          `  This build exports: ${EXPORT_FORMATS.join(', ')}.`,
          '',
          '  JSON-LD, CSV and Parquet arrive with the analytics bundle (ADR-0008).',
        ],
        payload: { error: 'unknown_format', format, known: [...EXPORT_FORMATS] },
      });
    });

  return command;
};
