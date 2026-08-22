/**
 * Where the data commands look for the library.
 *
 * The precedence — flag, then environment, then default — is the same one `recueil serve` uses,
 * and the point of these tests is that it stays the same one. A CLI where `recueil backup` and
 * `recueil serve` disagree about which database they mean is a CLI that will one day back up an
 * empty library and report success.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DATABASE_URL,
  DEFAULT_STORAGE_PATH,
  resolveLibraryLocation,
} from '../src/library.js';

const emptyEnvironment: NodeJS.ProcessEnv = {};

describe('resolveLibraryLocation', () => {
  it('prefers a flag over the environment, and the environment over the default', () => {
    const environment: NodeJS.ProcessEnv = {
      RECUEIL_DATABASE_URL: '/from/env.sqlite',
      RECUEIL_STORAGE_PATH: '/from/env/storage',
    };

    expect(resolveLibraryLocation({ database: '/from/flag.sqlite' }, environment).databaseUrl).toBe(
      '/from/flag.sqlite',
    );
    expect(resolveLibraryLocation({}, environment).databaseUrl).toBe('/from/env.sqlite');
    expect(resolveLibraryLocation({}, emptyEnvironment).databaseUrl).toBe(DEFAULT_DATABASE_URL);
    expect(resolveLibraryLocation({}, emptyEnvironment).storagePath.endsWith('/data/storage')).toBe(true);
  });

  it('says where each value came from, so a printed banner can be traced to a flag', () => {
    const environment: NodeJS.ProcessEnv = { RECUEIL_STORAGE_PATH: '/from/env/storage' };
    const resolved = resolveLibraryLocation({ database: '/from/flag.sqlite' }, environment);

    expect(resolved.origin).toEqual({ database: 'flag', storage: 'environment' });
    expect(resolveLibraryLocation({}, emptyEnvironment).origin).toEqual({
      database: 'default',
      storage: 'default',
    });
  });

  it('resolves the URL forms a person actually types', () => {
    expect(resolveLibraryLocation({ database: 'file:./library.db' }, emptyEnvironment).databaseFile).toBe(
      './library.db',
    );
    expect(resolveLibraryLocation({ database: ':memory:' }, emptyEnvironment).databaseFile).toBe(':memory:');
    expect(resolveLibraryLocation({ database: '/var/lib/x.sqlite' }, emptyEnvironment).databaseFile).toBe(
      '/var/lib/x.sqlite',
    );
  });
});

describe('the defaults', () => {
  it('are the ones @recueil/server resolves to', async () => {
    // Restated in `src/library.ts` rather than imported, so that `recueil export` does not load
    // Fastify. This is the test that keeps the restatement honest.
    const { loadConfig } = (await import('@recueil/server')) as {
      loadConfig: (env: NodeJS.ProcessEnv) => { databaseUrl: string; storagePath: string };
    };

    const server = loadConfig({ NODE_ENV: 'test' });

    expect(DEFAULT_DATABASE_URL).toBe(server.databaseUrl);
    // The server resolves its storage path to an absolute one; the CLI does the same, so the two
    // are compared after resolution.
    expect(resolveLibraryLocation({}, emptyEnvironment).storagePath).toBe(server.storagePath);
    expect(DEFAULT_STORAGE_PATH).toBe('./data/storage');
  });
});
