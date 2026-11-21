/**
 * The Phase 3 commands: `plugin`, `enrich`, `check`, `dedup` (CONCEPT §5.4–5.6, §5.13).
 *
 * All four open the library directly, like the other data commands, and boot the plugin host with
 * the first-party plugins plus whatever `RECUEIL_PLUGIN_PATH` names. Every command that writes has a
 * dry run; `dedup` is a dry run unless told `--apply`, because a merge is the one operation here
 * that changes the shape of the library.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { schema } from '@recueil/core';
import {
  ChecksEngine,
  DedupEngine,
  EnrichmentEngine,
  checksReportCsv,
  checksReportMarkdown,
  readAuditInput,
} from '@recueil/plugin-host';
import type { ChecksRun, EnrichResult, WinnerRule } from '@recueil/plugin-host';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import { isNull } from 'drizzle-orm';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, withLibrary } from '../library.js';
import type { LibraryFlags } from '../library.js';
import { bootHost } from '../plugins.js';
import { renderTable } from '../table.js';
import type { Ui } from '../ui.js';

const list = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

const libraryOptions = (command: Command): Command =>
  command
    .option('-d, --database <url>', 'the Recueil library (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)');

/* -------------------------------------------------------------------------------------------- */
/* recueil plugin                                                                                  */
/* -------------------------------------------------------------------------------------------- */

export const registerPlugin = (parent: Command, describe: (name: string) => string, ui: () => Ui): Command => {
  const plugin = parent.command('plugin').description(describe('plugin'));

  libraryOptions(plugin.command('list').description('Every plugin found, and whether it is active')).action(
    async (flags: LibraryFlags) => {
      await withLibrary(resolveLibraryLocation(flags), {}, async (recueil) => {
        const host = await bootHost(recueil, ui());
        const statuses = host.list();
        if (ui().json) return ui().outJson({ command: 'plugin.list', plugins: statuses });
        for (const line of renderTable(
          [{ header: 'Plugin' }, { header: 'Version' }, { header: 'State' }, { header: 'Hooks', align: 'right' }, { header: 'Why' }],
          statuses.map((status) => [status.name, status.version, status.state, String(status.hooks.length), status.reason ?? '']),
        )) {
          ui().out(line);
        }
      });
    },
  );

  for (const [verb, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    libraryOptions(
      plugin
        .command(verb)
        .description(`${enabled ? 'Enable' : 'Disable'} plugins; takes effect on the next command`)
        .argument('[names...]', 'plugin names')
        .option('--builtin', 'every first-party plugin', false),
    ).action(async (names: string[], flags: LibraryFlags & { builtin?: boolean }) => {
      await withLibrary(resolveLibraryLocation(flags), {}, async (recueil) => {
        const host = await bootHost(recueil, ui());
        const targets = flags.builtin === true ? host.list().filter((p) => p.source === 'builtin').map((p) => p.name) : names;
        if (targets.length === 0) throw new CliError('name a plugin, or pass --builtin', { exitCode: ExitCode.Usage });
        for (const name of targets) host.setEnabled(name, enabled);
        ui().out(`${enabled ? 'Enabled' : 'Disabled'}: ${targets.join(', ')}`);
      });
    });
  }

  libraryOptions(
    plugin
      .command('set')
      .description('Set plugin settings; secrets only as ${env:VAR} or ${file:/path}')
      .argument('<name>', 'plugin name')
      .argument('<assignments...>', 'key=value pairs; key= clears'),
  ).action(async (name: string, assignments: string[], flags: LibraryFlags) => {
    const patch: Record<string, string | null> = {};
    for (const assignment of assignments) {
      const index = assignment.indexOf('=');
      if (index < 1) throw new CliError(`expected key=value, got '${assignment}'`, { exitCode: ExitCode.Usage });
      const value = assignment.slice(index + 1);
      patch[assignment.slice(0, index)] = value === '' ? null : value;
    }
    await withLibrary(resolveLibraryLocation(flags), {}, async (recueil) => {
      const host = await bootHost(recueil, ui());
      try {
        host.setSettings(name, patch);
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error), { exitCode: ExitCode.Usage });
      }
      ui().out(`Updated ${name}: ${Object.keys(patch).join(', ')}`);
    });
  });

  return plugin;
};

