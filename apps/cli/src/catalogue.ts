/**
 * The command surface, and the phase each command belongs to.
 *
 * Commands come from CONCEPT.md §5.12 and docs/cli.qmd; phases come from the roadmap in
 * CONCEPT.md §7. This table is the single source of both: `--help` renders from it, the
 * placeholder commands are generated from it, and the tests iterate it. Adding a command means
 * adding a row, which means the help output and the phase message cannot disagree with each other.
 */

/** The roadmap themes, so a phase number in an error message can say what it is. */
export const PHASE_TITLES: Readonly<Record<number, string>> = {
  0: 'Spec and scaffold',
  1: 'Core library + Zotero migration',
  2: 'Ingestion + storage backends',
  3: 'Enrichment, checks, dedup',
  4: 'Reading, search, desktop shell',
  5: 'Graph, bibliometrics, R/Python',
  6: 'Curated networks',
  7: 'Systematic review',
  8: 'Mobile + own connector',
  9: 'Community and 1.0',
};

/** The phase whose commands actually work. Everything above this is a placeholder. */
export const CURRENT_PHASE = 0;

export interface CommandSpec {
  /** The subcommand name, as typed. */
  readonly name: string;
  /** One line, shown in `recueil --help`. */
  readonly summary: string;
  /** The roadmap phase that delivers it (CONCEPT.md §7). */
  readonly phase: number;
  /** What it will do, shown when someone runs it too early. */
  readonly promise: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'serve',
    summary: 'Start the server',
    phase: 0,
    promise: 'Start the Recueil server: REST API, connector endpoint, job runner and plugin host.',
  },
  {
    name: 'import',
    summary: 'Import a library or a bibliography',
    phase: 1,
    promise: 'Import from Zotero, Paperless-ngx, BibTeX, RIS, EndNote XML, CSL-JSON, JabRef or CSV.',
  },
  {
    name: 'export',
    summary: 'Export items in an interchange format',
    phase: 1,
    promise: 'Export BibTeX, BibLaTeX, CSL-JSON, RIS, JSON-LD, CSV or Parquet.',
  },
  {
    name: 'backup',
    summary: 'Take a consistent snapshot',
    phase: 1,
    promise: 'Snapshot the database, the storage manifest and the configuration in a restic-friendly layout.',
  },
  {
    name: 'restore',
    summary: 'Restore from a snapshot',
    phase: 1,
    promise: 'Restore a library from a snapshot taken by `recueil backup`.',
  },
  {
    name: 'token',
    summary: 'Manage scoped API tokens',
    phase: 1,
    promise: 'Create, list and revoke the scoped API tokens every other client authenticates with.',
  },
  {
    name: 'job',
    summary: 'Inspect and control background jobs',
    phase: 1,
    promise: 'List, follow, retry and cancel the jobs in the queue.',
  },
  {
    name: 'ingest',
    summary: 'Push files in and work the review queue',
    phase: 2,
    promise: 'Push files into the pipeline, manage ingestion sources, and work the review queue.',
  },
  {
    name: 'check',
    summary: 'Run the verification engine',
    phase: 3,
    promise: 'Run the checks over a scope, or audit a pasted reference list for existence, retraction and preprint status.',
  },
  {
    name: 'dedup',
    summary: 'Find and merge duplicates',
    phase: 3,
    promise: 'File and record deduplication, dry run by default, with a report of what a run would do.',
  },
  {
    name: 'plugin',
    summary: 'Manage plugins',
    phase: 3,
    promise: 'Install, enable, disable, configure and list plugins.',
  },
  {
    name: 'graph',
    summary: 'Build, expand and export the citation graph',
    phase: 5,
    promise: 'Build edges, run a deep dive with a budget, and export a network for VOSviewer or Gephi.',
  },
  {
    name: 'sr',
    summary: 'Run a systematic review',
    phase: 7,
    promise: 'Search runs, screening, extraction, risk of bias and PRISMA counts.',
  },
];

export const isImplemented = (spec: CommandSpec): boolean => spec.phase <= CURRENT_PHASE;

export const phaseTitle = (phase: number): string => PHASE_TITLES[phase] ?? 'a later phase';

/** `Phase 3 — Enrichment, checks, dedup`, for help text and error messages. */
export const phaseLabel = (phase: number): string => `Phase ${phase} — ${phaseTitle(phase)}`;
