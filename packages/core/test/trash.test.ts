/**
 * The trash, across every entity (§6.6, P5).
 *
 * The headline behaviour, and the one CONCEPT.md promises: trashing an item hides it from every
 * list, and restoring it brings it back **with its relations intact** — its collections, its tags,
 * its notes, its attachments, and its place in the search index. The rest of this file is the
 * cross-entity view: what is in the bin, restoring by dispatch, and purge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import {
  ConflictError,
  InvariantError,
  NotFoundError,
  ValidationError,
  schema,
} from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

/** An item with a collection, a tag, a note and an attached document hanging off it. */
const furnishedItem = async () => {
  const created = library.library.createItem(
    {
      itemType: 'article',
      bibliographic: { title: 'Early antibiotics in sepsis', doi: '10.1136/bmj.n71' },
    },
    library.actor,
  );
  const item = created.item;

  const collection = library.collections.create({ name: 'To read' }, library.actor);
  library.collections.addItems(collection.id, [item.id], library.actor);

  const tag = library.tags.assignByName(item.id, 'critical care', library.actor, {
    source: 'rule',
    ruleRef: 'ingest/topic',
    confidence: 0.6,
  });

  const note = library.notes.create(
    { itemId: item.id, contentMarkdown: 'Subgroup with hyperlactataemia benefited most.' },
    library.actor,
  );

  const ingested = await library.documents.ingestBuffer(Buffer.from('%PDF-1.7\nbody\n'), {
    sourceKind: 'upload',
    originalFilename: 'trial.pdf',
    attachTo: { itemId: item.id, role: 'primary' },
  });

  return { item, collection, tag, note, attachmentId: ingested.attachmentId as string };
};

describe('trashing an item hides it, restoring brings back its relations', () => {
  it('round-trips an item with a collection, a tag, a note and an attachment', async () => {
    const { item, collection, tag, note, attachmentId } = await furnishedItem();

    expect(library.library.listItems().data.map((row) => row.id)).toEqual([item.id]);

    library.library.trashItem(item.id, library.actor);

    // Hidden from every list and lookup.
    expect(library.library.listItems().data).toEqual([]);
    expect(library.library.countItems()).toBe(0);
    expect(() => library.library.getItem(item.id)).toThrow(NotFoundError);
    expect(library.library.listItems({ collectionId: collection.id }).data).toEqual([]);
    expect(library.library.listItems({ tagId: tag.id }).data).toEqual([]);
    expect(library.collections.countItems(collection.id)).toBe(0);
    expect(library.tags.listItems(tag.id).data).toEqual([]);
    expect(library.search.itemIdsMatching('sepsis')).toEqual([]);
    // The children went with it (I4).
    expect(library.notes.get(note.id, { includeTrashed: true }).trashedAt).not.toBeNull();

    // But it is still asked for by id when the caller says so, and it is in the bin.
    expect(library.library.getItem(item.id, { includeTrashed: true }).item.trashedAt).not.toBeNull();
    expect(library.trash.find('item', item.id)).toBeDefined();
    expect(library.trash.summary()['item']).toBe(1);

    library.library.restoreItem(item.id, library.actor);

    // Back, with everything.
    expect(library.library.listItems().data.map((row) => row.id)).toEqual([item.id]);
    expect(library.collections.forItem(item.id).map((row) => row.id)).toEqual([collection.id]);
    expect(library.library.listItems({ collectionId: collection.id }).data).toHaveLength(1);
    const tags = library.tags.forItem(item.id);
    expect(tags.map((row) => row.id)).toEqual([tag.id]);
    expect(tags[0]?.ruleRef).toBe('ingest/topic');
    expect(library.notes.forItem(item.id).map((row) => row.id)).toEqual([note.id]);
    expect(library.search.itemIdsMatching('sepsis')).toEqual([item.id]);
    expect(library.search.search('hyperlactataemia').hits.map((hit) => hit.entityId)).toEqual([
      note.id,
    ]);

    const attachment = library.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId))
      .get();
    expect(attachment?.trashedAt).toBeNull();

    // T1 holds at both ends: no open trash rows are left behind.
    const open = library.db
      .select()
      .from(schema.trash)
      .where(and(isNull(schema.trash.restoredAt), isNull(schema.trash.purgedAt)))
      .all();
    expect(open).toEqual([]);
  });

  it('leaves an already-trashed sibling alone when the item goes into the bin', () => {
    const item = library.library.createItem({ itemType: 'article' }, library.actor).item;
    const early = library.notes.create({ itemId: item.id, contentMarkdown: 'Early' }, library.actor);
    const late = library.notes.create({ itemId: item.id, contentMarkdown: 'Late' }, library.actor);

    library.notes.trash(early.id, library.actor);
    library.library.trashItem(item.id, library.actor);
    library.library.restoreItem(item.id, library.actor);

    // The note that was already in the bin before the item went in stays there.
    expect(library.notes.get(late.id).trashedAt).toBeNull();
    expect(library.notes.get(early.id, { includeTrashed: true }).trashedAt).not.toBeNull();
  });
});

