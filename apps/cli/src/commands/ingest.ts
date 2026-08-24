/**
 * `recueil ingest` — files into the pipeline of CONCEPT.md §5.3.
 *
 * The ten stages belong to `@recueil/ingest`; what this command owns is everything around them:
 * turning paths into candidates safely, choosing the adapters behind the two sidecar interfaces,
 * putting the run's answer in front of a person, and turning that answer into an exit code.
 *
 * Three decisions are worth stating, because each has a wrong version that looks right.
 *
 * **A directory is a hostile input.** A path inside a watched folder can be a symlink out of it,
 * and a `..` in an archive member is the same attack with a different spelling. `folderCandidates`
 * resolves every entry with `realpath` and checks it is inside the root before it is opened, and
 * this command prints what it refused rather than quietly scanning less than it was asked to.
 *
 * **A dry run is a real run against a throwaway copy.** The same shape `recueil import zotero`
 * uses: a consistent copy of the library taken with the backup API, opened with a store that
 * hashes and discards. Anything less could not answer "what would this do to *my* library" —
 * whether a file is already there, whether an ASN collides, which rule fires on the text that this
 * OCR engine produces are all questions about the library and not about the file.
 *
 * **The per-file table is queried, not narrated.** The rule trace comes from the engine's own
 * returned evaluation for that subject; the confidence and the reason come from the `review_queue`
 * row the gate wrote; the media type, the text layer and the OCR status come from the `documents`
 * columns stages 4 to 6 wrote. Nothing in it is a counter this command incremented while deciding,
 * which is the failure the Phase 1 review found in the Zotero importer's verification and which is
 * not repeated here.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { MEMORY_DATABASE, createBackup, createRecueil, schema } from '@recueil/core';
import type { DocumentSourceKind, Recueil } from '@recueil/core';
import {
  EventBus,
  IngestPipeline,
  fileCandidate,
  folderCandidates,
  reviewQueue,
} from '@recueil/ingest';
import type {
  IngestCandidate,
  IngestOutcome,
  IngestRunReport,
  ReviewQueueRow,
} from '@recueil/ingest';
import { renderTrace } from '@recueil/rules';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import { eq, inArray } from 'drizzle-orm';

import { DryRunStorage } from '../dry-run-storage.js';
import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import {
  OCR_ENGINES,
  asIngestionRuleSet,
  collectValues,
  effectiveThreshold,
  loadRuleSetFile,
  parseOcrEngine,
  parsePositiveInteger,
  parseUnitInterval,
  resolveOcrEngine,
  resolvePipelineConfig,
} from '../ingest-options.js';
import type { OcrFlags, PipelineConfigFlags } from '../ingest-options.js';
import { resolveLibraryLocation, withLibrary, type LibraryFlags, type ResolvedLibrary } from '../library.js';
import { Progress } from '../progress.js';
import { RulesEngineAdapter } from '../rule-engine.js';
import { count, duration, renderTable } from '../table.js';
import type { Ui } from '../ui.js';
import { registerIngestWatch } from './ingest-watch.js';

const SOURCE_KINDS: readonly DocumentSourceKind[] = [
  'upload',
  'folder',
  'webdav',
  'imap',
  'scanner',
  'connector',
  'mobile',
  'import',
  'api',
  'plugin',
  'derived',
];

export interface IngestFlags extends LibraryFlags, OcrFlags, PipelineConfigFlags {
  source?: string;
  sourceKind?: DocumentSourceKind;
  runLabel?: string;
  rules?: string;
  dryRun?: boolean;
  recursive?: boolean;
  skipHidden?: boolean;
  maxBytes?: number;
  progress?: boolean;
  full?: boolean;
  trace?: boolean;
}

const parseSourceKind = (value: string): DocumentSourceKind => {
  if (!(SOURCE_KINDS as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`expected one of ${SOURCE_KINDS.join(', ')}.`);
  }
  return value as DocumentSourceKind;
};

/**
 * One line of the per-file table.
 *
 * Every field is read back rather than remembered: the media type, the text layer and the OCR
 * status come from the `documents` row the pipeline wrote, the confidence and the reason from the
 * `review_queue` row the gate wrote or from the outcome itself, and the rules from the evaluation
 * the engine returned for that subject. None of it is a counter this command kept while deciding.
 */