/* -------------------------------------------------------------------------------------------- */
/* recueil enrich                                                                                  */
/* -------------------------------------------------------------------------------------------- */

interface EnrichFlags extends LibraryFlags {
  item?: string[];
  mode?: 'fill' | 'overwrite';
  sources?: string[];
  priority?: string[];
  dryRun?: boolean;
  metrics?: boolean;
}

export const registerEnrich = (parent: Command, describe: (name: string) => string, ui: () => Ui): Command =>
  libraryOptions(
    parent
      .command('enrich')
      .description(describe('enrich'))
      .option('--item <id>', 'only this item (repeatable); default every live item', collect)
      .option('--mode <mode>', 'fill (default: only empty fields) | overwrite', (value) => {
        if (value !== 'fill' && value !== 'overwrite') throw new InvalidArgumentError('fill | overwrite');
        return value;
      })
      .option('--sources <list>', 'only these sources, e.g. crossref,openalex', list)
      .option('--priority <list>', 'source order for conflicting values, e.g. pubmed,openalex,crossref', list)
      .option('-n, --dry-run', 'report what would change, write nothing', false)
      .option('--no-metrics', 'do not record citation counts'),
  ).action(async (flags: EnrichFlags) => {
    await withLibrary(resolveLibraryLocation(flags), {}, async (recueil) => {
      const host = await bootHost(recueil, ui());
      if (host.resolvers().length === 0) {
        throw new CliError('no resolver is active: run `recueil plugin enable @recueil/plugin-resolvers-core` first', {
          exitCode: ExitCode.Usage,
        });
      }
      const engine = new EnrichmentEngine(recueil, host);
      const ids =
        flags.item ??
        recueil.db
          .select({ id: schema.items.id })
          .from(schema.items)
          .where(isNull(schema.items.trashedAt))
          .all()
          .map((row) => row.id);
      const results: EnrichResult[] = [];
      for (const id of ids) {
        results.push(
          await engine.enrichItem(id, {
            ...(flags.mode === undefined ? {} : { mode: flags.mode }),
            ...(flags.sources === undefined ? {} : { sources: flags.sources }),
            ...(flags.priority === undefined ? {} : { sourcePriority: flags.priority }),
            dryRun: flags.dryRun === true,
            metrics: flags.metrics !== false,
          }),
        );
      }
      const count = (status: EnrichResult['status']) => results.filter((r) => r.status === status).length;
      if (ui().json) ui().outJson({ command: 'enrich', dryRun: flags.dryRun === true, results });
      else {
        ui().out(
          `${flags.dryRun === true ? 'Dry run — nothing was written. ' : ''}${results.length} items: ${count('updated')} updated, ` +
            `${count('unchanged')} unchanged, ${count('skipped')} skipped, ${count('notfound')} not found, ${count('error')} errors`,
        );
        for (const result of results.filter((r) => r.status === 'skipped' || r.status === 'error').slice(0, 20)) {
          ui().out(`  ${result.status} ${result.itemId}: ${result.reason ?? ''}${Object.keys(result.errors).length > 0 ? ` (${Object.entries(result.errors).map(([s, m]) => `${s}: ${m}`).join(' · ')})` : ''}`);
        }
      }
      process.exitCode = count('error') > 0 ? ExitCode.JobFailed : ExitCode.Success;
    });
  });

/* -------------------------------------------------------------------------------------------- */
/* recueil check                                                                                   */
/* -------------------------------------------------------------------------------------------- */

