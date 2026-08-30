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

import { ConflictError, NotFoundError, TEXT_FILTER_CANDIDATES, VersionConflictError, schema } from '../src/index.js';
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

describe('LibraryService — filtering (Phase 1)', () => {
  const seed = () => {
    const sepsis = library.library.createItem(
      { itemType: 'article', bibliographic: { title: 'Early antibiotics in sepsis' } },
      library.actor,
    ).item;
    const fluids = library.library.createItem(
      { itemType: 'article', bibliographic: { title: 'Fluid resuscitation revisited' } },
      library.actor,
    ).item;
    const invoice = library.library.createItem(
      { itemType: 'invoice', office: { correspondent: 'Stadtwerke Ulm' } },
      library.actor,
    ).item;

    const reading = library.collections.create({ name: 'To read' }, library.actor);
    library.collections.addItems(reading.id, [sepsis.id, invoice.id], library.actor);
    const tag = library.tags.assignByName(sepsis.id, 'critical care', library.actor);

    return { sepsis, fluids, invoice, reading, tag };
  };

  it('filters by collection, by tag and by item type', () => {
    const { sepsis, invoice, reading, tag } = seed();

    expect(
      library.library.listItems({ collectionId: reading.id }).data.map((row) => row.id).sort(),
    ).toEqual([sepsis.id, invoice.id].sort());
    expect(library.library.listItems({ tagId: tag.id }).data.map((row) => row.id)).toEqual([
      sepsis.id,
    ]);
    expect(library.library.listItems({ itemType: 'invoice' }).data.map((row) => row.id)).toEqual([
      invoice.id,
    ]);
  });

  it('composes filters, and counts what it lists', () => {
    const { sepsis, reading, tag } = seed();

    const options = { collectionId: reading.id, tagId: tag.id, itemType: 'article' };
    expect(library.library.listItems(options).data.map((row) => row.id)).toEqual([sepsis.id]);
    expect(library.library.countItems(options)).toBe(1);

    // A combination nothing satisfies returns an empty page rather than a broken query.
    const empty = { collectionId: reading.id, tagId: tag.id, itemType: 'invoice' };
    expect(library.library.listItems(empty).data).toEqual([]);
    expect(library.library.countItems(empty)).toBe(0);
  });

  it('filters by text through the full-text index, and pages the result', () => {
    const { sepsis } = seed();

    expect(library.library.listItems({ text: 'sepsis' }).data.map((row) => row.id)).toEqual([
      sepsis.id,
    ]);
    expect(library.library.countItems({ text: 'sepsis' })).toBe(1);
    // A query matching nothing short-circuits to an empty page.
    expect(library.library.listItems({ text: 'zzzznothing' }).data).toEqual([]);
    expect(library.library.countItems({ text: 'zzzznothing' })).toBe(0);

    // A text filter composes with the others, and the order stays (date_modified, id) so the
    // cursor keeps working.
    const paged = library.library.listItems({ text: 'resuscitation OR sepsis', limit: 1 });
    expect(paged.data).toHaveLength(1);
    expect(paged.page.hasMore).toBe(true);
    const next = library.library.listItems({
      text: 'resuscitation OR sepsis',
      limit: 1,
      cursor: paged.page.nextCursor as string,
    });
    expect(next.data).toHaveLength(1);
    expect(next.data[0]?.id).not.toBe(paged.data[0]?.id);
  });

  it('falls back to a title LIKE when the library has no index', () => {
    const withoutIndex = makeLibrary({ indexOnWrite: false });
    try {
      withoutIndex.library.createItem(
        { itemType: 'article', bibliographic: { title: 'Early antibiotics in sepsis' } },
        withoutIndex.actor,
      );
      withoutIndex.library.createItem(
        { itemType: 'article', bibliographic: { title: 'Fluid resuscitation' } },
        withoutIndex.actor,
      );

      // The fallback is a substring match over the title only, and is deliberately narrower.
      expect(withoutIndex.library.listItems({ text: 'SEPSIS' }).data).toHaveLength(1);
      expect(withoutIndex.library.listItems({ text: 'antibiotics in' }).data).toHaveLength(1);
      expect(withoutIndex.library.listItems({ text: 'nothing here' }).data).toHaveLength(0);
    } finally {
      withoutIndex.dispose();
    }
  });
});