interface FileRow {
  depth: number;
  path: string;
  sha256: string | null;
  mediaType: string;
  /** `documents.ocr_status`, with the text-layer flag folded in: what stages 4-6 recorded. */
  textState: string;
  status: IngestOutcome['status'];
  rules: string;
  confidence: number | null;
  detail: string;
}

/** The `documents` columns the table reads, by document id. */
interface DocumentFactsRow {
  mimeType: string;
  hasTextLayer: boolean | null;
  ocrStatus: string;
  textCharCount: number | null;
  pageCount: number | null;
}

const describeText = (facts: DocumentFactsRow | undefined): string => {
  if (facts === undefined) return '—';
  const layer = facts.hasTextLayer === null ? 'text layer unknown' : facts.hasTextLayer ? 'text layer' : 'no text layer';
  const chars = facts.textCharCount === null ? '' : ` ${String(facts.textCharCount)} chars`;
  return `${layer}, ocr ${facts.ocrStatus}${chars}`;
};

/* ------------------------------------------------------------------------------------------- */
/* Collecting candidates                                                                         */
/* ------------------------------------------------------------------------------------------- */

interface Collected {
  candidates: IngestCandidate[];
  skipped: Array<{ path: string; reason: string }>;
}

const collectCandidates = async (paths: readonly string[], flags: IngestFlags): Promise<Collected> => {
  const sourceId = flags.source ?? 'cli';
  const sourceKind = flags.sourceKind ?? 'upload';
  const candidates: IngestCandidate[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const raw of paths) {
    const path = resolve(raw);
    if (!existsSync(path)) {
      throw new CliError(`there is nothing at '${path}'.`, {
        exitCode: ExitCode.Usage,
        payload: { error: 'no_such_path', path },
      });
    }

    if (statSync(path).isDirectory()) {
      const scan = await folderCandidates(path, {
        sourceId,
        sourceKind,
        recursive: flags.recursive !== false,
        skipHidden: flags.skipHidden !== false,
        ...(flags.maxBytes === undefined ? {} : { maxBytes: flags.maxBytes }),
      });
      candidates.push(...scan.candidates);
      skipped.push(...scan.skipped);
      continue;
    }

    candidates.push(
      await fileCandidate(path, {
        sourceId,
        sourceKind,
        // The path as given is the candidate's identity, so re-ingesting the same file from the
        // same place is the same candidate and stage 2 answers it (P9).
        externalId: path,
      }),
    );
  }

  return { candidates, skipped };
};

/* ------------------------------------------------------------------------------------------- */
/* The run                                                                                       */
/* ------------------------------------------------------------------------------------------- */

interface RunOutput {
  report: IngestRunReport;
  rows: FileRow[];
  ruleWarnings: string[];
  traces: string[];
  reviewRows: ReviewQueueRow[];
}

