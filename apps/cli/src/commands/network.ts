/**
 * `recueil network` — curated networks, the figures for a publication (CONCEPT §5.9, Phase 6).
 *
 *   recueil network create "Figure 2" --from local     start a figure from the citation graph
 *   recueil network list
 *   recueil network freeze <id>                        fix the head version and its metadata
 *   recueil network export <id> --format svg|tikz|graphml|gexf [--version n] [-o file]
 *
 * Arranging the nodes is done in the web app; the CLI starts, freezes and exports figures.
 */
import { writeFileSync } from 'node:fs';

import { curatedToNetwork, curatedToSvg, curatedToTikz, toGexf, toGraphml } from '@recueil/analytics';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';

import { resolveLibraryLocation, withLibrary } from '../library.js';
import type { LibraryFlags } from '../library.js';
import type { Ui } from '../ui.js';

const lib = (command: Command): Command =>
  command
    .option('-d, --database <url>', 'the Recueil library (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)');

const choice =
  <T extends string>(values: readonly T[]) =>
  (value: string): T => {
    if (!(values as readonly string[]).includes(value)) throw new InvalidArgumentError(values.join(' | '));
    return value as T;
  };

export const registerNetwork = (parent: Command, describe: (name: string) => string, ui: () => Ui): Command => {
  const network = parent.command('network').description(describe('network'));

  lib(
    network
      .command('create')
      .description('Create a curated network')
      .argument('<name>', 'its name')
      .option('--from <network>', 'citations | local | co-citation | coupling — start from the graph', choice(['citations', 'local', 'co-citation', 'coupling'] as const)),
  ).action(async (name: string, flags: LibraryFlags & { from?: 'citations' | 'local' | 'co-citation' | 'coupling' }) => {
    await withLibrary(resolveLibraryLocation(flags), { mustExist: true }, async (recueil) => {
      const source =
        flags.from === undefined
          ? undefined
          : flags.from === 'citations'
            ? recueil.graph.citationNetwork()
            : flags.from === 'local'
              ? recueil.graph.citationNetwork({ localOnly: true })
              : recueil.graph.derivedNetwork(flags.from === 'co-citation' ? 'co_cited' : 'coupled');
      const created = recueil.curated.create({ name, ...(source === undefined ? {} : { document: recueil.curated.documentFromGraph(source) }) }, recueil.actor);
      if (ui().json) return ui().outJson({ command: 'network.create', id: created.network.id, nodes: created.document.nodes.length });
      ui().out(`Created ${created.network.id} "${name}" with ${created.document.nodes.length} nodes and ${created.document.edges.length} edges. Arrange it in the web app.`);
    });
  });

  lib(network.command('list').description('List curated networks')).action(async (flags: LibraryFlags) => {
    await withLibrary(resolveLibraryLocation(flags), { mustExist: true }, async (recueil) => {
      const rows = recueil.curated.list();
      if (ui().json) return ui().outJson({ command: 'network.list', networks: rows });
      for (const row of rows) ui().out(`${row.id}  ${row.name}  (updated ${row.updatedAt.slice(0, 10)})`);
    });
  });

  lib(
    network
      .command('freeze')
      .description('Freeze a version: its document and the metadata it shows are fixed')
      .argument('<id>', 'the network')
      .option('--version <n>', 'a version number; the head by default', Number),
  ).action(async (id: string, flags: LibraryFlags & { version?: number }) => {
    await withLibrary(resolveLibraryLocation(flags), { mustExist: true }, async (recueil) => {
      const frozen = recueil.curated.freeze(id, recueil.actor, flags.version);
      ui().out(`Froze ${frozen.network.name}, version ${frozen.version.version}.`);
    });
  });

  lib(
    network
      .command('export')
      .description('Export a curated network')
      .argument('<id>', 'the network')
      .requiredOption('--format <format>', 'svg | tikz | graphml | gexf', choice(['svg', 'tikz', 'graphml', 'gexf'] as const))
      .option('--version <n>', 'a version number; the head by default', Number)
      .option('-o, --output <file>', 'write here instead of stdout'),
  ).action(async (id: string, flags: LibraryFlags & { format: 'svg' | 'tikz' | 'graphml' | 'gexf'; version?: number; output?: string }) => {
    await withLibrary(resolveLibraryLocation(flags), { mustExist: true }, async (recueil) => {
      const resolved = recueil.curated.resolve(id, flags.version);
      const text =
        flags.format === 'svg'
          ? curatedToSvg(resolved)
          : flags.format === 'tikz'
            ? curatedToTikz(resolved)
            : flags.format === 'graphml'
              ? toGraphml(curatedToNetwork(resolved))
              : toGexf(curatedToNetwork(resolved));
      if (flags.output === undefined) process.stdout.write(text);
      else {
        writeFileSync(flags.output, text);
        ui().info(`wrote ${flags.output}`);
      }
    });
  });

  return network;
};
