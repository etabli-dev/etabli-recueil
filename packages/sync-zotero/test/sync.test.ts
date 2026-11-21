import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveConflict } from '../src/index.js';
import { fakeKey } from './fake-zotero.js';
import { harness, linkedId, linkedItemId } from './helpers.js';
import type { Harness } from './helpers.js';

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

const article = (overrides: Record<string, unknown> = {}) => ({
  itemType: 'journalArticle',
  title: 'Fracture healing in the elderly',
  creators: [
    { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
    { creatorType: 'editor', name: 'Royal Society' },
  ],
  publicationTitle: 'Injury',
  volume: '12',
  pages: '101-110',
  date: '2020-05-03',
  DOI: '10.1000/ABC.123',
  tags: [{ tag: 'trauma' }, { tag: 'geriatrics', type: 1 }],
  extra: 'PMID: 1234567',
  ...overrides,
});

describe('pull', () => {
  it('brings a zotero.org library into Recueil', async () => {
    const parent = h.zotero.put('collections', { name: 'Trauma' });
    const child = h.zotero.put('collections', { name: 'Hip', parentCollection: parent.key });
    const item = h.zotero.put('items', article({ collections: [child.key] }));
    h.zotero.put('items', { itemType: 'note', parentItem: item.key, note: '<p>Read <strong>this</strong> first.</p>' });
    const pdf = h.zotero.put('items', {
      itemType: 'attachment',
      parentItem: item.key,
      linkMode: 'imported_file',
      title: 'Full text',
      filename: 'paper.pdf',
      contentType: 'application/pdf',
    });
    h.zotero.attachFile(pdf.key, new TextEncoder().encode('%PDF-1.4 fake'));

    const report = await h.sync();

    expect(report.errors).toEqual([]);
    expect(report.toRecueil.collection.created).toBe(2);
    expect(report.toRecueil.item.created).toBe(1);
    expect(report.toRecueil.note.created).toBe(1);
    expect(report.toRecueil.attachment.created).toBe(1);
    expect(report.files.downloaded).toBe(1);

    const itemId = linkedItemId(h, item.key);
    const record = h.recueil.library.getItem(itemId);
    expect(record.item.title).toBe('Fracture healing in the elderly');
    expect(record.bibliographic?.doi).toBe('10.1000/abc.123');
    expect(record.bibliographic?.issuedYear).toBe(2020);
    expect(record.bibliographic?.pageFirst).toBe(101);
    expect(record.item.extra).toBe('PMID: 1234567');
    expect(h.recueil.tags.forItem(itemId).map((tag) => tag.name).sort()).toEqual(['geriatrics', 'trauma']);
    expect(h.recueil.collections.forItem(itemId).map((c) => c.name)).toEqual(['Hip']);
    const creators = h.recueil.creators.forItem(itemId);
    expect(creators.map((c) => [c.appearance.role, c.creator.displayName])).toEqual([
      ['author', 'Ada Lovelace'],
      ['editor', 'Royal Society'],
    ]);
    const hip = h.recueil.collections.get(linkedId(h, 'collection', child.key));
    expect(hip.parentId).toBe(linkedId(h, 'collection', parent.key));
    expect(h.recueil.notes.forItem(itemId)[0]?.contentMarkdown).toContain('**this**');

    // The key went to the API host only.
    const fileRequests = h.zotero.requests.filter((request) => request.url.startsWith('http://files.'));
    expect(fileRequests).toHaveLength(1);
    expect(fileRequests[0]?.headers['zotero-api-key']).toBeUndefined();
  });

  it('writes nothing to zotero.org when nothing changed, and is a no-op the second time', async () => {
    h.zotero.put('items', article());
    await h.sync();
    const writesAfterFirst = h.zotero.writes().length;
    expect(writesAfterFirst).toBe(0);

    const second = await h.sync();
    expect(second.errors).toEqual([]);
    expect(h.zotero.writes().length).toBe(0);
    expect(second.toRecueil.item.created + second.toRecueil.item.updated).toBe(0);
    expect(second.toZotero.item.updated).toBe(0);
  });

  it('applies an edit made on zotero.org', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    h.zotero.edit(item.key, { title: 'A new title', tags: [{ tag: 'trauma' }, { tag: 'hip' }] });

    const report = await h.sync();
    const itemId = linkedItemId(h, item.key);
    expect(report.toRecueil.item.updated).toBe(1);
    expect(h.recueil.library.getItem(itemId).item.title).toBe('A new title');
    expect(h.recueil.tags.forItem(itemId).map((tag) => tag.name).sort()).toEqual(['hip', 'trauma']);
    expect(h.zotero.writes()).toHaveLength(0);
  });

  it('moves an item to the Recueil trash when it is trashed or deleted on zotero.org', async () => {
    const trashed = h.zotero.put('items', article({ DOI: '10.1/a' }));
    const gone = h.zotero.put('items', article({ DOI: '10.1/b', title: 'Gone' }));
    await h.sync();
    h.zotero.edit(trashed.key, { deleted: 1 });
    h.zotero.remove(gone.key);

    const report = await h.sync();
    expect(report.toRecueil.item.trashed).toBe(2);
    expect(h.recueil.library.getItem(linkedItemId(h, trashed.key), { includeTrashed: true }).item.trashedAt).not.toBeNull();
    // The permanently deleted one is in the trash, not gone.
    const count = h.recueil.connection.prepare(`select count(*) as n from items where trashed_at is not null`).get() as {
      n: number;
    };
    expect(count.n).toBe(2);
  });

  it('adopts items that came from `recueil import zotero` instead of duplicating them', async () => {
    const key = fakeKey();
    h.recueil.library.createItem(
      { itemType: 'article', title: 'Imported earlier', sourceSystem: 'zotero', sourceId: key },
      h.recueil.actor,
    );
    h.zotero.put('items', article({ key, title: 'Imported earlier, then edited online' }));

    const report = await h.sync();
    expect(report.toRecueil.item.adopted).toBe(1);
    expect(report.toRecueil.item.created).toBe(0);
    const rows = h.recueil.connection.prepare('select title from items').all() as Array<{ title: string }>;
    expect(rows.map((row) => row.title)).toEqual(['Imported earlier, then edited online']);
  });
});

