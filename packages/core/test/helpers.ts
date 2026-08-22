/**
 * Test scaffolding.
 *
 * Every test gets a real SQLite file and a real store in a fresh temp directory, not a mock. The
 * things worth testing here — a partial unique index, a foreign key, an append-only trigger, an
 * atomic rename — exist only in the real thing, and a fake would assert that the fake works.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecueil } from '../src/index.js';
import type { Recueil } from '../src/index.js';

export interface TestLibrary extends Recueil {
  root: string;
  databaseFile: string;
  storageRoot: string;
  dispose(): void;
}

/** A library on disk, in a directory that cleans itself up. */
export const makeLibrary = (): TestLibrary => {
  const root = mkdtempSync(join(tmpdir(), 'recueil-core-'));
  const databaseFile = join(root, 'library.sqlite');
  const storageRoot = join(root, 'store');

  const recueil = createRecueil({ databaseUrl: databaseFile, storagePath: storageRoot });

  return {
    ...recueil,
    root,
    databaseFile,
    storageRoot,
    dispose: () => {
      recueil.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

/** A temp directory for tests that need one without a whole library. */
export const makeTempDirectory = (): { path: string; dispose(): void } => {
  const path = mkdtempSync(join(tmpdir(), 'recueil-store-'));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
};