const runAgainst = async (
  recueil: Recueil,
  candidates: readonly IngestCandidate[],
  flags: IngestFlags,
  ui: Ui,
  options: { runLabel: string; sourceId: string; mayWriteCollections: boolean },
): Promise<RunOutput> => {
  const { engine } = resolveOcrEngine(flags);
  const events = new EventBus((error, event) => {
    ui.warn(`an event subscriber failed on ${event.type}: ${String(error)}`);
  });

  const adapter =
    flags.rules === undefined
      ? null
      : new RulesEngineAdapter({
          recueil,
          actor: recueil.actor,
          ruleSet: asIngestionRuleSet(loadRuleSetFile(flags.rules), resolve(flags.rules)),
          createCollections: options.mayWriteCollections,
        });

  const pipeline = new IngestPipeline({
    recueil,
    ocr: engine,
    events,
    config: resolvePipelineConfig(flags),
    ...(adapter === null ? {} : { ruleEngine: adapter }),
  });

  const progress = new Progress(ui, { enabled: flags.progress !== false });
  let done = 0;
  events.on('*', (event) => {
    if (event.type === 'document.ingested' || event.type === 'document.duplicate') {
      done += 1;
      progress.update({ label: 'files', done, total: candidates.length });
    }
  });

  let report: IngestRunReport;
  try {
    report = await pipeline.run(candidates, {
      runLabel: options.runLabel,
      sourceId: options.sourceId,
      total: candidates.length,
      params: { command: 'ingest', files: candidates.length, dryRun: flags.dryRun === true },
    });
  } finally {
    progress.finish();
  }

  // Everything below is read back out of the library rather than accumulated while the run was
  // deciding. `document.ingested` carries `detectedType: 'unknown'` because it is emitted at stage
  // 2, before detection has happened, so the type detection's own effects are read from the
  // `documents` columns stages 4 to 6 wrote instead.
  const documentIds = [
    ...new Set(
      report.outcomes
        .flatMap((entry) => flatten(entry.outcome))
        .flatMap((outcome) => ('documentId' in outcome && outcome.documentId !== undefined ? [outcome.documentId] : [])),
    ),
  ];
  const facts = new Map<string, DocumentFactsRow>();
  if (documentIds.length > 0) {
    for (const row of recueil.db
      .select({
        id: schema.documents.id,
        mimeType: schema.documents.mimeType,
        hasTextLayer: schema.documents.hasTextLayer,
        ocrStatus: schema.documents.ocrStatus,
        textCharCount: schema.documents.textCharCount,
        pageCount: schema.documents.pageCount,
      })
      .from(schema.documents)
      .where(inArray(schema.documents.id, documentIds))
      .all()) {
      facts.set(row.id, row);
    }
  }

  const reviewRows = report.outcomes
    .flatMap((entry) => flatten(entry.outcome))
    .filter((outcome) => outcome.status === 'review')
    .map((outcome) =>
      recueil.db
        .select()
        .from(reviewQueue)
        .where(eq(reviewQueue.id, (outcome as Extract<IngestOutcome, { status: 'review' }>).reviewQueueEntryId))
        .get(),
    )
    .filter((row): row is ReviewQueueRow => row !== undefined);

  const rows: FileRow[] = [];
  for (const entry of report.outcomes) {
    appendRows(rows, entry.ref.externalId, entry.outcome, 0, facts, reviewRows, adapter);
  }

  const traces: string[] = [];
  const ruleWarnings: string[] = [];
  if (adapter !== null) {
    for (const evaluation of adapter.evaluations) {
      traces.push(renderTrace(evaluation.trace));
      for (const warning of evaluation.warnings) ruleWarnings.push(`${evaluation.subjectId}: ${warning}`);
    }
  }

  return { report, rows, ruleWarnings, traces, reviewRows };
};

const flatten = (outcome: IngestOutcome): IngestOutcome[] => [
  outcome,
  ...('members' in outcome && outcome.members !== undefined
    ? outcome.members.flatMap(flatten)
    : []),
];

const appendRows = (
  rows: FileRow[],
  path: string,
  outcome: IngestOutcome,
  depth: number,
  facts: ReadonlyMap<string, DocumentFactsRow>,
  reviewRows: readonly ReviewQueueRow[],
  adapter: RulesEngineAdapter | null,
): void => {
  const documentId = 'documentId' in outcome ? outcome.documentId : undefined;
  const documentFacts = documentId === undefined ? undefined : facts.get(documentId);
  const entry = outcome.status === 'review' ? reviewRows.find((row) => row.id === outcome.reviewQueueEntryId) : undefined;
  const evaluation = adapter?.forSubject(path);

  rows.push({
    depth,
    path,
    sha256: 'sha256' in outcome && outcome.sha256 !== undefined ? outcome.sha256 : null,
    mediaType: documentFacts?.mimeType ?? '—',
    textState: describeText(documentFacts),
    status: outcome.status,
    rules:
      evaluation === undefined
        ? '—'
        : evaluation.trace.matchedRuleIds.length === 0
          ? '(none matched)'
          : evaluation.trace.matchedRuleIds.join(', '),
    confidence:
      outcome.status === 'ingested'
        ? outcome.confidence
        : (entry?.confidence ?? null),
    detail: describe(outcome, entry),
  });

  if ('members' in outcome && outcome.members !== undefined) {
    for (const member of outcome.members) {
      appendRows(rows, '↳ member', member, depth + 1, facts, reviewRows, adapter);
    }
  }
};

const describe = (outcome: IngestOutcome, entry: ReviewQueueRow | undefined): string => {
  switch (outcome.status) {
    case 'ingested':
      return `item ${outcome.itemId}`;
    case 'duplicate':
      return `already held as ${outcome.documentId}`;
    case 'review':
      return `${outcome.reasonCode}${entry === undefined ? '' : ` — ${entry.explanation}`}`;
    case 'container':
      return `${outcome.members.length} member(s)`;
    case 'stopped':
      return `${outcome.reasonCode} — ${outcome.explanation}`;
    case 'failed':
      return `${outcome.code} — ${outcome.message}`;
  }
};

