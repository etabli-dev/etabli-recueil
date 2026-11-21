import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecueil } from '@recueil/core';
import type { Recueil } from '@recueil/core';

import { ZoteroApiClient, ZoteroSync } from '../src/index.js';
import type { ZoteroSyncOptions } from '../src/index.js';
import { API_KEY, FakeZotero } from './fake-zotero.js';

export interface Harness {
  recueil: Recueil;
  zotero: FakeZotero;
  client: ZoteroApiClient;
  sync(options?: Partial<ZoteroSyncOptions>): ReturnType<ZoteroSync['run']>;
  close(): void;
}

export const harness = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'recueil-sync-'));
  const recueil = createRecueil({ databaseUrl: join(dir, 'library.sqlite'), storagePath: join(dir, 'store') });
  const zotero = new FakeZotero();
  const client = new ZoteroApiClient({
    apiKey: API_KEY,
    baseUrl: 'http://api.zotero.test',
    fetch: zotero.fetch,
    sleep: async () => undefined,
  });
  return {
    recueil,
    zotero,
    client,
    sync: (options = {}) =>
      new ZoteroSync(recueil, client, {
        library: { type: 'user', id: zotero.userId },
        home: true,
        ...options,
      }).run(),
    close: () => {
      recueil.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** The Recueil item a Zotero key is linked to. */
export const linkedItemId = (h: Harness, key: string): string => {
  const row = h.recueil.connection
    .prepare(`select recueil_id as id from zotero_sync_links where zotero_key = ? and object_type = 'item'`)
    .get(key) as { id: string } | undefined;
  if (row === undefined) throw new Error(`no link for ${key}`);
  return row.id;
};

export const linkedId = (h: Harness, objectType: string, key: string): string => {
  const row = h.recueil.connection
    .prepare(`select recueil_id as id from zotero_sync_links where zotero_key = ? and object_type = ?`)
    .get(key, objectType) as { id: string } | undefined;
  if (row === undefined) throw new Error(`no ${objectType} link for ${key}`);
  return row.id;
};
