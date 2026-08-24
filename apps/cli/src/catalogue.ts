/**
 * The command surface, and the phase each command belongs to.
 *
 * Commands come from CONCEPT.md §5.12 and docs/cli.qmd; phases come from the roadmap in
 * CONCEPT.md §7. This table is the single source of both: `--help` renders from it, the
 * placeholder commands are generated from it, and the tests iterate it. Adding a command means
 * adding a row, which means the help output and the phase message cannot disagree with each other.
 *
 * `phase` and `implemented` are two different facts and are recorded separately on purpose. A
 * phase is a promise about the roadmap; `implemented` is a statement about this build. They part
 * company inside a phase that is under way — Phase 1 delivers `token` and `job` as well as the
 * five commands below, and until those exist a table that inferred one from the other would have
 * to claim either that the phase had not started or that the commands worked.
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

/** The phase this build belongs to. Not every command in it is finished; see `implemented`. */
export const CURRENT_PHASE = 2;

export interface CommandSpec {
  /** The subcommand name, as typed. */
  readonly name: string;
  /** One line, shown in `recueil --help`. */
  readonly summary: string;
  /** The roadmap phase that delivers it (CONCEPT.md §7). */
  readonly phase: number;
  /** True when this build registers a real implementation. */
  readonly implemented: boolean;
  /** What it will do, shown when someone runs it too early. */
  readonly promise: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'serve',
    summary: 'Start the server',
    phase: 0,
    implemented: true,
    promise: 'Start the Recueil server: REST API, connector endpoint, job runner and plugin host.',
  },
  {
    name: 'import',
    summary: 'Import a library or a bibliography',
    phase: 1,
    implemented: true,
    promise: 'Import from Zotero, Paperless-ngx, BibTeX, RIS, EndNote XML, CSL-JSON, JabRef or CSV.',
  },
  {
    name: 'export',
    summary: 'Export items in an interchange format',
    phase: 1,
    implemented: true,
    promise: 'Export BibTeX, BibLaTeX, CSL-JSON, RIS, JSON-LD, CSV or Parquet.',
  },
  {
    name: 'backup',
    summary: 'Take a consistent snapshot',
    phase: 1,
    implemented: true,
    promise: 'Snapshot the database, the storage manifest and the configuration in a restic-friendly layout.',
  },
  {
    name: 'restore',
    summary: 'Restore from a snapshot',
    phase: 1,
    implemented: true,
    promise: 'Restore a library from a snapshot taken by `recueil backup`.',
  },
  {
    name: 'token',
    summary: 'Manage scoped API tokens',
    phase: 1,
    implemented: false,
    promise: 'Create, list and revoke the scoped API tokens every other client authenticates with.',
  },
  {
    name: 'job',
    summary: 'Follow a running job and read its log',
    phase: 1,
    implemented: false,
    promise:
      'Follow a job live and read its log. Listing, retrying and cancelling arrived in Phase 2 as ' +
      '`recueil queue`; what is still missing is the live follow and the per-job log.',
  },
  {
    name: 'ingest',
    summary: 'Push files into the ingestion pipeline',
    phase: 2,
    implemented: true,
    promise: 'Push files into the pipeline and run the configured sources.',
  },
  {
    name: 'queue',
    summary: 'Inspect, retry and cancel work-queue jobs',
    phase: 2,
    implemented: true,
    promise: 'List the jobs in the queue, retry one that failed, and cancel one that is waiting.',
  },
  {
    name: 'review',
    summary: 'Work the review queue',
    phase: 2,
    implemented: true,
    promise: 'List the entries the confidence gate raised, and accept or reject each one.',
  },
  {
    name: 'rules',
    summary: 'Validate and dry-run rule sets',
    phase: 2,
    implemented: true,
    promise: 'Validate a rule set and run it over a corpus without writing anything.',
  },
  {
    name: 'check',
    summary: 'Run the verification engine',
    phase: 3,
    implemented: false,
    promise: 'Run the checks over a scope, or audit a pasted reference list for existence, retraction and preprint status.',
  },
  {
    name: 'dedup',
    summary: 'Find and merge duplicates',
    phase: 3,
    implemented: false,
    promise: 'File and record deduplication, dry run by default, with a report of what a run would do.',
  },
  {
    name: 'plugin',
    summary: 'Manage plugins',
    phase: 3,
    implemented: false,
    promise: 'Install, enable, disable, configure and list plugins.',
  },
  {
    name: 'graph',
    summary: 'Build, expand and export the citation graph',
    phase: 5,
    implemented: false,
    promise: 'Build edges, run a deep dive with a budget, and export a network for VOSviewer or Gephi.',
  },
  {
    name: 'sr',
    summary: 'Run a systematic review',
    phase: 7,
    implemented: false,
    promise: 'Search runs, screening, extraction, risk of bias and PRISMA counts.',
  },
];

export const isImplemented = (spec: CommandSpec): boolean => spec.implemented;

/** The commands this build actually ships, for the help text and the placeholder messages. */
export const IMPLEMENTED_COMMANDS: readonly string[] = COMMANDS.filter(isImplemented).map(
  (spec) => spec.name,
);

export const phaseTitle = (phase: number): string => PHASE_TITLES[phase] ?? 'a later phase';

/** `Phase 3 — Enrichment, checks, dedup`, for help text and error messages. */
export const phaseLabel = (phase: number): string => `Phase ${phase} — ${phaseTitle(phase)}`;
