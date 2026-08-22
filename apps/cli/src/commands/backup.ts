/**
 * `recueil backup` (CONCEPT.md §5.15).
 *
 * The work is in `@recueil/core`'s backup module, and `packages/core/src/backup/FORMAT.md`
 * documents what it produces. What belongs here is the part that is a *command*: where the library
 * is, what configuration to record, and how to say what happened.
 *
 * The configuration recorded in the snapshot is the `RECUEIL_*` environment as this process sees
 * it, with anything that looks like a credential replaced by `****` — the same rule `recueil serve`
 * applies to the banner it prints, and for the same reason. A backup ends up on a NAS, in a restic
 * repository and eventually on somebody's laptop; a token in it is a token in all three places.
 * What is left is still worth having: which database, which store, which port, which log level —
 * the answer to "how was this library configured" a year after the machine was scrapped.
 */
import { createBackup } from '@recueil/core';
import type { BackupResult } from '@recueil/core';
import type { Command } from 'commander';

import { CliError } from '../errors.js';
import { ExitCode } from '../exit.js';
import { resolveLibraryLocation, type LibraryFlags } from '../library.js';
import { Progress } from '../progress.js';
import { bytes, count, renderTable } from '../table.js';
import type { Ui } from '../ui.js';

export interface BackupFlags extends LibraryFlags {
  out?: string;
  blobs?: boolean;
  force?: boolean;
  config?: boolean;
  skipCorrupt?: boolean;
  progress?: boolean;
}

/** Anything whose name suggests a credential prints, and is recorded, as `****`. */
const SECRETISH = /(token|secret|password|passwd|apikey|api_key|key|credential)/iu;

/**
 * The `RECUEIL_*` environment, redacted.
 *
 * Only `RECUEIL_*` — the rest of the environment is the operator's shell and none of a backup's
 * business.
 */
export const redactedConfiguration = (env: NodeJS.ProcessEnv = process.env): Record<string, unknown> => {
  const variables: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith('RECUEIL_')) continue;
    const value = env[name];
    if (value === undefined) continue;
    variables[name] = SECRETISH.test(name) && value.length > 0 ? '****' : value;
  }
  return {
    recordedAt: new Date().toISOString(),
    note: 'Credentials are redacted. This is a record of how the library was configured, not something to replay.',
    environment: variables,
  };
};

const printSummary = (result: BackupResult, ui: Ui, elapsedMs: number): void => {
  const { bold, dim, green, yellow } = ui.colour;
  const manifest = result.manifest;

  ui.info('');
  ui.info(bold('Snapshot'));
  ui.info('');
  for (const line of renderTable(
    [{ header: 'What' }, { header: 'Value', align: 'right' }],
    [
      ['database', bytes(manifest.database.size)],
      ['pages', count(manifest.database.pageCount)],
      ['integrity check', manifest.database.integrityCheck],
      ['migrations applied', count(manifest.database.schema.applied)],
      ['items', count(manifest.database.tableCounts['items'] ?? 0)],
      ['documents', count(manifest.database.tableCounts['documents'] ?? 0)],
      ['blobs', manifest.storage.blobsIncluded ? count(manifest.storage.blobCount) : `${count(manifest.storage.blobCount)} (listed only)`],
      ['store size', bytes(manifest.storage.totalBytes)],
      ['copied this run', `${count(result.blobsCopied)} blobs`],
      ['reused', `${count(result.blobsReused)} blobs`],
      ['pruned', `${count(result.filesPruned)} files`],
      ['written', bytes(result.bytesWritten)],
      ['took', `${(elapsedMs / 1000).toFixed(1)} s`],
    ],
  )) {
    ui.info(`  ${line}`);
  }

  if (result.ignoredStoreEntries.length > 0) {
    ui.info('');
    ui.warn(
      `${result.ignoredStoreEntries.length} entries under the store root are not blobs and were not ` +
        `backed up: ${result.ignoredStoreEntries.slice(0, 5).join(', ')}` +
        (result.ignoredStoreEntries.length > 5 ? ', …' : ''),
    );
  }
  if (result.corruptBlobs.length > 0) {
    ui.info('');
    ui.warn(`${yellow(String(result.corruptBlobs.length))} blobs no longer hash to their own name and were left out:`);
    for (const blob of result.corruptBlobs.slice(0, 10)) ui.info(`    ${blob.key}`);
  }

  ui.info('');
  ui.info(`  ${green('snapshot')} ${result.path}`);
  ui.info(dim(`    verify without Recueil:  cd ${result.path} && sha256sum -c checksums.txt`));
  ui.info(dim(`    restore:                 recueil restore ${result.path} --into <dir>`));
  ui.info('');
};