/* ------------------------------------------------------------------------------------------- */
/* Reporting                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** How many rows the table prints before it says "and N more". */
const ROW_PREVIEW = 40;

const printSummary = (
  ui: Ui,
  output: RunOutput,
  context: { dryRun: boolean; files: number; skipped: readonly { path: string; reason: string }[]; full: boolean; trace: boolean },
): void => {
  const { bold, dim, green, red, yellow } = ui.colour;
  const { report, rows } = output;

  ui.out('');
  ui.out(bold(context.dryRun ? 'Ingest — dry run' : 'Ingest'));
  ui.out('');

  const shown = context.full ? rows : rows.slice(0, ROW_PREVIEW);
  for (const line of renderTable(
    [
      { header: 'File' },
      { header: 'Media' },
      { header: 'Text' },
      { header: 'Rules' },
      { header: 'Conf.', align: 'right' },
      { header: 'Outcome' },
      { header: 'Detail' },
    ],
    shown.map((row) => [
      `${'  '.repeat(row.depth)}${basename(row.path)}`,
      row.mediaType,
      row.textState,
      row.rules,
      row.confidence === null ? '—' : row.confidence.toFixed(2),
      row.status,
      row.detail,
    ]),
  )) {
    ui.out(`  ${line}`);
  }
  if (!context.full && rows.length > shown.length) {
    ui.out(`  … and ${rows.length - shown.length} more (run again with --full)`);
  }

  ui.out('');
  for (const line of renderTable(
    [{ header: 'What' }, { header: 'Count', align: 'right' }],
    [
      ['files offered', count(context.files)],
      ['ingested', count(report.counts.ingested)],
      ['already held', count(report.counts.duplicates)],
      ['routed to review', count(report.counts.review)],
      ['archives opened', count(report.counts.containers)],
      ['refused by a rule', count(report.counts.stopped)],
      ['failed', count(report.counts.failed)],
      ['entries not offered', count(context.skipped.length)],
    ],
  )) {
    ui.out(`  ${line}`);
  }

  if (context.skipped.length > 0) {
    ui.out('');
    ui.out(`  ${yellow('not offered')} — seen and not read:`);
    ui.out('');
    const list = context.full ? context.skipped : context.skipped.slice(0, ROW_PREVIEW);
    for (const line of renderTable(
      [{ header: 'Path' }, { header: 'Reason' }],
      list.map((entry) => [entry.path, entry.reason]),
    )) {
      ui.out(`  ${line}`);
    }
    if (!context.full && context.skipped.length > list.length) {
      ui.out(`  … and ${context.skipped.length - list.length} more (run again with --full)`);
    }
  }

  if (output.ruleWarnings.length > 0) {
    ui.out('');
    ui.out(`  ${yellow('rules')} — reported rather than applied:`);
    for (const warning of output.ruleWarnings.slice(0, context.full ? Infinity : 20)) {
      ui.out(`    ${warning}`);
    }
  }

  ui.out('');
  for (const line of renderTable(
    [{ header: 'Verification' }, { header: 'Result' }, { header: 'Detail' }],
    report.verification.checks.map((check) => [check.id, check.ok ? 'pass' : 'FAIL', check.detail]),
  )) {
    ui.out(`  ${line}`);
  }

  ui.out('');
  ui.out(`  duration         ${duration(Date.parse(report.finishedAt) - Date.parse(report.startedAt))}`);
  ui.out(`  scratch cleaned  ${report.scratchClean ? 'yes' : 'NO — see the scratch root'}`);
  ui.out(`  run              ${report.runId}${report.resumed ? ' (resumed)' : ''}`);

  ui.out('');
  if (!report.verification.pass) {
    ui.out(`  ${red('FAIL')} — the run's own verification did not pass; the counts above disagree with the library.`);
  } else if (report.counts.failed > 0) {
    ui.out(`  ${red('FAIL')} — ${count(report.counts.failed)} file(s) could not be ingested.`);
  } else if (report.counts.review > 0) {
    ui.out(
      `  ${yellow('REVIEW')} — ${count(report.counts.review)} document(s) need a decision: ` +
        '`recueil review list`.',
    );
  } else {
    ui.out(`  ${green('OK')} — everything offered was filed or already held.`);
  }

  if (context.trace && output.traces.length > 0) {
    ui.out('');
    ui.out(bold('  Rule traces'));
    for (const trace of output.traces) {
      ui.out('');
      for (const line of trace.split('\n')) ui.out(`  ${line}`);
    }
  }

  if (context.dryRun) {
    ui.out('');
    ui.out(dim('  Nothing was written: this was a dry run against a consistent copy of the library.'));
  }
  ui.out('');
};

