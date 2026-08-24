/**
 * `recueil ingest watch` — the configured sources, in the foreground.
 *
 * CONCEPT.md §5.3 lists the sources and says they all feed the same pipeline. `recueil serve` runs
 * them inside the server; this command runs them in front of you, which is what you want on the
 * afternoon you are working out why the scanner's drop folder is not producing items. It is the
 * same `SourceRunner` over the same `IngestPipeline`, so what it does is what the server does.
 *
 * **Where "configured" comes from, and what this command cannot do.** The server keeps configured
 * sources in an `ingestion_sources` table, and a WebDAV or IMAP source's password is stored there
 * encrypted with `RECUEIL_SECRET_KEY` — held by `apps/server`, which does not export the box that
 * opens it. So this command reads the table, runs the folder sources, and **names** the WebDAV and
 * IMAP rows it cannot open rather than skipping them silently: a watch that quietly ignored half
 * the configuration would be worse than one that refuses. Those run under `recueil serve`.
 *
 * `--folder` adds a watched directory that is not in the table at all, which is the shape this is
 * usually reached for: point it at a directory, watch what the pipeline makes of it, stop.
 *
 * Nothing on the far side is moved or deleted until `@recueil/ingest-sources` has re-read the bytes
 * out of the content store and matched them against their `documents` row. `--consume delete` is
 * refused by that package when the check has not passed, and this command does not override it.
 */
import { resolve } from 'node:path';

import type { Recueil } from '@recueil/core';
import { EventBus, IngestPipeline } from '@recueil/ingest';
import type { IngestRule } from '@recueil/ingest';
import { FolderSource, SourceRunner } from '@recueil/ingest-sources';
import type { ConsumePolicy, IngestSource, SourceRunReport } from '@recueil/ingest-sources';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import {
  OCR_ENGINES,
  asIngestionRuleSet,
  collectValues,
  loadRuleSetFile,
  parseOcrEngine,
  parsePositiveInteger,
  parseUnitInterval,
  resolveOcrEngine,
  resolvePipelineConfig,
} from '../ingest-options.js';
import type { OcrFlags, PipelineConfigFlags } from '../ingest-options.js';
import { resolveLibraryLocation, withLibrary, type LibraryFlags } from '../library.js';
import { RulesEngineAdapter } from '../rule-engine.js';
import { count, renderTable } from '../table.js';
import type { Ui } from '../ui.js';

export interface WatchFlags extends LibraryFlags, OcrFlags, PipelineConfigFlags {
  folder?: string[];
  sourceKind?: string;
  once?: boolean;
  interval?: number;
  passes?: number;
  quietMs?: number;
  consume?: 'leave' | 'move' | 'delete';
  moveTo?: string;
  rules?: string;
  limit?: number;
  configured?: boolean;
}

const parseConsume = (value: string): 'leave' | 'move' | 'delete' => {
  if (value !== 'leave' && value !== 'move' && value !== 'delete') {
    throw new InvalidArgumentError('expected leave, move or delete.');
  }
  return value;
};

const parseNonNegativeInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError('expected a whole number.');
  return parsed;
};

/* ------------------------------------------------------------------------------------------- */
/* The configured sources                                                                        */
/* ------------------------------------------------------------------------------------------- */

interface ConfiguredRow {
  id: string;
  name: string;
  kind: string;
  enabled: number;
  source_kind: string;
  config: string;
  consume_mode: string;
  consume_to: string | null;
}

export interface SourcePlan {
  sources: IngestSource[];
  /** Rows this command read and could not run, with the reason. Named, never skipped in silence. */
  refused: Array<{ name: string; kind: string; reason: string }>;
}

/**
 * Read `ingestion_sources`, if the server has ever created it.
 *
 * Raw SQL rather than a Drizzle table, because the table belongs to `apps/server` and is not in the
 * data model's migration series; a schema this command declared would be a second definition that
 * could drift from the first. The read is defensive: an absent table means "no sources configured",
 * which is the true answer on a library that has only ever been used from the command line.
 */
