/**
 * Opening the library the way `recueil serve` would.
 *
 * `recueil serve` is a client of nothing: it starts the server. The Phase 1 data commands —
 * `import`, `export`, `backup`, `restore` — are in the same position for a different reason. An
 * importer needs the `Recueil` services, not an HTTP surface: `importZoteroLibrary` writes
 * fifty thousand records through the service layer inside one process, and a REST round trip per
 * record would be both slower and less correct, because the idempotency and the resume cursor live
 * in the same database as the records. So these commands open the library directly, and take the
 * same flags and the same environment variables `serve` does, so that a person who has configured
 * one has configured all five.
 *
 * The obligation that comes with that is the one `server.ts` names: the library has exactly one
 * owner, and it is the process that closes it. `withLibrary` is the only way these commands open
 * one, and it closes it on every path out.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { MEMORY_DATABASE, createRecueil, resolveDatabaseFile } from '@recueil/core';
import type { CreateRecueilOptions, Recueil } from '@recueil/core';

import { CliError } from './errors.js';
import { ExitCode } from './exit.js';

/**
 * The defaults `@recueil/server` resolves to when nothing is set.
 *
 * Restated rather than imported: reaching them through `@recueil/server` would mean loading
 * Fastify to run `recueil export`. `test/library.test.ts` asserts that these two strings still
 * agree with the server's, so the duplication cannot drift in silence.
 */
export const DEFAULT_DATABASE_URL = 'file:./data/recueil.db';
export const DEFAULT_STORAGE_PATH = './data/storage';

export interface LibraryFlags {
  database?: string;
  storage?: string;
}

export interface ResolvedLibrary {
  /** As given: `:memory:`, a path, or a `file:`/`sqlite:` URL. */
  readonly databaseUrl: string;
  /** The database file the URL names, or `:memory:`. */
  readonly databaseFile: string;
  /** Absolute path of the content-addressed store root. */
  readonly storagePath: string;
  /** Where each value came from, for the verbose log and the `serve`-style banner. */
  readonly origin: { database: 'flag' | 'environment' | 'default'; storage: 'flag' | 'environment' | 'default' };
}

export const resolveLibraryLocation = (
  flags: LibraryFlags,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedLibrary => {
  const databaseUrl = flags.database ?? env['RECUEIL_DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const storagePath = flags.storage ?? env['RECUEIL_STORAGE_PATH'] ?? DEFAULT_STORAGE_PATH;

  return {
    databaseUrl,
    databaseFile: resolveDatabaseFile(databaseUrl),
    storagePath: resolve(storagePath),
    origin: {
      database: flags.database !== undefined ? 'flag' : env['RECUEIL_DATABASE_URL'] !== undefined ? 'environment' : 'default',
      storage: flags.storage !== undefined ? 'flag' : env['RECUEIL_STORAGE_PATH'] !== undefined ? 'environment' : 'default',
    },
  };
};

export interface OpenLibraryOptions {
  /** Refuse rather than create. Anything that reads an existing library passes true. */
  mustExist?: boolean;
  /**
   * Keep the full-text index in step with every write.
   *
   * A bulk import turns it off and rebuilds once at the end, which is the difference between one
   * indexing pass and fifty thousand.
   */
  indexOnWrite?: boolean;
}

const missingLibrary = (location: ResolvedLibrary): CliError =>
  new CliError(`no library at '${location.databaseFile}'.`, {
    exitCode: ExitCode.Usage,
    detail: [
      '',
      '  This command reads an existing library and will not create an empty one to read from.',
      '',
      `  database  ${location.databaseUrl} (${location.origin.database})`,
      `  storage   ${location.storagePath} (${location.origin.storage})`,
      '',
      '  Point it somewhere with --database and --storage, set RECUEIL_DATABASE_URL and',
      '  RECUEIL_STORAGE_PATH, or run `recueil serve` once to create the library.',
    ],
    payload: { error: 'no_library', databaseUrl: location.databaseUrl, databaseFile: location.databaseFile },
  });

/**
 * Open the library, run `body`, and close it — whatever `body` does.
 *
 * The `finally` is the whole point. A CLI that throws with a SQLite handle open leaves a `-wal`
 * file behind, and the next process to open the library has to recover it.
 */
export const withLibrary = async <T>(
  location: ResolvedLibrary,
  options: OpenLibraryOptions,
  body: (recueil: Recueil) => Promise<T>,
): Promise<T> => {
  if (options.mustExist === true && location.databaseFile !== MEMORY_DATABASE && !existsSync(location.databaseFile)) {
    throw missingLibrary(location);
  }

  const createOptions: CreateRecueilOptions = {
    databaseUrl: location.databaseUrl,
    storagePath: location.storagePath,
    ...(options.indexOnWrite === undefined ? {} : { indexOnWrite: options.indexOnWrite }),
  };

  let recueil: Recueil;
  try {
    recueil = createRecueil(createOptions);
  } catch (cause) {
    throw new CliError(
      `the library at '${location.databaseFile}' could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`,
      { exitCode: ExitCode.JobFailed, cause },
    );
  }

  try {
    return await body(recueil);
  } finally {
    recueil.close();
  }
};