describe('TrashService — the cross-entity view', () => {
  it('lists the bin, newest first, and pages by cursor', () => {
    const ids = Array.from(
      { length: 4 },
      (_value, index) =>
        library.library.createItem(
          { itemType: 'article', bibliographic: { title: `Paper ${index}` } },
          library.actor,
        ).item.id,
    );
    for (const id of ids) library.library.trashItem(id, library.actor);

    const first = library.trash.list({ limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.page.hasMore).toBe(true);

    const second = library.trash.list({ limit: 2, cursor: first.page.nextCursor as string });
    const seen = [...first.data, ...second.data].map((row) => row.entityId);
    expect(new Set(seen).size).toBe(4);

    expect(library.trash.list({ entityType: 'collection' }).data).toEqual([]);
  });

  it('restores by dispatch, whatever the entity is', () => {
    const item = library.library.createItem({ itemType: 'article' }, library.actor).item;
    const collection = library.collections.create({ name: 'Bin me' }, library.actor);
    const tag = library.tags.create({ name: 'bin me' }, library.actor);
    const note = library.notes.create({ contentMarkdown: 'Bin me' }, library.actor);
    const creator = library.creators.create({ familyName: 'Binned' }, library.actor);

    library.library.trashItem(item.id, library.actor);
    library.collections.trash(collection.id, library.actor);
    library.tags.trash(tag.id, library.actor);
    library.notes.trash(note.id, library.actor);
    library.creators.trash(creator.id, library.actor);
    expect(library.trash.list().data).toHaveLength(5);

    library.trash.restore('item', item.id, library.actor);
    library.trash.restore('collection', collection.id, library.actor);
    library.trash.restore('tag', tag.id, library.actor);
    library.trash.restore('note', note.id, library.actor);
    library.trash.restore('creator', creator.id, library.actor);

    expect(library.trash.list().data).toEqual([]);
    expect(library.library.getItem(item.id).item.trashedAt).toBeNull();
    expect(library.collections.get(collection.id).trashedAt).toBeNull();
    expect(library.tags.get(tag.id).trashedAt).toBeNull();
    expect(library.notes.get(note.id).trashedAt).toBeNull();
    expect(library.creators.get(creator.id).trashedAt).toBeNull();
  });

  it('restores by trash-row id, for a caller paging the bin', () => {
    const item = library.library.createItem({ itemType: 'article' }, library.actor).item;
    library.library.trashItem(item.id, library.actor);

    const [row] = library.trash.list().data;
    library.trash.restoreRecord(row?.id as string, library.actor);
    expect(library.library.getItem(item.id).item.trashedAt).toBeNull();

    // Restoring the same record twice is refused rather than quietly repeated.
    expect(() => library.trash.restoreRecord(row?.id as string, library.actor)).toThrow(
      ConflictError,
    );
  });

  it('refuses to restore a cascaded attachment on its own — it comes back with its item (I4)', async () => {
    const { item, attachmentId } = await furnishedItem();
    library.library.trashItem(item.id, library.actor);

    expect(() => library.trash.restore('attachment', attachmentId, library.actor)).toThrow(
      InvariantError,
    );
    expect(() => library.trash.restore('attachment', attachmentId, library.actor)).toThrow(/I4/u);
  });

  it('refuses to restore an annotation on its own for the same reason', async () => {
    const { item } = await furnishedItem();
    expect(() => library.trash.restore('annotation', item.id, library.actor)).toThrow(
      ValidationError,
    );
  });

  it('purges a record out of the restorable set, and audits it (TR2)', () => {
    const item = library.library.createItem({ itemType: 'article' }, library.actor).item;
    library.library.trashItem(item.id, library.actor);

    const [row] = library.trash.list().data;
    const purged = library.trash.purge(row?.id as string, library.actor, 'operator request');
    expect(purged.purgedAt).not.toBeNull();

    expect(library.trash.list().data).toEqual([]);
    expect(library.trash.find('item', item.id)).toBeUndefined();
    expect(() => library.trash.restoreRecord(row?.id as string, library.actor)).toThrow(/purged/u);

    const audit = library.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'trash.purged'))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe('operator request');
  });

  it('refuses to purge a record whose entity is already back', () => {
    const item = library.library.createItem({ itemType: 'article' }, library.actor).item;
    library.library.trashItem(item.id, library.actor);
    const [row] = library.trash.list().data;
    library.library.restoreItem(item.id, library.actor);

    expect(() => library.trash.purge(row?.id as string, library.actor)).toThrow(/was restored/u);
  });
});