export const readConfiguredSources = (recueil: Recueil, flags: WatchFlags): SourcePlan => {
  const plan: SourcePlan = { sources: [], refused: [] };

  const table = recueil.connection
    .prepare(`select name from sqlite_master where type = 'table' and name = 'ingestion_sources'`)
    .get() as { name: string } | undefined;
  if (table === undefined) return plan;

  const rows = recueil.connection
    .prepare(
      `select id, name, kind, enabled, source_kind, config, consume_mode, consume_to
         from ingestion_sources
        order by name`,
    )
    .all() as ConfiguredRow[];

  for (const row of rows) {
    if (row.enabled === 0) {
      plan.refused.push({ name: row.name, kind: row.kind, reason: 'the source is disabled' });
      continue;
    }
    if (row.kind !== 'folder') {
      plan.refused.push({
        name: row.name,
        kind: row.kind,
        reason:
          'its credential is stored encrypted with RECUEIL_SECRET_KEY, which only the server can ' +
          'open; run this source under `recueil serve`',
      });
      continue;
    }

    let config: { root?: unknown; recursive?: unknown; skipHidden?: unknown; exclude?: unknown; minimumAgeMillis?: unknown };
    try {
      config = JSON.parse(row.config) as typeof config;
    } catch (error) {
      plan.refused.push({ name: row.name, kind: row.kind, reason: `its configuration is not JSON: ${String(error)}` });
      continue;
    }
    if (typeof config.root !== 'string') {
      plan.refused.push({ name: row.name, kind: row.kind, reason: 'its configuration names no root' });
      continue;
    }

    plan.sources.push(
      new FolderSource({
        id: row.name,
        root: config.root,
        sourceKind: row.source_kind as never,
        ...(typeof config.recursive === 'boolean' ? { recursive: config.recursive } : {}),
        ...(typeof config.skipHidden === 'boolean' ? { skipHidden: config.skipHidden } : {}),
        ...(Array.isArray(config.exclude) ? { exclude: config.exclude as string[] } : {}),
        stability: stabilityFor(flags, typeof config.minimumAgeMillis === 'number' ? config.minimumAgeMillis : undefined),
        consume: consumeFor(row.consume_mode, row.consume_to),
        // A watched folder never pushes while this command is running its own loop: the loop is the
        // truth, and a filesystem event racing a poll would run the same source twice.
        watch: { enabled: false },
      }),
    );
  }

  return plan;
};

const stabilityFor = (flags: WatchFlags, configured?: number): { quietMillis: number } | undefined => {
  const quiet = flags.quietMs ?? configured;
  return quiet === undefined ? undefined : { quietMillis: quiet };
};

const consumeFor = (mode: string, to: string | null): ConsumePolicy => {
  if (mode === 'delete') return { mode: 'delete' };
  if (mode === 'move') return { mode: 'move', to: to ?? '.processed' };
  return { mode: 'leave' };
};

const adHocSources = (flags: WatchFlags): IngestSource[] =>
  (flags.folder ?? []).map((folder) => {
    const root = resolve(folder);
    const stability = stabilityFor(flags);
    return new FolderSource({
      root,
      ...(flags.sourceKind === undefined ? {} : { sourceKind: flags.sourceKind as never }),
      ...(stability === undefined ? {} : { stability }),
      consume:
        flags.consume === 'move'
          ? { mode: 'move', to: flags.moveTo ?? '.processed' }
          : flags.consume === 'delete'
            ? { mode: 'delete' }
            : { mode: 'leave' },
      watch: { enabled: false },
    });
  });

/* ------------------------------------------------------------------------------------------- */
/* The loop                                                                                      */
/* ------------------------------------------------------------------------------------------- */

