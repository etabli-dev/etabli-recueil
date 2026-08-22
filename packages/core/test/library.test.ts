/**
 * The library service: the item lifecycle, and the rules `spec/data-model.md` attaches to it.
 *
 * The round trip under test is create → read → update → trash → restore, and at every step the
 * assertions are about the invariants rather than about the happy path: the title mirror (I3), the
 * audit row (P5), the trash record that must exist exactly when `trashed_at` does (T1), and the
 * refusal of a stale conditional write (§1.7, P1).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq, isNull } from 'drizzle-orm';

import { NotFoundError, VersionConflictError, schema } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

type TrashEntityType = (typeof schema.TRASH_ENTITY_TYPES)[number];

const openTrashRow = (entityType: TrashEntityType, entityId: string) =>
  library.db
    .select()
    .from(schema.trash)
    .where(
      and(
        eq(schema.trash.entityType, entityType),
        eq(schema.trash.entityId, entityId),
        isNull(schema.trash.restoredAt),
        isNull(schema.trash.purgedAt),
      ),
    )
    .get();

describe('LibraryService — create and read', () => {
  it('creates an item with its bibliographic facet and mirrors the title (I3)', () => {
    const created = library.library.createItem(
      {
        itemType: 'article',
        bibliographic: {
          title: 'Reporting guidelines for systematic reviews',
          containerTitle: 'BMJ',
          doi: 'https://doi.org/10.1136/BMJ.N71',
          issuedDate: '2021-03-29',
        },
      },
      library.actor,
    );

    expect(created.item.title).toBe('Reporting guidelines for systematic reviews');
    expect(created.item.version).toBe(1);
    expect(created.item.publicId).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/u);
    // B1: identifiers are normalised on write, so the deduplicator compares with `=`.
    expect(created.bibliographic?.doi).toBe('10.1136/bmj.n71');
    expect(created.bibliographic?.issuedYear).toBe(2021);

    const read = library.library.getItem(created.item.id);
    expect(read.item.title).toBe(created.item.title);
    expect(read.bibliographic?.containerTitle).toBe('BMJ');
    expect(read.office).toBeNull();
  });

  it('creates an office item, and both facets may sit on one item (I1)', () => {
    const created = library.library.createItem(
      {
        itemType: 'invoice',
        title: 'Scanner service, March',
        office: {
          correspondent: 'Brother Deutschland GmbH',
          documentDate: '2026-03-04',
          amountMinor: 12_900,
          amountCurrency: 'EUR',
          referenceNumber: 'RE-2026-0041',
        },
      },
      library.actor,
    );

    expect(created.office?.correspondentNormalised).toBe('brother deutschland gmbh');
    expect(created.office?.amountMinor).toBe(12_900);
    expect(created.bibliographic).toBeNull();
  });

  it('refuses an item type that is not a slug, open vocabulary or not (§3.4)', () => {
    expect(() => library.library.createItem({ itemType: 'Journal Article' }, library.actor)).toThrow(
      /not a slug/u,
    );
  });

  it('hides a trashed item from getItem unless it is asked for', () => {
    const created = library.library.createItem({ itemType: 'report' }, library.actor);
    library.library.trashItem(created.item.id, library.actor);

    expect(() => library.library.getItem(created.item.id)).toThrow(NotFoundError);
    expect(library.library.getItem(created.item.id, { includeTrashed: true }).item.trashedAt).not.toBeNull();
  });
});

describe('LibraryService — listing', () => {
  it('pages by cursor without repeating or skipping a row', () => {
    const created = Array.from({ length: 7 }, (_, index) =>
      library.library.createItem({ itemType: 'article', title: `Item ${index}` }, library.actor),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = library.library.listItems({ limit: 3, cursor });
      seen.push(...page.data.map((row) => row.id));
      cursor = page.page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== undefined);

    expect(seen).toHaveLength(created.length);
    expect(new Set(seen).size).toBe(created.length);
    expect([...seen].sort()).toEqual(created.map((record) => record.item.id).sort());
  });

  it('excludes trashed items by default and filters by type', () => {
    const article = library.library.createItem({ itemType: 'article' }, library.actor);
    library.library.createItem({ itemType: 'invoice' }, library.actor);
    const trashed = library.library.createItem({ itemType: 'article' }, library.actor);
    library.library.trashItem(trashed.item.id, library.actor);

    expect(library.library.listItems().data.map((row) => row.id)).not.toContain(trashed.item.id);
    expect(library.library.listItems({ itemType: 'article' }).data.map((row) => row.id)).toEqual([
      article.item.id,
    ]);
    expect(library.library.countItems()).toBe(2);
    expect(library.library.listItems({ includeTrashed: true }).data).toHaveLength(3);
  });

  it('rejects a malformed cursor rather than paging from the beginning', () => {
    expect(() => library.library.listItems({ cursor: 'not-a-cursor' })).toThrow(/Malformed cursor/u);
  });
});

describe('LibraryService — update', () => {
  it('bumps the version, moves date_modified and keeps the title mirror', () => {
    const created = library.library.createItem(
      { itemType: 'article', bibliographic: { title: 'Draft title' } },
      library.actor,
    );

    const updated = library.library.updateItem(
      created.item.id,
      { bibliographic: { title: 'Final title', volume: '12A' } },
      library.actor,
      { expectedVersion: created.item.version },
    );

    expect(updated.item.version).toBe(2);
    expect(updated.item.title).toBe('Final title');
    expect(updated.bibliographic?.title).toBe('Final title');
    expect(updated.bibliographic?.volume).toBe('12A');
    expect(updated.item.dateModified >= created.item.dateModified).toBe(true);

    expect(library.library.getItem(created.item.id).item.title).toBe('Final title');
  });

  it('adds a facet to an item that had none', () => {
    const created = library.library.createItem({ itemType: 'letter' }, library.actor);
    const updated = library.library.updateItem(
      created.item.id,
      { office: { correspondent: 'Finanzamt Ulm' } },
      library.actor,
    );

    expect(updated.office?.correspondent).toBe('Finanzamt Ulm');
    expect(updated.office?.correspondentNormalised).toBe('finanzamt ulm');
  });

  it('refuses a stale conditional write and logs the conflict rather than merging (P1)', () => {
    const created = library.library.createItem({ itemType: 'article' }, library.actor);
    library.library.updateItem(created.item.id, { title: 'Once' }, library.actor);

    expect(() =>
      library.library.updateItem(created.item.id, { title: 'Twice' }, library.actor, {
        expectedVersion: 1,
      }),
    ).toThrow(VersionConflictError);

    const actions = library.audit.forEntity('item', created.item.id).map((row) => row.action);
    expect(actions).toContain('item.conflict');
    // The refused write changed nothing.
    expect(library.library.getItem(created.item.id).item.title).toBe('Once');
  });
});

describe('LibraryService — trash and restore (P5)', () => {
  it('round-trips an item through the trash, keeping T1 true at both ends', () => {
    const created = library.library.createItem(
      { itemType: 'article', bibliographic: { title: 'Retracted?', doi: '10.1000/xyz' } },
      library.actor,
    );

    expect(openTrashRow('item', created.item.id)).toBeUndefined();

    const trashed = library.library.trashItem(created.item.id, library.actor, {
      reasonDetail: 'filed by mistake',
    });
    expect(trashed.item.trashedAt).not.toBeNull();
    // The facet mirrors the parent, which is what keeps the partial unique indexes correct (§1.1).
    expect(trashed.bibliographic?.itemTrashedAt).toBe(trashed.item.trashedAt);

    const record = openTrashRow('item', created.item.id);
    expect(record).toBeDefined();
    expect(record?.reason).toBe('user');
    expect(record?.reasonDetail).toBe('filed by mistake');
    expect(JSON.parse(record?.restorePayload ?? '{}')).toMatchObject({ collectionIds: [] });

    const restored = library.library.restoreItem(created.item.id, library.actor);
    expect(restored.item.trashedAt).toBeNull();
    expect(restored.bibliographic?.itemTrashedAt).toBeNull();
    expect(openTrashRow('item', created.item.id)).toBeUndefined();

    // The trash row is closed, not deleted: the history survives (TR4).
    const closed = library.db
      .select({ n: count() })
      .from(schema.trash)
      .where(eq(schema.trash.entityId, created.item.id))
      .get();
    expect(closed?.n).toBe(1);
  });

  it('cascades to attachments and notes, and puts back exactly what it took (I4)', async () => {
    const created = library.library.createItem({ itemType: 'article' }, library.actor);
    const ingest = await library.documents.ingestBuffer(Buffer.from('%PDF-1.7\nbody\n', 'utf8'), {
      sourceKind: 'upload',
      actor: library.actor,
      attachTo: { itemId: created.item.id },
    });

    const noteId = 'note-' + created.item.id;
    library.db
      .insert(schema.notes)
      .values({
        id: noteId,
        publicId: 'NOTE0001',
        itemId: created.item.id,
        ownerUserId: library.user.id,
        contentMarkdown: 'A thought.',
        createdAt: created.item.dateAdded,
        updatedAt: created.item.dateAdded,
      })
      .run();

    library.library.trashItem(created.item.id, library.actor);

    const attachment = library.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, ingest.attachmentId as string))
      .get();
    expect(attachment?.trashedAt).not.toBeNull();
    expect(openTrashRow('attachment', ingest.attachmentId as string)).toBeDefined();
    expect(openTrashRow('note', noteId)).toBeDefined();

    // The document itself is untouched: trashing an item never trashes a document (D4).
    expect(library.documents.getDocument(ingest.document.id).trashedAt).toBeNull();

    library.library.restoreItem(created.item.id, library.actor);

    expect(
      library.db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.id, ingest.attachmentId as string))
        .get()?.trashedAt,
    ).toBeNull();
    expect(openTrashRow('attachment', ingest.attachmentId as string)).toBeUndefined();
    expect(openTrashRow('note', noteId)).toBeUndefined();
  });

  it('trashing twice does not open a second trash record (P9)', () => {
    const created = library.library.createItem({ itemType: 'article' }, library.actor);
    library.library.trashItem(created.item.id, library.actor);
    library.library.trashItem(created.item.id, library.actor);

    const rows = library.db
      .select({ n: count() })
      .from(schema.trash)
      .where(eq(schema.trash.entityId, created.item.id))
      .get();
    expect(rows?.n).toBe(1);
  });
});

describe('LibraryService — audit trail (P5)', () => {
  it('writes one audit row per mutation, attributed to the actor', () => {
    const created = library.library.createItem({ itemType: 'article' }, library.actor);
    library.library.updateItem(created.item.id, { title: 'Named at last' }, library.actor);
    library.library.trashItem(created.item.id, library.actor);
    library.library.restoreItem(created.item.id, library.actor);

    const rows = library.audit.forEntity('item', created.item.id);
    expect(rows.map((row) => row.action).sort()).toEqual([
      'item.created',
      'item.restored',
      'item.trashed',
      'item.updated',
    ]);

    for (const row of rows) {
      expect(row.actorType).toBe('user');
      expect(row.actorUserId).toBe(library.user.id);
      expect(row.actorTokenId).toBeNull();
      expect(row.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    }

    const update = rows.find((row) => row.action === 'item.updated');
    expect(JSON.parse(update?.after ?? '{}')).toMatchObject({ title: 'Named at last', version: 2 });
    expect(JSON.parse(update?.before ?? '{}')).toMatchObject({ version: 1 });
  });

  it('records the bootstrap of the single local account', () => {
    const rows = library.audit.forEntity('user', library.user.id);
    expect(rows.map((row) => row.action)).toEqual(['user.created']);
    expect(rows[0]?.actorType).toBe('system');
  });
});