export const exitCodeFor = (report: IngestRunReport): number => {
  if (!report.verification.pass || report.counts.failed > 0) return ExitCode.JobFailed;
  return report.counts.review > 0 || report.counts.stopped > 0 ? ExitCode.Review : ExitCode.Success;
};

/* ------------------------------------------------------------------------------------------- */

export const runIngest = async (paths: readonly string[], flags: IngestFlags, ui: Ui): Promise<void> => {
  if (paths.length === 0) {
    throw new CliError('nothing to ingest: give at least one file or directory.', {
      exitCode: ExitCode.Usage,
      detail: ['', '  recueil ingest ~/Scans/2026-08-19.pdf', '  recueil ingest ~/Consume --source scanner'],
    });
  }

  const location = resolveLibraryLocation(flags);
  const sourceId = flags.source ?? 'cli';
  const runLabel = flags.runLabel ?? `cli-${new Date().toISOString()}`;
  const { label: ocrLabel } = resolveOcrEngine(flags);

  const collected = await collectCandidates(paths, flags);

  ui.info(`library    ${location.databaseUrl} (${location.origin.database})`);
  ui.info(`storage    ${location.storagePath} (${location.origin.storage})`);
  ui.info(`source     ${sourceId} (${flags.sourceKind ?? 'upload'})`);
  ui.info(`ocr        ${ocrLabel}`);
  ui.info(`rules      ${flags.rules === undefined ? '(none)' : resolve(flags.rules)}`);
  ui.info(`threshold  ${effectiveThreshold(flags).toFixed(2)}`);
  ui.info(`run label  ${runLabel}`);
  ui.info(`offering   ${collected.candidates.length} file(s)`);
  ui.info('');

  if (collected.candidates.length === 0) {
    throw new CliError('none of the given paths held a file the pipeline could take.', {
      exitCode: ExitCode.Usage,
      detail: ['', ...collected.skipped.slice(0, 20).map((entry) => `  ${entry.path}: ${entry.reason}`)],
      payload: { error: 'no_candidates', skipped: collected.skipped },
    });
  }

  const output =
    flags.dryRun === true
      ? await dryRun(collected.candidates, flags, ui, location, { runLabel, sourceId })
      : await withLibrary(location, {}, async (recueil) =>
          runAgainst(recueil, collected.candidates, flags, ui, {
            runLabel,
            sourceId,
            mayWriteCollections: true,
          }),
        );

  finish(output, ui, {
    dryRun: flags.dryRun === true,
    files: collected.candidates.length,
    skipped: collected.skipped,
    full: flags.full === true,
    trace: flags.trace === true || ui.verbose,
  });
};

/**
 * The dry run.
 *
 * A consistent copy of the real library, so the answer accounts for what is already in it, and a
 * store that hashes and discards. Both go away with the temporary directory. The search index of
 * the copy is deliberately left alone: `SearchService.rebuild()` re-indexes items and notes only
 * and would drop every document's extracted text, which is the half a scan is findable by.
 */
