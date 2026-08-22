/**
 * Test fixtures: a real library in a temporary directory, and an application built on it.
 *
 * Nothing here is mocked. The Phase 0 exit criterion is about what a running server reports, so a
 * test that stubbed the database would be testing the stub — the counts in `/health` have to come
 * out of SQLite or they prove nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecueil } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ServerConfig } from '../src/config.js';

export interface Harness {
  readonly app: FastifyInstance;
  readonly recueil: Recueil;
  readonly config: ServerConfig;
  readonly root: string;
  close(): Promise<void>;
}

/** A configuration pointing at a fresh temporary directory, parsed through the real parser. */
export const temporaryConfig = (overrides: NodeJS.ProcessEnv = {}): { config: ServerConfig; root: string } => {
  const root = mkdtempSync(join(tmpdir(), 'recueil-server-'));
  const config = loadConfig({
    RECUEIL_PORT: '0',
    RECUEIL_HOST: '127.0.0.1',
    RECUEIL_DATABASE_URL: `file:${join(root, 'recueil.db')}`,
    RECUEIL_STORAGE_PATH: join(root, 'storage'),
    RECUEIL_LOG_LEVEL: 'silent',
    ...overrides,
  });
  return { config, root };
};

export interface HarnessOptions {
  /** Environment overrides, parsed through the real configuration parser. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Register extra routes before the instance is made ready. Fastify refuses new routes after
   * `ready()`, so a test that needs a handler of its own has to hand it over here.
   */
  readonly routes?: (app: FastifyInstance) => void;
}

/** Build an application over a fresh library. `close` drops the database and the temporary tree. */
export const harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const { config, root } = temporaryConfig(options.env);
  const recueil = createRecueil({ databaseUrl: config.databaseUrl, storagePath: config.storagePath });
  const app = buildApp({ config, recueil, version: '0.1.0-test' });

  options.routes?.(app);

  await app.ready();

  return {
    app,
    recueil,
    config,
    root,
    close: async () => {
      await app.close();
      recueil.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};
