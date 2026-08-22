/**
 * `recueil restore` (CONCEPT.md §5.15, "restore is tested in CI").
 *
 * The command that matters and the one nobody runs until the day they have to. Two behaviours are
 * therefore not configurable:
 *
 * - it refuses a target that already holds something, unless told in as many words that the
 *   contents are expendable;
 * - it verifies every restored file against the manifest, and fails the whole restore rather than
 *   leaving a library that is mostly right.
 *
 * `--verify-only` does the checking half without writing anything, which is what turns "we have
 * backups" into "we have backups that work". It is the thing to put in a monthly cron job.
 */
import type { Command } from 'commander';

import { restoreBackup, verifyBackup } from '@recueil/core';
import type { RestoreResult, VerifyBackupResult } from '@recueil/core';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { Progress } from '../progress.js';
import { bytes, count, renderTable } from '../table.js';
import type { Ui } from '../ui.js';
import { asCliError } from './backup.js';

export interface RestoreFlags {
  into?: string;
  force?: boolean;
  verifyOnly?: boolean;
  progress?: boolean;
}

const printRestored = (result: RestoreResult, ui: Ui, elapsedMs: number): void => {
  const { bold, dim, green } = ui.colour;
  const manifest = result.manifest;

  ui.info('');
  ui.info(bold('Restored'));
  ui.info('');
  for (const line of renderTable(
    [{ header: 'What' }, { header: 'Value', align: 'right' }],
    [
      ['taken at', manifest.createdAt],
      ['written by', `${manifest.generator.name} ${manifest.generator.version}`],
      ['files', count(result.filesRestored)],
      ['blobs', count(result.blobsRestored)],
      ['bytes', bytes(result.bytesRestored)],
      ['integrity check', result.integrityCheck],
      ['items', count(result.tableCounts['items'] ?? 0)],
      ['documents', count(result.tableCounts['documents'] ?? 0)],
      ['took', `${(elapsedMs / 1000).toFixed(1)} s`],
    ],
  )) {
    ui.info(`  ${line}`);
  }

  ui.info('');
  ui.info(`  ${green('library')}  ${result.databasePath}`);
  ui.info(`  ${green('storage')}  ${result.storagePath}`);
  if (result.configPath !== null) ui.info(`  config   ${result.configPath}`);
  ui.info('');
  ui.info(dim('  Point the server at it:'));
  ui.info(dim(`    recueil serve --database ${result.databasePath} --storage ${result.storagePath}`));
  ui.info('');
};

const printVerified = (result: VerifyBackupResult, ui: Ui): void => {
  const { bold, green, red } = ui.colour;

  ui.info('');
  ui.info(bold('Verification'));
  ui.info('');
  ui.info(`  snapshot    ${result.root}`);
  ui.info(`  taken at    ${result.manifest.createdAt}`);
  ui.info(`  files       ${count(result.filesChecked)}`);
  ui.info(`  bytes       ${bytes(result.bytesChecked)}`);
  ui.info('');

  if (result.failures.length === 0) {
    ui.info(`  ${green('OK')} — every file matches the manifest.`);
    ui.info('');
    return;
  }

  ui.info(`  ${red('FAILED')} — ${result.failures.length} files do not match:`);
  ui.info('');
  for (const line of renderTable(
    [{ header: 'Path' }, { header: 'Problem' }, { header: 'Expected' }, { header: 'Found' }],
    result.failures.map((failure) => [
      failure.path,
      failure.reason,
      failure.expectedSha256.slice(0, 12),
      failure.actualSha256 === null ? '(absent)' : failure.actualSha256.slice(0, 12),
    ]),
  )) {
    ui.info(`  ${line}`);
  }
  ui.info('');
};