const dryRun = async (
  candidates: readonly IngestCandidate[],
  flags: IngestFlags,
  ui: Ui,
  location: ResolvedLibrary,
  options: { runLabel: string; sourceId: string },
): Promise<RunOutput> => {
  const scratch = mkdtempSync(join(tmpdir(), 'recueil-ingest-dry-run-'));
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

    const recueil = createRecueil({ databaseUrl: databaseFile, storagePath: scratch, storage });
    try {
      const output = await runAgainst(recueil, candidates, flags, ui, {
        ...options,
        mayWriteCollections: true,
      });
      const would = storage.summary;
      ui.detail(`would store ${String(would.blobs)} blob(s), ${String(would.bytes)} bytes`);
      return output;
    } finally {
      recueil.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const finish = (
  output: RunOutput,
  ui: Ui,
  context: { dryRun: boolean; files: number; skipped: readonly { path: string; reason: string }[]; full: boolean; trace: boolean },
): void => {
  if (ui.json) {
    ui.outJson({
      command: 'ingest',
      dryRun: context.dryRun,
      exitCode: exitCodeFor(output.report),
      files: context.files,
      skipped: context.skipped,
      counts: output.report.counts,
      verification: output.report.verification,
      scratchClean: output.report.scratchClean,
      runId: output.report.runId,
      resumed: output.report.resumed,
      results: output.rows,
      review: output.reviewRows.map((row) => ({
        id: row.id,
        documentId: row.subjectId,
        reasonCode: row.reasonCode,
        explanation: row.explanation,
        confidence: row.confidence,
        severity: row.severity,
        proposedAction: row.proposedAction,
      })),
      ruleWarnings: output.ruleWarnings,
      ...(context.trace ? { traces: output.traces } : {}),
    });
  } else {
    printSummary(ui, output, context);
  }

  process.exitCode = exitCodeFor(output.report);
};

/* ------------------------------------------------------------------------------------------- */

export const registerIngest = (
  parent: Command,
  describe_: (name: string) => string,
  ui: () => Ui,
): Command => {
  const command = parent
    .command('ingest')
    .description(describe_('ingest'))
    .argument('[path...]', 'files or directories to push through the pipeline')
    .option('-d, --database <url>', 'the library to ingest into (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)')
    .option('--source <id>', 'the source id recorded against every arrival', 'cli')
    .option('--source-kind <kind>', `documents.source_kind: ${SOURCE_KINDS.join(', ')}`, parseSourceKind)
    .option('--run-label <label>', 'names the run; the same label resumes an interrupted one')
    .option('--rules <file>', 'an ingestion rule set (YAML or JSON) to evaluate at stage 8')
    .option('-n, --dry-run', 'run against a throwaway copy of the library and report', false)
    .option('--ocr <engine>', `stage 5 adapter: ${OCR_ENGINES.join(', ')}`, parseOcrEngine)
    .option('--ocr-corpus <file>', 'the corpus the `fake` engine recognises (sha256 → text)')
    .option('--ocr-binary <path>', 'the ocrmypdf executable, or a wrapper around one')
    .option('--ocr-lang <code>', 'OCR language, repeatable', collectValues, [])
    .option('--concurrency <n>', 'candidates in flight at once', parsePositiveInteger)
    .option('--threshold <n>', 'the stage-9 confidence gate, 0..1', parseUnitInterval)
    .option('--scratch <dir>', 'where archives are unpacked before hashing')
    .option('--max-archive-depth <n>', 'archives inside archives', parsePositiveInteger)
    .option('--max-bytes <n>', 'refuse a file larger than this rather than reading it', parsePositiveInteger)
    .option('--no-recursive', 'do not descend into subdirectories')
    .option('--no-skip-hidden', 'offer dot-files too')
    .option('--trace', 'print the full rule trace for every file', false)
    .option('--full', 'list every row rather than the first few', false)
    .option('--no-progress', 'do not draw the progress display')
    .addHelpText(
      'after',
      [
        '',
        'The ten stages are CONCEPT.md §5.3: hash, duplicate check, archive extraction, type',
        'detection, OCR, metadata extraction, identifier resolution, rules, confidence gate,',
        'commit. A run is idempotent by (hash, source, path) and resumable by --run-label.',
        '',
        'OCR',
        '  --ocr none      the default. Scans are filed without text and routed to review.',
        '  --ocr ocrmypdf  shells out to a real ocrmypdf. No test in this build exercises it.',
        '  --ocr fake      the in-process engine, driven by --ocr-corpus. It proves the route —',
        '                  no text layer, engine called, text indexed, document findable — and it',
        '                  recognises nothing it has not been given.',
        '',
        'Safety',
        '  A path inside a directory is resolved with realpath and refused if it leaves the root,',
        '  and an archive member that climbs out of its scratch directory is refused by name. Both',
        '  are reported: a file that was not offered is listed with the reason.',
        '',
        'Exit codes',
        '  0  everything offered was filed or already held',
        '  4  filed, but documents were routed to the review queue or refused by a rule',
        '  5  a file failed, or the run\'s own verification did not pass',
        '',
        'Examples:',
        '  recueil ingest ~/Scans/2026-08-19.pdf',
        '  recueil ingest ~/Consume --source scanner --source-kind scanner --rules office.yaml',
        '  recueil ingest ~/Consume --dry-run --trace',
      ].join('\n'),
    );

  registerIngestWatch(command, ui);

  command.action(async (paths: string[], flags: IngestFlags) => {
    await runIngest(paths, flags, ui());
  });

  return command;
};