export const runBackup = async (flags: BackupFlags, ui: Ui): Promise<void> => {
  if (flags.out === undefined || flags.out.trim() === '') {
    throw new CliError('`--out` is required: a backup has to go somewhere.', {
      exitCode: ExitCode.Usage,
      detail: [
        '',
        '  The snapshot is a directory of ordinary files, not an archive — that is what makes it',
        '  restic-friendly, and what lets `sha256sum -c` verify it without Recueil. Point --out at',
        '  a path that is empty or does not exist, or at last night\'s snapshot with --force.',
        '',
        'Examples:',
        '  recueil backup --out /var/backups/recueil',
        '  recueil backup --out /var/backups/recueil --force      # replace, copying only what changed',
        '  recueil backup --out /var/backups/recueil-index --no-blobs',
      ],
      payload: { error: 'no_output' },
    });
  }

  const location = resolveLibraryLocation(flags);
  const progress = new Progress(ui, { enabled: flags.progress !== false });
  const started = Date.now();

  ui.info(`database  ${location.databaseUrl} (${location.origin.database})`);
  ui.info(`storage   ${location.storagePath} (${location.origin.storage})`);
  ui.info(`out       ${flags.out}`);

  let result: BackupResult;
  try {
    result = await createBackup({
      databaseUrl: location.databaseUrl,
      storagePath: location.storagePath,
      out: flags.out,
      includeBlobs: flags.blobs !== false,
      force: flags.force === true,
      onCorruptBlob: flags.skipCorrupt === true ? 'skip' : 'fail',
      ...(flags.config === false ? {} : { config: redactedConfiguration() }),
      onProgress: (event) => {
        progress.update({
          label: event.phase,
          done: event.done,
          total: event.total,
          detail: event.phase === 'storage' ? (event.label?.slice(0, 12) ?? null) : null,
        });
      },
    });
  } catch (error) {
    throw asCliError(error);
  } finally {
    progress.finish();
  }

  if (ui.json) {
    ui.outJson({
      command: 'backup',
      path: result.path,
      elapsedMs: Date.now() - started,
      blobsCopied: result.blobsCopied,
      blobsReused: result.blobsReused,
      filesPruned: result.filesPruned,
      bytesWritten: result.bytesWritten,
      corruptBlobs: result.corruptBlobs,
      ignoredStoreEntries: result.ignoredStoreEntries,
      manifest: result.manifest,
    });
  } else {
    printSummary(result, ui, Date.now() - started);
  }
};

/**
 * Turn a core backup error into one the shell can read.
 *
 * `RecueilError` already carries a good message and a structured detail; the CLI's job is to give
 * it an exit code and, where the fix is a flag, to name the flag.
 */
export const asCliError = (error: unknown): CliError => {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const type = (error as { type?: unknown } | null)?.type;

  if (type === 'recueil:backup-target') {
    return new CliError(message, {
      exitCode: ExitCode.Usage,
      detail: ['', '  Pass --force if replacing what is there is genuinely what you meant.'],
      payload: { error: 'backup_target' },
      cause: error,
    });
  }
  if (type === 'recueil:backup-verification-failed') {
    return new CliError(message, {
      exitCode: ExitCode.JobFailed,
      detail: [
        '',
        '  The snapshot does not match its own manifest. Nothing has been left half-restored.',
        '  Check the media it came off, and verify the snapshot in place with:',
        '',
        '      sha256sum -c checksums.txt',
      ],
      payload: { error: 'backup_verification_failed', ...(error as { detail?: Record<string, unknown> }).detail },
      cause: error,
    });
  }
  if (type === 'recueil:backup-format') {
    return new CliError(message, { exitCode: ExitCode.JobFailed, payload: { error: 'backup_format' }, cause: error });
  }
  return new CliError(message, { exitCode: ExitCode.JobFailed, cause: error });
};

export const registerBackup = (
  parent: Command,
  describe: (name: string) => string,
  ui: () => Ui,
): Command =>
  parent
    .command('backup')
    .description(describe('backup'))
    .option('-o, --out <path>', 'the snapshot directory to write')
    .option('-d, --database <url>', 'the library to snapshot (RECUEIL_DATABASE_URL)')
    .option('-s, --storage <path>', 'the content-addressed store (RECUEIL_STORAGE_PATH)')
    .option('-f, --force', 'replace an existing snapshot at --out', false)
    .option('--no-blobs', 'write the storage manifest without copying the files')
    .option('--no-config', 'do not record the configuration')
    .option('--skip-corrupt', 'leave out blobs whose bytes no longer hash to their name, and list them', false)
    .option('--no-progress', 'do not draw the progress display')
    .addHelpText(
      'after',
      [
        '',
        'A snapshot is a directory, not an archive:',
        '',
        '  <out>/manifest.json        the index — every file, with the digest it must hash to',
        '  <out>/checksums.txt        sha256sum -c input, so it can be verified without Recueil',
        '  <out>/database/…           the database, taken with SQLite\'s online backup API',
        '  <out>/config/recueil.json  the RECUEIL_* environment, credentials redacted',
        '  <out>/storage/<aa>/<bb>/…  the content-addressed store, in its own layout',
        '',
        'The database is copied page by page through SQLite itself, so a running server does not',
        'have to be stopped and what lands is the database as of one instant. It is then opened and',
        'integrity-checked before the snapshot is completed.',
        '',
        'Writing over yesterday\'s snapshot with --force copies only what changed: a blob already',
        'there with the right digest is verified and left alone, and one the library no longer holds',
        'is pruned. That, and the content-addressed layout, are what make it restic-friendly.',
        '',
        'Examples:',
        '  recueil backup --out /var/backups/recueil',
        '  recueil backup --out /var/backups/recueil --force',
        '  recueil backup --out /var/backups/index --no-blobs   # store backed up separately',
      ].join('\n'),
    )
    .action(async (flags: BackupFlags) => {
      await runBackup(flags, ui());
    });
