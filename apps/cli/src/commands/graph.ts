/**
 * `recueil graph` — the citation graph and the bibliometric exports (CONCEPT §5.8, Phase 5).
 *
 *   recueil graph collect                 reference lists from the resolvers into the graph
 *   recueil graph derive co-citation      or coupling, normalised (association strength by default)
 *   recueil graph export --format wos     Web of Science plain text for bibliometrix / biblioshiny
 *   recueil graph export --format vosviewer|gexf|graphml [--network citations|local|co-citation|coupling]
 *   recueil graph export --format csv --table works|creators|works_creators|terms|works_terms|edges|metrics
 *   recueil graph coverage                which items have reference data, from which sources
 *   recueil graph top                     the most-cited works not in the library
 *   recueil graph promote <shadow-id>     bring one of them into the library
 */
import { writeFileSync } from 'node:fs';

import { analyticsTables, describeNetwork, toCsv, toGexf, toGraphml, toVosviewerJson, toWosPlaintext } from '@recueil/analytics';
import type { AnalyticsTable } from '@recueil/analytics';
import type { Network, Recueil } from '@recueil/core';
import { CitationEngine } from '@recueil/plugin-host';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, withLibrary } from '../library.js';
import type { LibraryFlags } from '../library.js';
import { bootHost } from '../plugins.js';
import type { Ui } from '../ui.js';

const choice =
  <T extends string>(values: readonly T[]) =>
  (value: string): T => {
    if (!(values as readonly string[]).includes(value)) throw new InvalidArgumentError(values.join(' | '));
    return value as T;
  };

const lib = (command: Command): Command =>
  command
    .option('-d, --database <url>', 'the Recueil library (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)');

const NETWORKS = ['citations', 'local', 'co-citation', 'coupling'] as const;
type NetworkName = (typeof NETWORKS)[number];

const networkOf = (recueil: Recueil, name: NetworkName): Network => {
  switch (name) {
    case 'citations':
      return recueil.graph.citationNetwork();
    case 'local':
      return recueil.graph.citationNetwork({ localOnly: true });
    case 'co-citation':
      return recueil.graph.derivedNetwork('co_cited');
    case 'coupling':
      return recueil.graph.derivedNetwork('coupled');
  }
};

const emit = (text: string, output: string | undefined, ui: Ui): void => {
  if (output === undefined) process.stdout.write(text);
  else {
    writeFileSync(output, text);
    ui.info(`wrote ${output}`);
  }
};