describe('audit_log covers every mutation (P5)', () => {
  it('records a create, an update, a trash and a restore for each entity touched', async () => {
    const { item, collection, tag, note } = await furnishedItem();

    library.library.updateItem(item.id, { extra: 'noted' }, library.actor);
    library.library.trashItem(item.id, library.actor);
    library.library.restoreItem(item.id, library.actor);

    const itemActions = library.audit.forEntity('item', item.id).map((row) => row.action);
    expect(itemActions).toContain('item.created');
    expect(itemActions).toContain('item.updated');
    expect(itemActions).toContain('item.trashed');
    expect(itemActions).toContain('item.restored');
    expect(itemActions).toContain('tag.assigned');

    expect(library.audit.forEntity('collection', collection.id).map((row) => row.action)).toContain(
      'collection.created',
    );
    expect(library.audit.forEntity('tag', tag.id).map((row) => row.action)).toContain('tag.created');
    expect(library.audit.forEntity('note', note.id).map((row) => row.action)).toContain(
      'note.created',
    );

    // Every row is attributed, and the log itself cannot be edited (AL1).
    for (const row of library.audit.forEntity('item', item.id)) {
      expect(row.actorType).toBe('user');
      expect(row.actorUserId).toBe(library.user.id);
    }
    expect(() =>
      library.connection.prepare("update audit_log set action = 'tampered'").run(),
    ).toThrow(/append-only/iu);
  });
});