interface CheckFlags extends LibraryFlags {
  item?: string[];
  checks?: string[];
  offline?: boolean;
  audit?: string;
  report?: string;
  dryRun?: boolean;
}

const writeReport = (run: ChecksRun, path: string, title: string, label: (id: string) => string): void => {
  writeFileSync(path, path.endsWith('.csv') ? checksReportCsv(run, label) : checksReportMarkdown(run, { title, subjectLabel: label }));
};

export const registerCheck = (parent: Command, describe: (name: string) => string, ui: () => Ui): Command =>
  libraryOptions(
    parent
      .command('check')
      .description(describe('check'))
      .option('--item <id>', 'only this item (repeatable)', collect)
      .option('--checks <list>', 'only these checks, e.g. retraction,doi_resolves', list)
      .option('--offline', 'skip the checks that need the network', false)
      .option('--audit <file>', 'audit a reference list (BibTeX, RIS, CSL-JSON or plain text) instead of the library')
      .option('--report <file>', 'write a report: .md or .csv')
      .option('-n, --dry-run', 'run the checks, store nothing', false)
      .addHelpText(
        'after',
        [
          '',
          'The audit is the peer-review deliverable: paste a manuscript\'s reference list into a file and',
          '  recueil check --audit references.txt --report audit.md',
          'flags references that do not exist, DOIs that do not resolve or point elsewhere, and retractions.',
          '',
          'Exit codes: 0 no failures · 4 failures or warnings to look at',
        ].join('\n'),
      ),
  ).action(async (flags: CheckFlags) => {
    await withLibrary(resolveLibraryLocation(flags), {}, async (recueil) => {
      const host = await bootHost(recueil, ui());
      if (host.checks().length === 0) {
        throw new CliError('no check is active: run `recueil plugin enable @recueil/plugin-checks-core` first', { exitCode: ExitCode.Usage });
      }
      const engine = new ChecksEngine(recueil, host);
      const options = {
        ...(flags.checks === undefined ? {} : { checkIds: flags.checks }),
        offline: flags.offline === true,
        dryRun: flags.dryRun === true,
      };
      let run: ChecksRun;
      let label = (id: string) => id;
      if (flags.audit !== undefined) {
        const references = readAuditInput(readFileSync(flags.audit, 'utf8'));
        run = await engine.audit(references, options);
        const byRef = new Map(references.map((ref, index) => [`ref-${String(index + 1).padStart(4, '0')}`, ref]));
        label = (id) => {
          const ref = byRef.get(id);
          return ref === undefined ? id : `${id}: ${(ref.rawString ?? ref.stub.title ?? '').slice(0, 90)}`;
        };
      } else {
        run = await engine.runLibrary({ ...options, ...(flags.item === undefined ? {} : { itemIds: flags.item }) });
        label = (id) => {
          try {
            return recueil.library.getItem(id, { includeTrashed: true }).item.title ?? id;
          } catch {
            return id;
          }
        };
      }
      if (flags.report !== undefined) writeReport(run, flags.report, flags.audit === undefined ? 'Library check' : 'Reference audit', label);
      const problems = run.results.filter((result) => result.status === 'fail' || result.status === 'warn');
      if (ui().json) ui().outJson({ command: 'check', auditRunId: run.auditRunId, results: run.results });
      else {
        ui().out(
          `${run.subjects} subjects, ${run.results.length} results: ${run.results.filter((r) => r.status === 'fail').length} failed, ` +
            `${run.results.filter((r) => r.status === 'warn').length} warnings, ${run.results.filter((r) => r.status === 'skipped').length} skipped`,
        );
        for (const result of problems.slice(0, 30)) ui().out(`  ${result.status} ${result.checkId} — ${label(result.subjectId)}: ${result.message}`);
        if (problems.length > 30) ui().out(`  … and ${problems.length - 30} more${flags.report === undefined ? ' (use --report)' : ''}`);
      }
      process.exitCode = problems.length > 0 ? ExitCode.Review : ExitCode.Success;
    });
  });