describe('push', () => {
  it('pushes an edit made in Recueil, and only that edit', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.recueil.library.updateItem(itemId, { bibliographic: { volume: '13' } }, h.recueil.actor);
    h.recueil.tags.assignByName(itemId, 'reviewed', h.recueil.actor);

    const report = await h.sync();
    expect(report.errors).toEqual([]);
    expect(report.toZotero.item.updated).toBe(1);
    const online = h.zotero.get(item.key)!;
    expect(online['volume']).toBe('13');
    // The DOI Recueil lower-cased is not an edit, so Zotero keeps its own spelling.
    expect(online['DOI']).toBe('10.1000/ABC.123');
    // A field Recueil does not model survives the round trip untouched.
    expect(online['journalAbbreviation']).toBeUndefined();
    expect((online['tags'] as Array<{ tag: string; type?: number }>).find((tag) => tag.tag === 'geriatrics')?.type).toBe(1);
    expect((online['tags'] as Array<{ tag: string }>).map((tag) => tag.tag).sort()).toEqual([
      'geriatrics',
      'reviewed',
      'trauma',
    ]);

    // And it settles: the next run sends nothing.
    const writes = h.zotero.writes().length;
    const settled = await h.sync();
    expect(settled.errors).toEqual([]);
    expect(h.zotero.writes().length).toBe(writes);
  });

  it('creates new Recueil items, collections and notes in the home library', async () => {
    const collection = h.recueil.collections.create({ name: 'Reading list' }, h.recueil.actor);
    const record = h.recueil.library.createItem(
      {
        itemType: 'book',
        title: 'Operative techniques',
        bibliographic: { title: 'Operative techniques', publisher: 'Thieme', isbn: '9780306406157', issuedDate: '2019' },
      },
      h.recueil.actor,
    );
    h.recueil.collections.addItems(collection.id, [record.item.id], h.recueil.actor);
    h.recueil.notes.create({ itemId: record.item.id, contentMarkdown: '# Summary\n\nGood *chapter* on plating.' }, h.recueil.actor);
    // An office document (no bibliographic facet) is not pushed by default.
    h.recueil.library.createItem({ itemType: 'invoice', title: 'Electricity bill' }, h.recueil.actor);

    const report = await h.sync();
    expect(report.errors).toEqual([]);
    expect(report.toZotero.collection.created).toBe(1);
    expect(report.toZotero.item.created).toBe(1);
    expect(report.toZotero.note.created).toBe(1);

    const books = h.zotero.all('items').filter((item) => item['itemType'] === 'book');
    expect(books).toHaveLength(1);
    const book = books[0]!;
    expect(book['title']).toBe('Operative techniques');
    expect(book['publisher']).toBe('Thieme');
    expect(book['date']).toBe('2019');
    const onlineCollection = h.zotero.all('collections')[0]!;
    expect(book['collections']).toEqual([onlineCollection.key]);
    const note = h.zotero.all('items').find((item) => item['itemType'] === 'note')!;
    expect(note['parentItem']).toBe(book.key);
    expect(note['note']).toContain('<h1>Summary</h1>');
    expect(note['note']).toContain('<em>chapter</em>');

    const settled = await h.sync();
    expect(settled.errors).toEqual([]);
    expect(settled.toZotero.item.created).toBe(0);
    expect(h.zotero.all('items')).toHaveLength(2);
  });

  it('uploads the file of a new stored attachment', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    const bytes = new TextEncoder().encode('%PDF-1.7 local file');
    await h.recueil.documents.ingestBuffer(bytes, {
      sourceKind: 'upload',
      originalFilename: 'local.pdf',
      declaredMimeType: 'application/pdf',
      attachTo: { itemId, title: 'Local copy' },
    });

    const report = await h.sync();
    expect(report.errors).toEqual([]);
    expect(report.toZotero.attachment.created).toBe(1);
    expect(report.files.uploaded).toBe(1);
    const attachment = h.zotero.all('items').find((entry) => entry['itemType'] === 'attachment')!;
    expect(attachment['parentItem']).toBe(item.key);
    expect(attachment['md5']).toBe(createHash('md5').update(bytes).digest('hex'));
    expect(Buffer.from(h.zotero.files.get(attachment.key)!).toString()).toBe('%PDF-1.7 local file');
  });

  it('pushes a Recueil trash as the Zotero trash', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    h.recueil.library.trashItem(linkedItemId(h, item.key), h.recueil.actor);
    const report = await h.sync();
    expect(report.toZotero.item.trashed).toBe(1);
    expect(h.zotero.get(item.key)?.['deleted']).toBe(true);
  });

  it('defers a write Zotero refuses as stale, and gets it right on the next run', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.recueil.library.updateItem(itemId, { bibliographic: { volume: '99' } }, h.recueil.actor);
    // Another client edits between this run's pull and its push: simulate by editing during the push.
    const original = h.zotero.fetch;
    let edited = false;
    (h.client as unknown as { fetchImpl: typeof original }).fetchImpl = async (input, init) => {
      if (!edited && (init?.method ?? 'GET') === 'POST' && input.endsWith('/items')) {
        edited = true;
        h.zotero.edit(item.key, { issue: '4' });
      }
      return original(input, init);
    };

    const first = await h.sync();
    expect(first.deferred).toHaveLength(1);
    const second = await h.sync();
    expect(second.errors).toEqual([]);
    const online = h.zotero.get(item.key)!;
    expect(online['volume']).toBe('99');
    expect(online['issue']).toBe('4');
    expect(h.recueil.library.getItem(itemId).bibliographic?.issue).toBe('4');
  });
});