export const runRestore = async (from: string, flags: RestoreFlags, ui: Ui): Promise<void> => {
  const started = Date.now();
  const progress = new Progress(ui, { enabled: flags.progress !== false });

  if (flags.verifyOnly === true) {
    let result: VerifyBackupResult;
    try {
      result = await verifyBackup(from, {
        onProgress: (event) => {
          progress.update({ label: 'verify', done: event.done, total: event.total, detail: event.label });
        },
      });
    } catch (error) {
      throw asCliError(error);
    } finally {
      progress.finish();
    }

    if (ui.json) {
      ui.outJson({
        command: 'restore.verify',
        snapshot: result.root,
        ok: result.failures.length === 0,
        filesChecked: result.filesChecked,
        bytesChecked: result.bytesChecked,
        failures: result.failures,
        manifest: result.manifest,
      });
    } else {
      printVerified(result, ui);
    }

    if (result.failures.length > 0) process.exitCode = ExitCode.JobFailed;
    return;
  }

  if (flags.into === undefined || flags.into.trim() === '') {
    throw new CliError('`--into` is required: a restore has to go somewhere.', {
      exitCode: ExitCode.Usage,
      detail: [
        '',
        '  The target gets `library.sqlite`, `storage/` and `config/`, which is an ordinary Recueil',
        '  deployment. It must be empty or not exist; --force says its contents are expendable.',
        '',
        'Examples:',
        '  recueil restore /var/backups/recueil --into /srv/recueil',
        '  recueil restore /var/backups/recueil --verify-only',
      ],
      payload: { error: 'no_target' },
    });
  }

  let result: RestoreResult;
  try {
    result = await restoreBackup({
      from,
      into: flags.into,
      force: flags.force === true,
      onProgress: (event) => {
        progress.update({ label: event.phase, done: event.done, total: event.total, detail: event.label });
      },
    });
  } catch (error) {
    throw asCliError(error);
  } finally {
    progress.finish();
  }

  if (ui.json) {
    ui.outJson({
      command: 'restore',
      elapsedMs: Date.now() - started,
      databasePath: result.databasePath,
      storagePath: result.storagePath,
      configPath: result.configPath,
      filesRestored: result.filesRestored,
      blobsRestored: result.blobsRestored,
      bytesRestored: result.bytesRestored,
      integrityCheck: result.integrityCheck,
      tableCounts: result.tableCounts,
      manifest: result.manifest,
    });
  } else {
    printRestored(result, ui, Date.now() - started);
  }
};

export const registerRestore = (
  parent: Command,
  describe: (name: string) => string,
  ui: () => Ui,
): Command =>
  parent
    .command('restore')
    .description(describe('restore'))
    .argument('<snapshot>', 'the snapshot directory, or the manifest.json inside it')
    .option('-i, --into <dir>', 'where the library is written')
    .option('-f, --force', 'write into a directory that is not empty', false)
    .option('--verify-only', 'check the snapshot against its manifest and restore nothing', false)
    .option('--no-progress', 'do not draw the progress display')
    .addHelpText(
      'after',
      [
        '',
        'What lands in the target:',
        '',
        '  <into>/library.sqlite         RECUEIL_DATABASE_URL',
        '  <into>/storage/<aa>/<bb>/…    RECUEIL_STORAGE_PATH — byte-identical to the store backed up',
        '  <into>/config/recueil.json    the configuration the snapshot was taken with',
        '',
        'Every file is hashed as it is copied and checked against the manifest; one mismatch fails',
        'the restore and removes what had been written, because a directory that looks like a',
        'library and is not one is worse than no directory at all. The restored database is then',
        'integrity-checked and its table counts compared with the manifest\'s.',
        '',
        'Exit codes',
        '  0  restored, or verified with no failures',
        '  1  the target is not empty, or the snapshot is not one',
        '  5  a file did not match the manifest',
        '',
        'Examples:',
        '  recueil restore /var/backups/recueil --into /srv/recueil',
        '  recueil restore /var/backups/recueil --verify-only',
      ].join('\n'),
    )
    .action(async (snapshot: string, flags: RestoreFlags) => {
      await runRestore(snapshot, flags, ui());
    });
