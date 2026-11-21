import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncZoteroLibraries } from '../src/index.js';
import { harness, linkedItemId, linkedId } from './helpers.js';
import type { Harness } from './helpers.js';

let h: Harness;
beforeEach(() => { h = harness(); });
afterEach(() => { h.close(); });

const article = (o: Record<string, unknown> = {}) => ({
  itemType: 'journalArticle', title: 'T', creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }],
  publicationTitle: 'Injury', volume: '12', DOI: '10.1000/x', ...o,
});

describe('audit', () => {
  it('T1 both sides edit different fields, CLI path', async () => {
    const item = h.zotero.put('items', article());
    await syncZoteroLibraries(h.recueil, h.client, {});
    const id = linkedItemId(h, item.key);
    h.zotero.edit(item.key, { title: 'Zotero title' });
    h.recueil.library.updateItem(id, { bibliographic: { volume: '13' } }, h.recueil.actor);
    const r1 = await syncZoteroLibraries(h.recueil, h.client, {});
    console.log('T1 run1', JSON.stringify({ d: r1[0]!.deferred, e: r1[0]!.errors, up: r1[0]!.toZotero.item }));
    const r2 = await syncZoteroLibraries(h.recueil, h.client, {});
    console.log('T1 run2', JSON.stringify({ d: r2[0]!.deferred, e: r2[0]!.errors }));
    console.log('T1 online volume', h.zotero.get(item.key)!['volume'], 'local title', h.recueil.library.getItem(id).item.title);
  });

  it('T2 pull error is skipped forever', async () => {
    const item = h.zotero.put('items', article());
    const orig = h.recueil.library.createItem.bind(h.recueil.library);
    let fail = true;
    (h.recueil.library as any).createItem = (...a: any[]) => { if (fail) { fail = false; throw new Error('boom'); } return (orig as any)(...a); };
    const r1 = await h.sync();
    console.log('T2 run1 errors', r1.errors.length);
    const r2 = await h.sync();
    const n = (h.recueil.connection.prepare('select count(*) n from items').get() as any).n;
    console.log('T2 run2 created', r2.toRecueil.item.created, 'items in recueil', n, 'zotero items', h.zotero.all('items').length);
    void item;
  });

  it('T3 local-only collection, non-home library', async () => {
    const item = h.zotero.put('items', article());
    await h.sync({ home: false });
    const id = linkedItemId(h, item.key);
    const c = h.recueil.collections.create({ name: 'Local' }, h.recueil.actor);
    h.recueil.collections.addItems(c.id, [id], h.recueil.actor);
    for (let i = 0; i < 3; i++) {
      const r = await h.sync({ home: false });
      console.log('T3 run', i, 'writes', h.zotero.writes().length, JSON.stringify(r.toZotero.item));
    }
  });

  it('T4 note emptied in Zotero', async () => {
    const item = h.zotero.put('items', article());
    const note = h.zotero.put('items', { itemType: 'note', parentItem: item.key, note: '<p>Hello</p>' });
    await h.sync();
    h.zotero.edit(note.key, { note: '' });
    await h.sync();
    await h.sync();
    console.log('T4 online note', JSON.stringify(h.zotero.get(note.key)!['note']));
  });

  it('T5 review conflict then CLI path', async () => {
    const item = h.zotero.put('items', article());
    await syncZoteroLibraries(h.recueil, h.client, {});
    const id = linkedItemId(h, item.key);
    h.zotero.edit(item.key, { volume: '14' });
    h.recueil.library.updateItem(id, { bibliographic: { volume: '13' } }, h.recueil.actor);
    const r1 = await syncZoteroLibraries(h.recueil, h.client, {});
    console.log('T5 conflicts', JSON.stringify(r1[0]!.conflicts.map((c) => [c.field, c.outcome])));
    const open = h.recueil.connection.prepare("select id from zotero_sync_conflicts where state='open'").all() as any[];
    const { resolveConflict } = await import('../src/index.js');
    resolveConflict(h.recueil, open[0].id, 'recueil');
    const r2 = await syncZoteroLibraries(h.recueil, h.client, {});
    console.log('T5 after resolve', h.zotero.get(item.key)!['volume'], JSON.stringify(r2[0]!.deferred), JSON.stringify(r2[0]!.conflicts));
    void linkedId;
  });
});