describe('merge and conflicts', () => {
  it('merges edits to different fields from both sides', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.zotero.edit(item.key, { title: 'Title from Zotero' });
    h.recueil.library.updateItem(itemId, { bibliographic: { volume: '14' } }, h.recueil.actor);

    const report = await h.sync();
    expect(report.conflicts).toEqual([]);
    expect(h.recueil.library.getItem(itemId).item.title).toBe('Title from Zotero');
    expect(h.recueil.library.getItem(itemId).bibliographic?.volume).toBe('14');
    expect(h.zotero.get(item.key)?.['volume']).toBe('14');
    expect(h.zotero.get(item.key)?.['title']).toBe('Title from Zotero');
  });

  it('holds a real conflict on both sides until a person decides it', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.zotero.edit(item.key, { volume: '20' });
    h.recueil.library.updateItem(itemId, { bibliographic: { volume: '21' } }, h.recueil.actor);

    const report = await h.sync();
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]).toMatchObject({ field: 'f.volume', recueil: '21', zotero: '20', outcome: 'held' });
    expect(h.recueil.library.getItem(itemId).bibliographic?.volume).toBe('21');
    expect(h.zotero.get(item.key)?.['volume']).toBe('20');

    // Held again on a run with no further edits.
    const again = await h.sync();
    expect(again.conflicts).toHaveLength(0);
    expect(h.zotero.get(item.key)?.['volume']).toBe('20');
    expect(h.recueil.library.getItem(itemId).bibliographic?.volume).toBe('21');

    const open = h.recueil.connection.prepare(`select id from zotero_sync_conflicts where state = 'open'`).all() as Array<{
      id: string;
    }>;
    expect(open).toHaveLength(1);
    resolveConflict(h.recueil, open[0]!.id, 'recueil');
    await h.sync();
    expect(h.zotero.get(item.key)?.['volume']).toBe('21');
    expect(h.recueil.library.getItem(itemId).bibliographic?.volume).toBe('21');
  });

  it('applies a decision for Zotero to Recueil', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.zotero.edit(item.key, { volume: '20' });
    h.recueil.library.updateItem(itemId, { bibliographic: { volume: '21' } }, h.recueil.actor);
    await h.sync();
    const [conflict] = h.recueil.connection.prepare(`select id from zotero_sync_conflicts`).all() as Array<{ id: string }>;
    resolveConflict(h.recueil, conflict!.id, 'zotero');
    await h.sync();
    expect(h.recueil.library.getItem(itemId).bibliographic?.volume).toBe('20');
    expect(h.zotero.get(item.key)?.['volume']).toBe('20');
  });

  it('lets a policy pick a side for values no person locked', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.zotero.edit(item.key, { volume: '20' });
    // An automated write (a resolver, say) does not lock the field.
    h.recueil.library.updateItem(itemId, { bibliographic: { volume: '21' } }, h.recueil.actor, {
      provenance: { source: 'crossref', lock: false },
    });
    const report = await h.sync({ policy: 'zotero' });
    expect(report.conflicts[0]?.outcome).toBe('zotero');
    expect(h.recueil.library.getItem(itemId).bibliographic?.volume).toBe('20');
    const settled = await h.sync({ policy: 'zotero' });
    expect(settled.conflicts).toEqual([]);
    expect(h.zotero.get(item.key)?.['volume']).toBe('20');
  });

  it('does not let a policy overwrite a hand edit in Recueil', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.zotero.edit(item.key, { volume: '20' });
    h.recueil.library.updateItem(itemId, { bibliographic: { volume: '21' } }, h.recueil.actor);
    const report = await h.sync({ policy: 'zotero' });
    expect(report.conflicts[0]?.outcome).toBe('held');
    await h.sync({ policy: 'zotero' });
    expect(h.recueil.library.getItem(itemId).bibliographic?.volume).toBe('21');
    expect(h.zotero.get(item.key)?.['volume']).toBe('20');
  });

  it('never overwrites a field locked in Recueil from a pull', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.recueil.library.lockBibliographicField(itemId, 'volume', h.recueil.actor);
    h.zotero.edit(item.key, { volume: '30' });
    const report = await h.sync({ policy: 'zotero' });
    expect(report.conflicts.map((conflict) => conflict.field)).toEqual(['f.volume']);
    expect(h.recueil.library.getItem(itemId).bibliographic?.volume).toBe('12');
  });

  it('merges tags from both sides as sets', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.zotero.edit(item.key, { tags: [{ tag: 'trauma' }, { tag: 'geriatrics', type: 1 }, { tag: 'online' }] });
    h.recueil.tags.assignByName(itemId, 'local', h.recueil.actor);
    const trauma = h.recueil.tags.forItem(itemId).find((tag) => tag.name === 'trauma')!;
    h.recueil.tags.unassign(itemId, trauma.id, h.recueil.actor);

    const report = await h.sync();
    expect(report.conflicts).toEqual([]);
    const expected = ['geriatrics', 'local', 'online'];
    expect(h.recueil.tags.forItem(itemId).map((tag) => tag.name).sort()).toEqual(expected);
    expect((h.zotero.get(item.key)?.['tags'] as Array<{ tag: string }>).map((tag) => tag.tag).sort()).toEqual(expected);
  });
});