/** m9: a caller could not tell "these are all the matches" from "these are the best 500". */
describe('LibraryService — a truncated text filter says so', () => {
  it('flags the page when the candidate ceiling was reached, and not when it was not', () => {
    // One item is enough to prove the flag is absent; the ceiling needs more than 500 matches, so
    // the truncating case is built from the constant rather than from a hard-coded 501.
    for (let index = 0; index < TEXT_FILTER_CANDIDATES + 5; index += 1) {
      library.library.createItem(
        { itemType: 'article', bibliographic: { title: `Sepsis cohort ${index}` } },
        library.actor,
      );
    }

    const broad = library.library.listItems({ text: 'sepsis', limit: 10 });
    expect(broad.data).toHaveLength(10);
    expect(broad.page.textFilterTruncated).toBe(true);

    // A query that matches a handful is not truncated, and neither is one with no text filter.
    library.library.createItem(
      { itemType: 'article', bibliographic: { title: 'Hyperlactataemia and outcome' } },
      library.actor,
    );
    expect(library.library.listItems({ text: 'hyperlactataemia' }).page.textFilterTruncated).toBeUndefined();
    expect(library.library.listItems({}).page.textFilterTruncated).toBeUndefined();
  });
});

/**
 * The archive serial number is unique among live items (`ux_item_office_asn`, CONCEPT §6).
 *
 * The index enforces it correctly and always did — the adversarial review could not defeat it. What
 * it found is that the refusal arrived as a raw `SqliteError: UNIQUE constraint failed:
 * item_office.asn`, which a caller cannot tell from an internal fault and which does not name the
 * item holding the number. The review named `restoreItem`; the same driver error came out of two
 * further paths nobody had named, because all three write the same column.
 */
describe('LibraryService — an ASN collision is a conflict, not a driver error', () => {
  const withAsn = (asn: number) =>
    library.library.createItem(
      { itemType: 'document', office: { correspondent: 'Stadtwerke', asn } },
      library.actor,
    ).item;

  const expectNamedConflict = (act: () => unknown, asn: number, holder: string): void => {
    let thrown: unknown;
    try {
      act();
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'nothing was thrown').toBeInstanceOf(ConflictError);
    expect((thrown as Error).message).toContain(String(asn));
    expect((thrown as Error).message).toContain(holder);
    expect((thrown as Error).constructor.name).toBe('ConflictError');
  };

  it('refuses a restore that would bring a taken number back into the live index', () => {
    const first = withAsn(5);
    library.library.trashItem(first.id, library.actor);
    const second = withAsn(5);

    expectNamedConflict(() => library.library.restoreItem(first.id, library.actor), 5, second.id);

    // And the index is still intact: exactly one live item holds the number.
    const live = library.db
      .select({ value: count() })
      .from(schema.itemOffice)
      .where(and(eq(schema.itemOffice.asn, 5), isNull(schema.itemOffice.itemTrashedAt)))
      .get();
    expect(live?.value).toBe(1);
  });

  it('refuses a second live item created with the same number', () => {
    const holder = withAsn(7);
    expectNamedConflict(() => withAsn(7), 7, holder.id);
  });

  it('refuses an update that moves an item onto a taken number', () => {
    const holder = withAsn(9);
    const other = library.library.createItem(
      { itemType: 'document', office: { correspondent: 'Finanzamt' } },
      library.actor,
    ).item;

    expectNamedConflict(
      () => library.library.updateItem(other.id, { office: { correspondent: 'Finanzamt', asn: 9 } }, library.actor),
      9,
      holder.id,
    );
  });

  it('lets an item keep its own number, and take one a trashed item has given up', () => {
    const item = withAsn(11);
    expect(() =>
      library.library.updateItem(item.id, { office: { correspondent: 'Stadtwerke AG', asn: 11 } }, library.actor),
    ).not.toThrow();

    library.library.trashItem(item.id, library.actor);
    expect(() => withAsn(11)).not.toThrow();
  });
});
