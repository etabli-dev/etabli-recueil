/**
 * `recueil sync zotero` — the two-way bridge to zotero.org (ADR-0025).
 *
 * The API key is read from `RECUEIL_ZOTERO_API_KEY` or from a file named by `--api-key-file`, never
 * from a flag: a flag ends up in shell history and in `ps`. It is not written anywhere.
 *
 * The recommended first contact with a real account is the order the help text gives: a dry run,
 * then a pull-only run, then a full run.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { ZoteroApiClient, resolveConflict, summariseReport, syncZoteroLibraries, SyncState } from '@recueil/sync-zotero';
import type { ConflictPolicy, PushNewPolicy, SyncDirection, SyncReport } from '@recueil/sync-zotero';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, withLibrary } from '../library.js';
import type { LibraryFlags } from '../library.js';
import type { Ui } from '../ui.js';

interface SyncFlags extends LibraryFlags {
  dryRun?: boolean;
  direction?: SyncDirection;
  conflicts?: ConflictPolicy;
  library?: string[];
  home?: string;
  pushNew?: PushNewPolicy;
  files?: boolean;
  maxFileMb?: number;
  propagatePurge?: boolean;
  apiKeyFile?: string;
  report?: string;
}

const oneOf =
  <T extends string>(values: readonly T[], what: string) =>
  (value: string): T => {
    if (!(values as readonly string[]).includes(value)) {
      throw new InvalidArgumentError(`expected ${what}: ${values.join(' | ')}`);
    }
    return value as T;
  };

const collect = (value: string, previous: string[] = []): string[] => {
  if (value !== 'user' && !/^group:\d+$/u.test(value)) {
    throw new InvalidArgumentError('expected `user` or `group:<id>`');
  }
  return [...previous, value];
};

const readApiKey = (flags: SyncFlags): string => {
  const fromFile = flags.apiKeyFile === undefined ? undefined : readFileSync(flags.apiKeyFile, 'utf8').trim();
  const key = fromFile ?? process.env['RECUEIL_ZOTERO_API_KEY']?.trim();
  if (key === undefined || key === '') {
    throw new CliError(
      'no Zotero API key: set RECUEIL_ZOTERO_API_KEY or pass --api-key-file. Create one at ' +
        'zotero.org → Settings → Security → API keys, with library and write access.',
      { exitCode: ExitCode.Auth },
    );
  }
  return key;
};

const runSync = async (flags: SyncFlags, ui: Ui): Promise<void> => {
  const client = new ZoteroApiClient({ apiKey: readApiKey(flags) });
  const location = resolveLibraryLocation(flags);
  const reports: SyncReport[] = await withLibrary(location, {}, (recueil) =>
    syncZoteroLibraries(recueil, client, {
      dryRun: flags.dryRun === true,
      direction: flags.direction ?? 'both',
      policy: flags.conflicts ?? 'review',
      ...(flags.library === undefined ? {} : { only: flags.library }),
      home: flags.home ?? 'user',
      pushNew: flags.pushNew ?? 'bibliographic',
      files: flags.files !== false,
      maxFileBytes: (flags.maxFileMb ?? 200) * 1024 * 1024,
      propagatePurge: flags.propagatePurge === true,
      log: (message) => ui.info(message),
    }),
  );

  if (flags.report !== undefined) writeFileSync(flags.report, `${JSON.stringify(reports, null, 2)}\n`);

  if (ui.json) ui.outJson({ command: 'sync.zotero', reports });
  else {
    for (const report of reports) {
      ui.out(summariseReport(report));
      for (const conflict of report.conflicts) {
        ui.out(
          `  conflict ${conflict.objectType} ${conflict.key} ${conflict.field}: Recueil '${conflict.recueil ?? ''}' / Zotero '${conflict.zotero ?? ''}' (${conflict.outcome})`,
        );
      }
      for (const error of report.errors) ui.warn(`${error.objectType} ${error.key ?? ''}: ${error.message}`);
      ui.out();
    }
  }

  const errors = reports.some((report) => report.errors.length > 0);
  const review = reports.some((report) => report.conflicts.length > 0 || report.review.length > 0);
  process.exitCode = errors ? ExitCode.JobFailed : review ? ExitCode.Review : ExitCode.Success;
};

const runConflicts = async (flags: LibraryFlags, ui: Ui): Promise<void> => {
  const location = resolveLibraryLocation(flags);
  const rows = await withLibrary(location, { mustExist: true }, async (recueil) => new SyncState(recueil).allOpenConflicts());
  if (ui.json) {
    ui.outJson({ command: 'sync.zotero.conflicts', conflicts: rows });
    return;
  }
  if (rows.length === 0) ui.out('No open conflicts.');
  for (const row of rows) {
    ui.out(
      `${row.id}  ${row.objectType} ${row.zoteroKey}  ${row.field}\n    base    ${row.baseValue ?? '∅'}\n    Recueil ${row.recueilValue ?? '∅'}\n    Zotero  ${row.zoteroValue ?? '∅'}`,
    );
  }
};

const runResolve = async (id: string, side: 'zotero' | 'recueil', flags: LibraryFlags, ui: Ui): Promise<void> => {
  const location = resolveLibraryLocation(flags);
  await withLibrary(location, { mustExist: true }, async (recueil) => resolveConflict(recueil, id, side));
  ui.out(`Conflict ${id}: ${side === 'zotero' ? "Zotero's" : "Recueil's"} value wins. The next sync applies it to both sides.`);
};

export const registerSync = (parent: Command, describe: (name: string) => string, ui: () => Ui): Command => {
  const sync = parent.command('sync').description(describe('sync'));
  const zotero = sync
    .command('zotero')
    .description('Sync this library with zotero.org, both ways (ADR-0025)')
    .option('-d, --database <url>', 'the Recueil library (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)')
    .option('-n, --dry-run', 'compute everything, write nothing to either side', false)
    .option('--direction <dir>', 'both | pull | push', oneOf(['both', 'pull', 'push'] as const, 'a direction'))
    .option(
      '--conflicts <policy>',
      'review (hold both sides) | zotero | recueil',
      oneOf(['review', 'zotero', 'recueil'] as const, 'a policy'),
    )
    .option('--library <lib>', 'only this library: user or group:<id> (repeatable)', collect)
    .option('--home <lib>', 'where new Recueil items are created (default: user)')
    .option(
      '--push-new <which>',
      'bibliographic (default) | all | none — which new Recueil items go to the home library',
      oneOf(['bibliographic', 'all', 'none'] as const, 'a push policy'),
    )
    .option('--no-files', 'do not download or upload attachment files')
    .option('--max-file-mb <n>', 'skip files larger than this', (value) => Number.parseInt(value, 10))
    .option('--propagate-purge', 'delete on zotero.org what was deleted for good in Recueil', false)
    .option('--api-key-file <file>', 'read the API key from this file instead of RECUEIL_ZOTERO_API_KEY')
    .option('--report <file>', 'write the full JSON report here')
    .addHelpText(
      'after',
      [
        '',
        'First contact with a real account, in this order:',
        '  recueil sync zotero --dry-run --report sync-plan.json',
        '  recueil sync zotero --direction pull',
        '  recueil sync zotero',
        '',
        'A field both sides changed differently is a conflict: under the default policy neither side',
        'is written until you decide it with `recueil sync zotero resolve <id> zotero|recueil`.',
        'A field locked in Recueil is never overwritten by a pull.',
        '',
        'Exit codes: 0 synced · 2 no or bad API key · 4 synced, with conflicts or review entries · 5 errors',
      ].join('\n'),
    )
    .action(async (flags: SyncFlags) => {
      await runSync(flags, ui());
    });

  zotero
    .command('conflicts')
    .description('List open conflicts')
    .option('-d, --database <url>', 'the Recueil library (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)')
    .action(async (flags: LibraryFlags) => {
      await runConflicts(flags, ui());
    });

  zotero
    .command('resolve')
    .description('Decide a conflict: which side wins')
    .argument('<id>', 'the conflict id from `recueil sync zotero conflicts`')
    .argument('<side>', 'zotero | recueil', oneOf(['zotero', 'recueil'] as const, 'a side'))
    .option('-d, --database <url>', 'the Recueil library (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)')
    .action(async (id: string, side: 'zotero' | 'recueil', flags: LibraryFlags) => {
      await runResolve(id, side, flags, ui());
    });

  return sync;
};