describe('safety', () => {
  it('writes nothing to either side in a dry run, and reports what it would do', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.recueil.library.updateItem(itemId, { bibliographic: { volume: '50' } }, h.recueil.actor);
    h.zotero.put('items', article({ title: 'New online', DOI: '10.9/new' }));
    const writes = h.zotero.writes().length;

    const report = await h.sync({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.toRecueil.item.created).toBe(1);
    expect(report.toZotero.item.updated).toBe(1);
    expect(h.zotero.writes().length).toBe(writes);
    const items = h.recueil.connection.prepare('select count(*) as n from items').get() as { n: number };
    expect(items.n).toBe(1);
    expect(h.zotero.get(item.key)?.['volume']).toBe('12');
  });

  it('waits out a 429 and obeys Retry-After', async () => {
    h.zotero.put('items', article());
    h.zotero.throttle = 2;
    const report = await h.sync();
    expect(report.errors).toEqual([]);
    expect(report.toRecueil.item.created).toBe(1);
  });

  it('refuses a downloaded file whose MD5 is not the one Zotero states', async () => {
    const item = h.zotero.put('items', article());
    const pdf = h.zotero.put('items', {
      itemType: 'attachment',
      parentItem: item.key,
      linkMode: 'imported_file',
      title: 'Full text',
      filename: 'paper.pdf',
    });
    h.zotero.attachFile(pdf.key, new TextEncoder().encode('real bytes'));
    h.zotero.files.set(pdf.key, new TextEncoder().encode('tampered'));
    const report = await h.sync();
    expect(report.errors.some((error) => error.message.includes('MD5'))).toBe(true);
    const documents = h.recueil.connection.prepare('select count(*) as n from documents').get() as { n: number };
    expect(documents.n).toBe(0);
  });

  it('does not delete on zotero.org what was purged in Recueil, unless asked to', async () => {
    const item = h.zotero.put('items', article());
    await h.sync();
    const itemId = linkedItemId(h, item.key);
    h.recueil.library.trashItem(itemId, h.recueil.actor);
    await h.sync();
    const trashRow = h.recueil.trash.find('item', itemId)!;
    h.recueil.trash.purge(trashRow.id, h.recueil.actor);

    const report = await h.sync();
    expect(report.notPushed.some((event) => event.key === item.key)).toBe(true);
    expect(h.zotero.get(item.key)).toBeDefined();

    const purged = await h.sync({ propagatePurge: true });
    expect(purged.toZotero.item.trashed).toBe(1);
    expect(h.zotero.get(item.key)).toBeUndefined();
  });
});

