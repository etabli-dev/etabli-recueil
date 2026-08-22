/**
 * The bootstrap, over a real socket.
 *
 * `fastify.inject()` covers the routes without a network, which is why the rest of the suite uses
 * it. This file exists for the part inject cannot reach: that `start` opens a library from a
 * configuration, migrates a database that did not exist a moment ago, binds a port, answers a real
 * HTTP request and then shuts down without leaving the database open. That is `recueil serve`, and
 * it is the sentence the Phase 0 exit criterion is written in.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { start } from '../src/server.js';
import type { RunningServer } from '../src/server.js';

let running: RunningServer | undefined;
let root: string | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('start', () => {
  it('serves health on a port it was told to take', async () => {
    root = mkdtempSync(join(tmpdir(), 'recueil-serve-'));
    const config = loadConfig({
      RECUEIL_PORT: '0',
      RECUEIL_HOST: '127.0.0.1',
      RECUEIL_DATABASE_URL: `file:${join(root, 'library.db')}`,
      RECUEIL_STORAGE_PATH: join(root, 'storage'),
      RECUEIL_LOG_LEVEL: 'silent',
    });

    running = await start({ config, version: '0.1.0-test', handleSignals: false });

    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    // The database file and the store are created on the way up, not on first use.
    expect(existsSync(join(root, 'library.db'))).toBe(true);
    expect(existsSync(join(root, 'storage'))).toBe(true);

    const response = await fetch(`${running.url}/health`);
    expect(response.status).toBe(200);

    const health = (await response.json()) as Record<string, any>;
    expect(health.status).toBe('ok');
    expect(health.library.items).toBe(0);
    expect(health.library.documents).toBe(0);
    expect(health.database.migrationsApplied).toBeGreaterThan(0);
    expect(health.storage.path).toBe(join(root, 'storage'));
  });

  it('stops cleanly, and stopping twice is not an error', async () => {
    root = mkdtempSync(join(tmpdir(), 'recueil-serve-'));
    const config = loadConfig({
      RECUEIL_PORT: '0',
      RECUEIL_HOST: '127.0.0.1',
      RECUEIL_DATABASE_URL: `file:${join(root, 'library.db')}`,
      RECUEIL_STORAGE_PATH: join(root, 'storage'),
      RECUEIL_LOG_LEVEL: 'silent',
    });

    const server = await start({ config, version: '0.1.0-test', handleSignals: false });
    const { url } = server;

    await server.stop();
    await server.stop();

    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });
});
