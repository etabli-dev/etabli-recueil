/**
 * A real library on disk, for the tests that back one up and restore it.
 *
 * Nothing here is a mock. A backup's whole subject matter is a SQLite file with a write-ahead log
 * and a content-addressed directory of real bytes; a fake of either would test the fake.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { createRecueil } from '@recueil/core';

export interface TemporaryLibrary {
  readonly root: string;
  readonly databaseFile: string;
  readonly storageRoot: string;
  dispose(): void;
}

export const makeTempDirectory = (prefix = 'recueil-cli-'): { path: string; dispose(): void } => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
};

/**
 * A library with items, documents, attachments, tags, notes and a trashed item.
 *
 * Deliberately more than one of everything: a snapshot that happened to work on a library holding
 * one row would prove very little, and the trashed item is there because `trashed_at` and the
 * mirrored facet column are exactly the sort of thing a naive copy gets wrong.
 */
export const makePopulatedLibrary = async (): Promise<TemporaryLibrary> => {
  const root = mkdtempSync(join(tmpdir(), 'recueil-cli-lib-'));
  const databaseFile = join(root, 'library.sqlite');
  const storageRoot = join(root, 'storage');

  const recueil = createRecueil({ databaseUrl: databaseFile, storagePath: storageRoot });

  try {
    const collection = recueil.collections.create({ name: 'Chapter 3' }, recueil.actor);

    for (let index = 0; index < 5; index += 1) {
      const item = recueil.library.createItem(
        {
          itemType: 'article',
          bibliographic: {
            title: `A paper about ${index}`,
            containerTitle: 'Journal of Testing',
            issuedYear: 2020 + index,
            doi: `10.1234/test.${index}`,
            citationKey: `test${index}`,
          },
        },
        recueil.actor,
      );

      recueil.collections.addItems(collection.id, [item.item.id], recueil.actor);
      recueil.tags.assignByName(item.item.id, index % 2 === 0 ? 'even' : 'odd', recueil.actor);
      recueil.notes.create({ itemId: item.item.id, contentMarkdown: `A note on ${index}.` }, recueil.actor);

      // Distinct sizes, and one blob large enough that it is not a single filesystem block.
      const bytes = Buffer.from(`document ${index} `.repeat(1 + index * 500), 'utf8');
      const ingested = await recueil.documents.ingestBuffer(bytes, {
        sourceKind: 'upload',
        originalFilename: `paper-${index}.txt`,
      });
      recueil.documents.attachDocument(
        { itemId: item.item.id, documentId: ingested.document.id, role: 'primary' },
        recueil.actor,
      );
    }

    // One item in the bin: trashing is a state, not a deletion (P5), and it has to survive.
    const doomed = recueil.library.createItem(
      { itemType: 'report', bibliographic: { title: 'Withdrawn' } },
      recueil.actor,
    );
    recueil.library.trashItem(doomed.item.id, recueil.actor, { reason: 'user' });
  } finally {
    recueil.close();
  }

  return {
    root,
    databaseFile,
    storageRoot,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
};

export interface StoreEntry {
  /** Forward-slashed, relative to the store root. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * Every blob in a store, with its digest — the shape "byte-identical" is asserted on.
 *
 * `.tmp/` is excluded, as it is from a backup: it holds partial writes and belongs to neither
 * store's identity.
 */
export const readStoreTree = (root: string): StoreEntry[] => {
  const out: StoreEntry[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.tmp') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const bytes = readFileSync(path);
      out.push({
        path: relative(root, path).split(sep).join('/'),
        size: statSync(path).size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  };

  walk(root);
  out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return out;
};

/** Read a blob's bytes, for the comparison that does not trust the digest. */
export const readBlob = (root: string, relativePath: string): Buffer =>
  readFileSync(join(root, ...relativePath.split('/')));