describe('several libraries', () => {
  it('does not push an item that came from an unbridged Zotero library', async () => {
    h.recueil.library.createItem(
      {
        itemType: 'article',
        title: 'From a group nobody bridged',
        sourceSystem: 'zotero',
        sourceId: 'ABCD2345',
        bibliographic: { title: 'From a group nobody bridged' },
      },
      h.recueil.actor,
    );
    const report = await h.sync();
    expect(report.toZotero.item.created).toBe(0);
    expect(report.notPushed.map((event) => event.key)).toContain('ABCD2345');
    expect(h.zotero.all('items')).toHaveLength(0);
  });

  it('syncs every library the key reaches, pulling all before pushing any', async () => {
    const { syncZoteroLibraries } = await import('../src/index.js');
    h.zotero.put('items', article());
    h.recueil.library.createItem(
      { itemType: 'book', title: 'Local only', bibliographic: { title: 'Local only' } },
      h.recueil.actor,
    );
    const reports = await syncZoteroLibraries(h.recueil, h.client, {});
    expect(reports).toHaveLength(1);
    expect(reports[0]?.toRecueil.item.created).toBe(1);
    expect(reports[0]?.toZotero.item.created).toBe(1);
    expect(h.zotero.all('items')).toHaveLength(2);
  });
});