/* -------------------------------------------------------------------------------------------- */
/* recueil dedup                                                                                   */
/* -------------------------------------------------------------------------------------------- */

interface DedupFlags extends LibraryFlags {
  apply?: boolean;
  winner?: WinnerRule;
  autoThreshold?: number;
  report?: string;
}

export const registerDedup = (parent: Command, describe: (name: string) => string, ui: () => Ui): Command => {
  const dedup = libraryOptions(
    parent
      .command('dedup')
      .description(describe('dedup'))
      .option('--apply', 'merge the certain duplicates and queue the rest for review (default: report only)', false)
      .option('--winner <rule>', 'newest (default) | oldest | most_complete', (value) => {
        if (!['newest', 'oldest', 'most_complete'].includes(value)) throw new InvalidArgumentError('newest | oldest | most_complete');
        return value as WinnerRule;
      })
      .option('--auto-threshold <score>', 'merge without review at or above this score (default 1: identifier matches only)', Number)
      .option('--report <file>', 'write the plan as JSON'),
  ).action(async (flags: DedupFlags) => {
    await withLibrary(resolveLibraryLocation(flags), {}, async (recueil) => {
      const host = await bootHost(recueil, ui());
      if (host.dedupRules().length === 0) {
        throw new CliError('no dedup rule is active: run `recueil plugin enable @recueil/plugin-dedup-core` first', { exitCode: ExitCode.Usage });
      }
      const run = await new DedupEngine(recueil, host).run({
        dryRun: flags.apply !== true,
        ...(flags.winner === undefined ? {} : { winnerRule: flags.winner }),
        ...(flags.autoThreshold === undefined ? {} : { autoMergeThreshold: flags.autoThreshold }),
      });
      if (flags.report !== undefined) writeFileSync(flags.report, `${JSON.stringify(run, null, 2)}\n`);
      if (ui().json) return ui().outJson({ command: 'dedup', run });
      const title = (id: string) => recueil.library.getItem(id, { includeTrashed: true }).item.title ?? id;
      const auto = run.groups.filter((group) => group.decision === 'auto');
      const review = run.groups.filter((group) => group.decision === 'review');
      ui().out(
        `${run.dryRun ? 'Dry run — nothing was merged. ' : ''}${run.subjects} items, ${run.comparisons} comparisons: ` +
          `${auto.length} certain duplicate groups${run.dryRun ? '' : ' merged'}, ${review.length} for review`,
      );
      for (const group of run.groups.slice(0, 30)) {
        ui().out(`  ${group.decision} keep "${title(group.winnerId)}" (${group.winnerId}), ${run.dryRun ? 'would merge' : 'merged'} ${group.loserIds.join(', ')} — ${group.reason}`);
      }
      for (const disabled of run.disabledRules) ui().warn(`rule ${disabled.rule} was disabled for this run: ${disabled.reason}`);
      process.exitCode = review.length > 0 ? ExitCode.Review : ExitCode.Success;
    });
  });

  libraryOptions(dedup.command('undo').description('Reverse a merge').argument('<itemId>', 'the merged-away item')).action(
    async (itemId: string, flags: LibraryFlags) => {
      await withLibrary(resolveLibraryLocation(flags), { mustExist: true }, async (recueil) => {
        const outcome = recueil.merges.unmerge(itemId, recueil.actor);
        ui().out(`Restored ${outcome.restoredId} from ${outcome.winnerId}.`);
        if (outcome.keptOnWinner.length > 0) ui().out(`  edited since the merge, so left on the survivor: ${outcome.keptOnWinner.join(', ')}`);
        if (outcome.droppedIdentifiers.length > 0) ui().out(`  held by the survivor, so not restored: ${outcome.droppedIdentifiers.join(', ')}`);
      });
    },
  );
  return dedup;
};
