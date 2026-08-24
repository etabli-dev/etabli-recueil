/**
 * Test scaffolding.
 *
 * Every test runs against a real Recueil library in a fresh temporary directory and, where it needs
 * a server, a real HTTP server on the loopback interface. Nothing here is a mock: the things worth
 * testing — a partial unique index, a SHA-256 over bytes that really travelled over a socket, a
 * resumed job, a 401 — exist only in the real thing.
 *
 * There is no container anywhere, and there must never be one: this machine has no Docker, and a
 * test that needs a Paperless-ngx instance is a test that never runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecueil } from '@recueil/core';
import type { CreateRecueilOptions, Recueil } from '@recueil/core';

import { FakePaperlessServer } from '../src/testing/fake-server.js';
import type { FakeLibrary, FakeServerOptions } from '../src/testing/fake-server.js';
import { FIXTURE_TOKEN, fixtureLibrary } from '../src/testing/fixtures.js';

export interface TestLibrary extends Recueil {
  root: string;
  databaseFile: string;
  storageRoot: string;
  reportDirectory: string;
  dispose(): void;
}

/** A Recueil library on disk, in a directory that cleans itself up. */
export const makeLibrary = (
  options: Partial<Omit<CreateRecueilOptions, 'databaseUrl' | 'storagePath'>> = {},
): TestLibrary => {
  const root = mkdtempSync(join(tmpdir(), 'recueil-paperless-'));
  const databaseFile = join(root, 'library.sqlite');
  const storageRoot = join(root, 'store');
  const recueil = createRecueil({ ...options, databaseUrl: databaseFile, storagePath: storageRoot });

  return {
    ...recueil,
    root,
    databaseFile,
    storageRoot,
    reportDirectory: join(root, 'report'),
    dispose: () => {
      recueil.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

export interface TestServer {
  server: FakePaperlessServer;
  library: FakeLibrary;
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

/** The fixture library, served over loopback. */
export const startFixtureServer = async (
  options: FakeServerOptions = {},
  library: FakeLibrary = fixtureLibrary(),
): Promise<TestServer> => {
  const server = await FakePaperlessServer.start(library, { token: FIXTURE_TOKEN, ...options });
  return {
    server,
    library,
    baseUrl: server.url,
    token: FIXTURE_TOKEN,
    close: () => server.close(),
  };
};

/** The options every import test uses. Page size 3 forces the pagination path to be exercised. */
export const fixtureImportOptions = (
  server: TestServer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  baseUrl: server.baseUrl,
  token: server.token,
  pageSize: 3,
  ...overrides,
});