interface PassSummary {
  sourceId: string;
  offered: number;
  ingested: number;
  duplicates: number;
  review: number;
  failed: number;
  acknowledged: number;
  refusedAcks: number;
  skipped: number;
  ok: boolean;
  error?: string;
}

const summarise = (report: SourceRunReport): PassSummary => ({
  sourceId: report.sourceId,
  offered: report.offered,
  ingested: report.pipeline?.counts.ingested ?? 0,
  duplicates: report.pipeline?.counts.duplicates ?? 0,
  review: report.pipeline?.counts.review ?? 0,
  failed: report.pipeline?.counts.failed ?? 0,
  acknowledged: report.acknowledgements.filter((entry) => entry.action !== 'refused').length,
  refusedAcks: report.acknowledgements.filter((entry) => entry.action === 'refused').length,
  skipped: report.skipped.length,
  ok: report.ok,
  ...(report.error === undefined ? {} : { error: report.error.message }),
});

export const runIngestWatch = async (flags: WatchFlags, ui: Ui): Promise<void> => {
  const location = resolveLibraryLocation(flags);
  const { engine, label: ocrLabel } = resolveOcrEngine(flags);

  await withLibrary(location, {}, async (recueil) => {
    const configured =
      flags.configured === false ? { sources: [], refused: [] } : readConfiguredSources(recueil, flags);
    const sources = [...adHocSources(flags), ...configured.sources];

    if (sources.length === 0) {
      throw new CliError('there is nothing to watch.', {
        exitCode: ExitCode.Usage,
        detail: [
          '',
          '  No enabled folder source is configured in this library and no --folder was given.',
          '',
          ...(configured.refused.length === 0
            ? ['  Add one with `recueil ingest watch --folder ~/Consume`, or configure it through',
               '  the API so that `recueil serve` runs it too.']
            : ['  These configured sources were read and not run:',
               '',
               ...configured.refused.map((entry) => `    ${entry.name} (${entry.kind}): ${entry.reason}`)]),
        ],
        payload: { error: 'no_sources', refused: configured.refused },
      });
    }

    const adapter =
      flags.rules === undefined
        ? null
        : new RulesEngineAdapter({
            recueil,
            actor: recueil.actor,
            ruleSet: asIngestionRuleSet(loadRuleSetFile(flags.rules), resolve(flags.rules)),
            createCollections: true,
          });

    const rules: IngestRule[] = SourceRunner.rulesFor(...sources);
    const events = new EventBus();
    const pipeline = new IngestPipeline({
      recueil,
      ocr: engine,
      events,
      rules,
      config: resolvePipelineConfig(flags),
      ...(adapter === null ? {} : { ruleEngine: adapter }),
    });

    const runners = sources.map(
      (source) =>
        new SourceRunner({
          source,
          pipeline,
          recueil,
          ...(flags.limit === undefined ? {} : { limit: flags.limit }),
          onLog: (entry) => {
            if (entry.level === 'error') ui.warn(`${entry.sourceId}: ${entry.message}`);
            else ui.detail(`${entry.sourceId}: ${entry.message}`);
          },
        }),
    );

    ui.info(`library    ${location.databaseUrl} (${location.origin.database})`);
    ui.info(`storage    ${location.storagePath} (${location.origin.storage})`);
    ui.info(`ocr        ${ocrLabel}`);
    ui.info(`sources    ${sources.map((source) => source.id).join(', ')}`);
    for (const entry of configured.refused) {
      ui.warn(`${entry.name} (${entry.kind}) was not started: ${entry.reason}`);
    }
    ui.info('');

    let stopping = false;
    const onSignal = (): void => {
      if (stopping) return;
      stopping = true;
      ui.info('');
      ui.info('stopping…');
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const passes: PassSummary[] = [];
    const maxPasses = flags.once === true ? 1 : (flags.passes ?? Number.POSITIVE_INFINITY);
    const interval = flags.interval ?? 5_000;

    /*
     * Keep the process alive for the duration of the loop.
     *
     * Every wait inside the sources — the folder's stability check, this file's own gap between
     * passes — is on an unref'd timer, so that a pending wait can never be the reason a server
     * refuses to shut down. In a *foreground* command that leaves nothing holding the event loop
     * open between two synchronous SQLite calls, and Node exits mid-pass with an unsettled
     * promise and no output at all. One ref'd timer for the length of the run is what makes the
     * command wait for its own work; it is cleared in the `finally` below, so it cannot outlive it.
     */
    const keepAlive = setInterval(() => {}, 60_000);

    try {
      for (const runner of runners) await runner.start();

      let pass = 0;
      while (!stopping && pass < maxPasses) {
        pass += 1;
        for (const runner of runners) {
          if (stopping) break;
          const report = await runner.runOnce();
          const summary = summarise(report);
          passes.push(summary);
          if (!ui.json) printPass(ui, pass, summary);
        }
        if (stopping || pass >= maxPasses) break;
        await sleep(interval, () => stopping);
      }
    } finally {
      clearInterval(keepAlive);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      for (const runner of runners) {
        try {
          await runner.stop();
        } catch (error) {
          ui.warn(`a source did not stop cleanly: ${String(error)}`);
        }
      }
    }

    finish(passes, ui);
    return undefined;
  });
};

const sleep = (millis: number, stopped: () => boolean): Promise<void> =>
  new Promise((done) => {
    const started = Date.now();
    const tick = (): void => {
      if (stopped() || Date.now() - started >= millis) {
        done();
        return;
      }
      const timer = setTimeout(tick, Math.min(200, millis));
      timer.unref?.();
    };
    tick();
  });

const printPass = (ui: Ui, pass: number, summary: PassSummary): void => {
  const { dim, red, yellow } = ui.colour;
  const parts = [
    `${summary.offered} offered`,
    `${summary.ingested} ingested`,
    `${summary.duplicates} already held`,
    `${summary.review} to review`,
  ];
  if (summary.failed > 0) parts.push(red(`${summary.failed} failed`));
  if (summary.refusedAcks > 0) parts.push(yellow(`${summary.refusedAcks} acknowledgement(s) refused`));
  if (summary.skipped > 0) parts.push(dim(`${summary.skipped} not offered`));
  ui.info(`  pass ${pass}  ${summary.sourceId}  ${parts.join(' · ')}`);
  if (summary.error !== undefined) ui.warn(`${summary.sourceId}: ${summary.error}`);
};

const finish = (passes: readonly PassSummary[], ui: Ui): void => {
  const totals = passes.reduce(
    (sum, pass) => ({
      offered: sum.offered + pass.offered,
      ingested: sum.ingested + pass.ingested,
      duplicates: sum.duplicates + pass.duplicates,
      review: sum.review + pass.review,
      failed: sum.failed + pass.failed,
      refusedAcks: sum.refusedAcks + pass.refusedAcks,
    }),
    { offered: 0, ingested: 0, duplicates: 0, review: 0, failed: 0, refusedAcks: 0 },
  );
  const ok = passes.every((pass) => pass.ok);

  if (ui.json) {
    ui.outJson({ command: 'ingest.watch', passes, totals, ok, exitCode: exitCodeFor(totals, ok) });
  } else {
    ui.out('');
    for (const line of renderTable(
      [{ header: 'What' }, { header: 'Count', align: 'right' }],
      [
        ['files offered', count(totals.offered)],
        ['ingested', count(totals.ingested)],
        ['already held', count(totals.duplicates)],
        ['routed to review', count(totals.review)],
        ['failed', count(totals.failed)],
        ['acknowledgements refused', count(totals.refusedAcks)],
      ],
    )) {
      ui.out(`  ${line}`);
    }
    ui.out('');
  }

  process.exitCode = exitCodeFor(totals, ok);
};

const exitCodeFor = (
  totals: { failed: number; review: number; refusedAcks: number },
  ok: boolean,
): number => {
  if (totals.failed > 0 || !ok) return ExitCode.JobFailed;
  return totals.review > 0 || totals.refusedAcks > 0 ? ExitCode.Review : ExitCode.Success;
};

/* ------------------------------------------------------------------------------------------- */

export const registerIngestWatch = (parent: Command, ui: () => Ui): Command =>
  parent
    .command('watch')
    .description('Run the configured sources in the foreground')
    .option('-d, --database <url>', 'the library to ingest into (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)')
    .option('--folder <path>', 'watch this directory as well; repeatable', collectValues, [])
    .option('--source-kind <kind>', "documents.source_kind for --folder sources (default 'folder')")
    .option('--no-configured', 'ignore the sources configured in the library; use --folder only')
    .option('--once', 'make one pass over every source and exit', false)
    .option('--passes <n>', 'stop after this many passes', parsePositiveInteger)
    .option('--interval <ms>', 'wait this long between passes', parsePositiveInteger)
    .option('--quiet-ms <ms>', 'how long a file must be untouched before it is offered', parseNonNegativeInteger)
    .option('--limit <n>', 'candidates taken from a source in one pass', parsePositiveInteger)
    .option('--consume <policy>', 'leave | move | delete, for --folder sources', parseConsume)
    .option('--move-to <dir>', "where --consume move puts an original (default '.processed')")
    .option('--rules <file>', 'an ingestion rule set (YAML or JSON) to evaluate at stage 8')
    .option('--ocr <engine>', `stage 5 adapter: ${OCR_ENGINES.join(', ')}`, parseOcrEngine)
    .option('--ocr-corpus <file>', 'the corpus the `fake` engine recognises (sha256 → text)')
    .option('--ocr-binary <path>', 'the ocrmypdf executable, or a wrapper around one')
    .option('--ocr-lang <code>', 'OCR language, repeatable', collectValues, [])
    .option('--concurrency <n>', 'candidates in flight at once', parsePositiveInteger)
    .option('--threshold <n>', 'the stage-9 confidence gate, 0..1', parseUnitInterval)
    .option('--scratch <dir>', 'where archives are unpacked before hashing')
    .addHelpText(
      'after',
      [
        '',
        'Sources come from two places: the `--folder` flags, and the sources configured in the',
        'library through the API. A configured WebDAV or IMAP source keeps its password encrypted',
        'with RECUEIL_SECRET_KEY, which only the server can open, so this command names those rows',
        'and does not run them — they belong to `recueil serve`.',
        '',
        'Ctrl-C finishes the pass in flight and stops. Nothing on the far side is moved or deleted',
        'until the bytes have been read back out of the content store and matched to their',
        'documents row, so an interrupted pass loses nothing.',
        '',
        'Exit codes',
        '  0  every pass completed and nothing needs a person',
        '  4  documents were routed to the review queue, or an acknowledgement was refused',
        '  5  a pass failed',
        '',
        'Examples:',
        '  recueil ingest watch --folder ~/Consume --once',
        '  recueil ingest watch --folder ~/Scans --source-kind scanner --consume move',
      ].join('\n'),
    )
    /**
     * The options are read with `optsWithGlobals`, not `opts`.
     *
     * `recueil ingest` and `recueil ingest watch` both declare `--database`, `--storage`, `--ocr`
     * and friends, and commander recognises a parent's options on both sides of a subcommand — so
     * `recueil ingest watch --database x` hands `--database` to `ingest`, and `watch.opts()` comes
     * back without it. Reading the merged view means the flag reaches the command it was written
     * for, whichever of the two commander decided owned it.
     */
    .action(async (_flags: WatchFlags, command: Command) => {
      await runIngestWatch(command.optsWithGlobals<WatchFlags>(), ui());
    });