export const registerGraph = (parent: Command, describe: (name: string) => string, ui: () => Ui): Command => {
  const graph = parent.command('graph').description(describe('graph'));

  lib(
    graph
      .command('collect')
      .description('Fetch reference lists from the resolvers and record them as citations')
      .option('--sources <list>', 'only these sources, e.g. openalex,crossref', (value) => value.split(','))
      .option('--max <n>', 'references per item per source (default 500)', Number),
  ).action(async (flags: LibraryFlags & { sources?: string[]; max?: number }) => {
    await withLibrary(resolveLibraryLocation(flags), {}, async (recueil) => {
      const host = await bootHost(recueil, ui());
      if (!host.resolvers().some((hook) => hook.impl.supports.references)) {
        throw new CliError('no resolver with reference lists is active: run `recueil plugin enable @recueil/plugin-resolvers-core`', { exitCode: ExitCode.Usage });
      }
      const result = await new CitationEngine(recueil, host).collect({
        ...(flags.sources === undefined ? {} : { sources: flags.sources }),
        ...(flags.max === undefined ? {} : { maxPerItem: flags.max }),
      });
      if (ui().json) return ui().outJson({ command: 'graph.collect', result });
      ui().out(`${result.items} items, ${result.withReferences} with reference lists, ${result.edges} new citations`);
      for (const [source, stats] of Object.entries(result.bySource)) {
        ui().out(`  ${source}: ${stats.items} items, ${stats.edges} citations${stats.errors > 0 ? `, ${stats.errors} errors` : ''}`);
      }
      process.exitCode = result.errors.length > 0 ? ExitCode.Review : ExitCode.Success;
    });
  });

  lib(
    graph
      .command('derive')
      .description('Compute a derived network from the citations')
      .argument('<kind>', 'co-citation | coupling', choice(['co-citation', 'coupling'] as const))
      .option('--min-weight <n>', 'drop pairs seen fewer times (default 1)', Number)
      .option('--normalisation <how>', 'association_strength (default) | salton | none', choice(['association_strength', 'salton', 'none'] as const)),
  ).action(async (kind: 'co-citation' | 'coupling', flags: LibraryFlags & { minWeight?: number; normalisation?: 'association_strength' | 'salton' | 'none' }) => {
    await withLibrary(resolveLibraryLocation(flags), { mustExist: true }, async (recueil) => {
      const run = recueil.graph.derive(kind === 'co-citation' ? 'co_cited' : 'coupled', {
        ...(flags.minWeight === undefined ? {} : { minWeight: flags.minWeight }),
        ...(flags.normalisation === undefined ? {} : { normalisation: flags.normalisation }),
      });
      ui().out(`${kind}: ${run.edges} links (run ${run.runId})`);
    });
  });

  lib(
    graph
      .command('export')
      .description('Export a network or the analytics tables')
      .requiredOption('--format <format>', 'wos | vosviewer | gexf | graphml | csv', choice(['wos', 'vosviewer', 'gexf', 'graphml', 'csv'] as const))
      .option('--network <name>', 'citations (default) | local | co-citation | coupling', choice(NETWORKS))
      .option('--table <table>', 'for csv: works | creators | works_creators | terms | works_terms | edges | metrics', choice(['works', 'creators', 'works_creators', 'terms', 'works_terms', 'edges', 'metrics'] as const))
      .option('-o, --output <file>', 'write here instead of stdout'),
  ).action(async (flags: LibraryFlags & { format: 'wos' | 'vosviewer' | 'gexf' | 'graphml' | 'csv'; network?: NetworkName; table?: AnalyticsTable; output?: string }) => {
    await withLibrary(resolveLibraryLocation(flags), { mustExist: true }, async (recueil) => {
      if (flags.format === 'wos') {
        const ids = recueil.library.listItems({ limit: 10_000 }).data.map((row) => row.id);
        return emit(toWosPlaintext(recueil, ids), flags.output, ui());
      }
      if (flags.format === 'csv') {
        if (flags.table === undefined) throw new CliError('--format csv needs --table', { exitCode: ExitCode.Usage });
        return emit(toCsv(analyticsTables(recueil, flags.table)), flags.output, ui());
      }
      const name = flags.network ?? 'citations';
      const network = describeNetwork(recueil, networkOf(recueil, name), `${name} network`);
      const text = flags.format === 'vosviewer' ? toVosviewerJson(network) : flags.format === 'gexf' ? toGexf(network) : toGraphml(network);
      emit(text, flags.output, ui());
    });
  });

  lib(graph.command('coverage').description('Which items have reference data, from which sources, fetched when')).action(async (flags: LibraryFlags) => {
    await withLibrary(resolveLibraryLocation(flags), { mustExist: true }, async (recueil) => {
      const coverage = recueil.graph.coverage();
      if (ui().json) return ui().outJson({ command: 'graph.coverage', coverage });
      ui().out(`${coverage.withReferences} of ${coverage.items} items have reference data`);
      for (const source of coverage.bySource) ui().out(`  ${source.source}: ${source.items} items, ${source.edges} citations, last ${source.lastFetchedAt ?? '—'}`);
    });
  });

  lib(graph.command('top').description('The works your library cites most that are not in it').option('--limit <n>', 'how many (default 20)', Number)).action(
    async (flags: LibraryFlags & { limit?: number }) => {
      await withLibrary(resolveLibraryLocation(flags), { mustExist: true }, async (recueil) => {
        const rows = recueil.graph.topShadowWorks(flags.limit ?? 20);
        if (ui().json) return ui().outJson({ command: 'graph.top', works: rows });
        for (const row of rows) ui().out(`${row.seenCount}×  ${row.title ?? row.doi ?? row.sourceId}${row.issuedYear ? ` (${row.issuedYear})` : ''}  ${row.id}`);
      });
    },
  );

  lib(graph.command('promote').description('Bring a cited work into the library').argument('<shadowWorkId>', 'from `recueil graph top`')).action(
    async (id: string, flags: LibraryFlags) => {
      await withLibrary(resolveLibraryLocation(flags), { mustExist: true }, async (recueil) => {
        const itemId = recueil.graph.promoteShadowWork(id, recueil.actor);
        ui().out(`Promoted to item ${itemId}. Run \`recueil enrich --item ${itemId}\` to fill in its metadata.`);
      });
    },
  );

  return graph;
};
