/**
 * Test scaffolding.
 *
 * Every test runs against the real fixture library in `fixtures/zotero/` and a real Recueil
 * library in a fresh temporary directory. Nothing here is a mock: the things worth testing — a
 * partial unique index, a read-only SQLite handle, a SHA-256 over bytes that are really on disk,
 * a resumed job — exist only in the real thing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRecueil } from '@recueil/core';
import type { CreateRecueilOptions, Recueil } from '@recueil/core';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `<repo>/fixtures`. */
export const FIXTURES = resolve(HERE, '..', '..', '..', 'fixtures');

export const ZOTERO_FIXTURE = {
  database: join(FIXTURES, 'zotero', 'zotero.sqlite'),
  betterBibtex: join(FIXTURES, 'zotero', 'better-bibtex.sqlite'),
  storage: join(FIXTURES, 'zotero', 'storage'),
  linkedAttachments: join(FIXTURES, 'zotero', 'linked-attachments'),
  expectedCounts: join(FIXTURES, 'expected-counts.json'),
} as const;

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
  const root = mkdtempSync(join(tmpdir(), 'recueil-zotero-'));
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

/** A temporary directory for a test that needs one without a library. */
export const makeTempDirectory = (): { path: string; dispose(): void } => {
  const path = mkdtempSync(join(tmpdir(), 'recueil-zotero-tmp-'));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
};

/** The options every import test uses against the fixture library. */
export const fixtureImportOptions = (overrides: Record<string, unknown> = {}) => ({
  databasePath: ZOTERO_FIXTURE.database,
  betterBibtexPath: ZOTERO_FIXTURE.betterBibtex,
  storageDirectory: ZOTERO_FIXTURE.storage,
  linkedAttachmentBase: ZOTERO_FIXTURE.linkedAttachments,
  ...overrides,
});