describe('documents and attachments in the bin (AT2, D4, TR3)', () => {
  it('detaches a file without touching the document, and re-attaches it', async () => {
    const { item, attachmentId } = await furnishedItem();
    const documentId = library.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId))
      .get()?.documentId as string;

    library.documents.detachDocument(attachmentId, library.actor);

    const detached = library.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId))
      .get();
    expect(detached?.trashedAt).not.toBeNull();
    // The bytes are untouched: a document is content, and another item may still reach it.
    expect(library.documents.getDocument(documentId).trashedAt).toBeNull();
    await expect(library.documents.readBuffer(documentId)).resolves.toBeInstanceOf(Buffer);

    library.trash.restore('attachment', attachmentId, library.actor);
    expect(
      library.db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, attachmentId))
        .get()?.trashedAt,
    ).toBeNull();
    void item;
  });

  it('refuses to trash a document while a live attachment references it (D4, TR3)', async () => {
    const { attachmentId } = await furnishedItem();
    const documentId = library.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId))
      .get()?.documentId as string;

    expect(() => library.documents.trashDocument(documentId, library.actor)).toThrow(InvariantError);
    expect(() => library.documents.trashDocument(documentId, library.actor)).toThrow(/D4/u);

    library.documents.detachDocument(attachmentId, library.actor);
    const trashed = library.documents.trashDocument(documentId, library.actor);
    expect(trashed.trashedAt).not.toBeNull();
    expect(library.trash.find('document', documentId)).toBeDefined();

    library.trash.restore('document', documentId, library.actor);
    expect(library.documents.getDocument(documentId).trashedAt).toBeNull();
    expect(library.trash.find('document', documentId)).toBeUndefined();
  });

  /*
   * M3. D4 was enforced in one direction only: `trashDocument` refused while a live attachment
   * existed, and nothing refused a live attachment being created over a document already in the
   * bin. The forbidden state is the same state whichever end arrives second, so each of the three
   * ways of reaching it gets a case.
   */
  it('refuses to attach a trashed document to an item (D4, the other direction)', async () => {
    const { attachmentId } = await furnishedItem();
    const documentId = library.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId))
      .get()?.documentId as string;

    library.documents.detachDocument(attachmentId, library.actor);
    library.documents.trashDocument(documentId, library.actor);

    const other = library.library.createItem({ itemType: 'article' }, library.actor).item;
    expect(() =>
      library.documents.attachDocument({ itemId: other.id, documentId }, library.actor),
    ).toThrow(InvariantError);
    expect(() =>
      library.documents.attachDocument({ itemId: other.id, documentId }, library.actor),
    ).toThrow(/D4/u);

    // Nothing was written on the way to the refusal.
    expect(
      library.db
        .select()
        .from(schema.attachments)
        .where(and(eq(schema.attachments.itemId, other.id), isNull(schema.attachments.trashedAt)))
        .all(),
    ).toEqual([]);

    // And it is allowed again once the document is out of the bin.
    library.trash.restore('document', documentId, library.actor);
    expect(library.documents.attachDocument({ itemId: other.id, documentId }, library.actor)).toBeTypeOf(
      'string',
    );
  });

  it('refuses a re-ingest of bytes whose document is in the trash (D4)', async () => {
    const bytes = Buffer.from('%PDF-1.7\nre-ingested\n');
    const first = await library.documents.ingestBuffer(bytes, { sourceKind: 'upload' });
    library.documents.trashDocument(first.document.id, library.actor);

    const item = library.library.createItem({ itemType: 'article' }, library.actor).item;
    await expect(
      library.documents.ingestBuffer(bytes, { sourceKind: 'upload', attachTo: { itemId: item.id } }),
    ).rejects.toThrow(/D4/u);

    expect(library.documents.getDocument(first.document.id).trashedAt).not.toBeNull();
    expect(
      library.db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.itemId, item.id))
        .all(),
    ).toEqual([]);
  });

  it('refuses to restore an attachment whose document was trashed meanwhile (D4)', async () => {
    const { attachmentId } = await furnishedItem();
    const documentId = library.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId))
      .get()?.documentId as string;

    // Legitimate at every step: the attachment goes first, so nothing live points at the document
    // when it follows. Restoring the attachment on its own is what would break D4.
    library.documents.detachDocument(attachmentId, library.actor);
    library.documents.trashDocument(documentId, library.actor);

    expect(() => library.documents.restoreAttachment(attachmentId, library.actor)).toThrow(
      InvariantError,
    );
    expect(() => library.documents.restoreAttachment(attachmentId, library.actor)).toThrow(/D4/u);

    library.trash.restore('document', documentId, library.actor);
    library.documents.restoreAttachment(attachmentId, library.actor);
    expect(
      library.db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, attachmentId))
        .get()?.trashedAt,
    ).toBeNull();
  });

  it('holds the invariant as a query: no live attachment points at a trashed document', async () => {
    const { attachmentId } = await furnishedItem();
    const documentId = library.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId))
      .get()?.documentId as string;

    library.documents.detachDocument(attachmentId, library.actor);
    library.documents.trashDocument(documentId, library.actor);
    const item = library.library.createItem({ itemType: 'article' }, library.actor).item;
    for (const attempt of [
      () => library.documents.attachDocument({ itemId: item.id, documentId }, library.actor),
      () => library.documents.restoreAttachment(attachmentId, library.actor),
    ]) {
      expect(attempt).toThrow(InvariantError);
    }

    // The state the invariant forbids, asked of the database rather than of the code that guards it.
    const violations = library.db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.attachments.documentId))
      .where(and(isNull(schema.attachments.trashedAt), isNotNull(schema.documents.trashedAt)))
      .all();
    expect(violations).toEqual([]);
  });
});