describe('dry run over several libraries', () => {
  it('plans the push against what the pull would have done, and rolls all of it back', async () => {
    const { syncZoteroLibraries } = await import('../src/index.js');
    const key = h.zotero.put('items', article()).key;
    // Imported earlier: the pull would adopt it, so the push must not plan to create it.
    h.recueil.library.createItem(
      { itemType: 'article', title: 'Imported', sourceSystem: 'zotero', sourceId: key, bibliographic: { title: 'Imported' } },
      h.recueil.actor,
    );
    const [report] = await syncZoteroLibraries(h.recueil, h.client, { dryRun: true });
    expect(report?.toRecueil.item.adopted).toBe(1);
    expect(report?.toZotero.item.created).toBe(0);
    expect(h.zotero.writes()).toHaveLength(0);
    const links = h.recueil.connection.prepare('select count(*) as n from zotero_sync_links').get() as { n: number };
    expect(links.n).toBe(0);
  });
});

describe('pull and push in separate passes', () => {
  it('settles a two-sided merge when every library is pulled before any is pushed', async () => {
    const { syncZoteroLibraries } = await import('../src/index.js');
    const item = h.zotero.put('items', article());
    await syncZoteroLibraries(h.recueil, h.client, {});
    const itemId = linkedItemId(h, item.key);
    h.zotero.edit(item.key, { title: 'Title from Zotero' });
    h.recueil.library.updateItem(itemId, { bibliographic: { volume: '14' } }, h.recueil.actor);

    const [first] = await syncZoteroLibraries(h.recueil, h.client, {});
    expect(first?.deferred).toEqual([]);
    expect(h.zotero.get(item.key)?.['volume']).toBe('14');
    expect(h.zotero.get(item.key)?.['title']).toBe('Title from Zotero');

    const writes = h.zotero.writes().length;
    const [second] = await syncZoteroLibraries(h.recueil, h.client, {});
    expect(second?.deferred).toEqual([]);
    expect(second?.errors).toEqual([]);
    expect(h.zotero.writes().length).toBe(writes);
  });
});

describe('found in the audit', () => {
  it('fetches again an item whose pull failed', async () => {
    h.zotero.put('items', article());
    const original = h.recueil.library.createItem.bind(h.recueil.library);
    let fail = true;
    h.recueil.library.createItem = ((...args: Parameters<typeof original>) => {
      if (fail) {
        fail = false;
        throw new Error('boom');
      }
      return original(...args);
    }) as typeof original;
    const first = await h.sync();
    expect(first.errors).toHaveLength(1);
    const second = await h.sync();
    expect(second.toRecueil.item.created).toBe(1);
  });

  it('does not write on every run for a collection Zotero does not know', async () => {
    const item = h.zotero.put('items', article());
    await h.sync({ home: false });
    const local = h.recueil.collections.create({ name: 'Local only' }, h.recueil.actor);
    h.recueil.collections.addItems(local.id, [linkedItemId(h, item.key)], h.recueil.actor);
    await h.sync({ home: false });
    const writes = h.zotero.writes().length;
    await h.sync({ home: false });
    await h.sync({ home: false });
    expect(h.zotero.writes().length).toBe(writes);
  });

  it('holds a note emptied in Zotero instead of putting the old text back', async () => {
    const item = h.zotero.put('items', article());
    const note = h.zotero.put('items', { itemType: 'note', parentItem: item.key, note: '<p>Hello</p>' });
    await h.sync();
    h.zotero.edit(note.key, { note: '' });
    const report = await h.sync();
    expect(report.review.some((event) => event.message.includes('emptied'))).toBe(true);
    await h.sync();
    expect(h.zotero.get(note.key)?.['note']).toBe('');
    expect(h.recueil.notes.get(linkedId(h, 'note', note.key)).contentMarkdown).toContain('Hello');
  });
});
