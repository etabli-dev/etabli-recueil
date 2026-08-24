/**
 * The exit criterion, as a test.
 *
 * §7 Phase 1: "own library imported at 100% item count with attachment-hash coverage report". The
 * fixture library stands in for the real one, and `fixtures/expected-counts.json` — written by hand
 * from the library's design, before the generator ever ran — is the authority. Every number here is
 * read out of that file rather than restated, so a fixture that changes cannot quietly take the
 * assertions with it.
 */
import { readFileSync } from 'node:fs';

import { schema } from '@recueil/core';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { importZoteroLibrary } from '../src/import.js';
import type { ZoteroImportReport } from '../src/report/types.js';
import { ZOTERO_FIXTURE, fixtureImportOptions, makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

interface ExpectedCounts {
  zotero: {
    items: { allRows: number; regularRows: number; regularLive: number; regularTrashed: number };
    liveByType: Record<string, number>;
    allByType: Record<string, number>;
    notes: { total: number; child: number; standalone: number; trashed: number; onTrashedParent: number };
    attachments: {
      total: number;
      trashed: number;
      byLinkMode: Record<string, number>;
      filesPresent: number;
      filesMissing: number;
      standalone: number;
      missing: Array<{ slug: string; itemKey: string; linkMode: string; reason: string }>;
    };
    annotations: { total: number; byType: Record<string, number>; external: number };
    collections: { total: number; live: number; trashed: number; maxDepth: number; memberships: number };
    tags: { total: number; manual: number; automatic: number; assignments: number; coloured: number };
    creators: { total: number; singleField: number; assignments: number };
    relations: { total: number; byPredicate: Record<string, number>; dangling: number };
    citationKeys: {
      nativeField: number;
      extraLine: number;
      betterBibtexRows: number;
      betterBibtexPinned: number;
      betterBibtexStale: number;
      threeWayConflicts: number;
    };
    storage: {
      files: number;
      linkedFilesOnDisk: number;
      contents: Array<{ slug: string; itemKey: string; path: string; sha256: string; bytes: number }>;
    };
  };
}

const expected: ExpectedCounts = JSON.parse(readFileSync(ZOTERO_FIXTURE.expectedCounts, 'utf8')) as ExpectedCounts;

let library: TestLibrary;
let report: ZoteroImportReport;

beforeAll(async () => {
  library = makeLibrary();
  ({ report } = await importZoteroLibrary(library, fixtureImportOptions()));
}, 120_000);

afterAll(() => {
  library.dispose();
});

describe('the verdict', () => {
  it('passes', () => {
    const failed = report.checks.filter((check) => check.blocking && !check.pass);
    expect(failed.map((check) => `${check.name}: expected ${check.expected}, got ${check.actual}`)).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it('names every check it made', () => {
    expect(report.checks.map((check) => check.name)).toEqual([
      'item_count_parity',
      'item_count_parity_per_type',
      'item_type_fidelity',
      'source_libraries_covered',
      'trash_parity',
      'note_parity',
      'annotation_parity',
      'attachment_records_carried',
      'attachment_hash_coverage',
      'collection_parity',
      'tag_parity',
      'creator_parity',
      'source_unchanged',
    ]);
  });
});

describe('item counts', () => {
  it('matches the fixture’s stated totals exactly', () => {
    expect(report.items.zoteroRegularTotal).toBe(expected.zotero.items.regularRows);
    expect(report.items.recueilRegularTotal).toBe(expected.zotero.items.regularRows);
    expect(report.items.delta).toBe(0);
  });

  it('matches the stated live and trashed counts of every Zotero item type', () => {
    const live: Record<string, number> = {};
    const all: Record<string, number> = {};
    for (const row of report.items.byType) {
      expect(row.delta, row.zoteroType).toBe(0);
      live[row.zoteroType] = row.recueilLive;
      all[row.zoteroType] = row.recueilTotal;
    }
    expect(live).toEqual(expected.zotero.liveByType);
    expect(all).toEqual(expected.zotero.allByType);
  });

  it('counts the one derived host item apart from parity, and says why', () => {
    expect(report.items.derived).toBe(expected.zotero.attachments.standalone);
    expect(report.items.derivedReason).toMatch(/standalone/u);
  });

  it('has one Recueil item per Zotero key, keyed so a re-run matches (P9)', () => {
    const rows = library.db
      .select({ sourceId: schema.items.sourceId })
      .from(schema.items)
      .where(eq(schema.items.sourceSystem, 'zotero'))
      .all();
    expect(rows).toHaveLength(expected.zotero.items.regularRows + expected.zotero.attachments.standalone);
    expect(new Set(rows.map((row) => row.sourceId)).size).toBe(rows.length);
  });

  it('maps the Zotero item types onto the Recueil ones the mapping promises', () => {
    const mapping = Object.fromEntries(report.items.byType.map((row) => [row.zoteroType, row.recueilType]));
    expect(mapping).toEqual({
      book: 'book',
      bookSection: 'chapter',
      conferencePaper: 'conference_paper',
      dataset: 'dataset',
      journalArticle: 'article',
      preprint: 'preprint',
      report: 'report',
      thesis: 'thesis',
      webpage: 'webpage',
    });
  });
});

describe('attachments and hash coverage', () => {
  it('carries every attachment record, with Zotero’s own link-mode breakdown', () => {
    expect(report.attachments.total).toBe(expected.zotero.attachments.total);
    expect(report.attachments.byLinkMode).toEqual(expected.zotero.attachments.byLinkMode);
    expect(report.attachments.recueilAttachments).toBe(expected.zotero.attachments.total);
  });

  it('resolves and hashes exactly the files that are on disk', () => {
    expect(report.attachments.resolved).toBe(expected.zotero.attachments.filesPresent);
    expect(report.attachments.missing).toBe(expected.zotero.attachments.filesMissing);
    expect(report.attachments.unreadable).toBe(0);
    expect(report.attachments.claimingFile).toBe(
      expected.zotero.attachments.filesPresent + expected.zotero.attachments.filesMissing,
    );
    expect(report.attachments.hashCoveragePercent).toBeCloseTo(
      (expected.zotero.attachments.filesPresent /
        (expected.zotero.attachments.filesPresent + expected.zotero.attachments.filesMissing)) *
        100,
      1,
    );
  });

  it('computes the SHA-256 the fixture states for every file it found (ADR-0004)', () => {
    const byKey = new Map(report.attachments.entries.map((entry) => [entry.zoteroKey, entry]));
    for (const file of expected.zotero.storage.contents) {
      const entry = byKey.get(file.itemKey);
      expect(entry, file.itemKey).toBeDefined();
      expect(entry?.sha256, file.itemKey).toBe(file.sha256);
      expect(entry?.byteSize, file.itemKey).toBe(file.bytes);
      expect(entry?.matchesZoteroHash, file.itemKey).toBe(true);
    }
    expect(report.attachments.hashMismatches).toBe(0);
    expect(report.attachments.distinctDocuments).toBe(expected.zotero.storage.contents.length);
  });

  it('stores those bytes in the content-addressed store, once each', () => {
    const documents = library.db.select({ sha256: schema.documents.sha256 }).from(schema.documents).all();
    expect(documents).toHaveLength(expected.zotero.storage.contents.length);
    expect(new Set(documents.map((row) => row.sha256))).toEqual(
      new Set(expected.zotero.storage.contents.map((file) => file.sha256)),
    );
  });

  it('reports the deliberately missing files as missing, with a reason, and does not fail the run', () => {
    const missing = report.attachments.entries.filter((entry) => entry.status === 'missing');
    expect(missing.map((entry) => entry.zoteroKey).sort()).toEqual(
      expected.zotero.attachments.missing.map((entry) => entry.itemKey).sort(),
    );
    for (const entry of missing) {
      expect(entry.reason, entry.zoteroKey).toBeTruthy();
      expect(entry.sha256).toBeNull();
      // The record survives, pointing at where the file should be (P3).
      expect(entry.recueilLinkMode).toBe('linked_file');
    }
    expect(report.pass).toBe(true);
    expect(report.checks.find((check) => check.name === 'attachment_hash_coverage')).toMatchObject({
      pass: false,
      blocking: false,
    });
  });

  it('routes each missing file to the review queue with the reason', () => {
    const review = report.review.filter((entry) => entry.kind === 'attachment');
    expect(review.map((entry) => entry.zoteroKey).sort()).toEqual(
      expected.zotero.attachments.missing.map((entry) => entry.itemKey).sort(),
    );
    for (const entry of review) expect(entry.proposedAction).toBeTruthy();
  });

  it('resolves the linked file that is on disk, and stores it', () => {
    const linked = report.attachments.entries.find((entry) => entry.origin === 'linked');
    expect(linked?.status).toBe('resolved');
    expect(linked?.recueilLinkMode).toBe('stored');
    expect(linked?.sha256).toBe(
      expected.zotero.storage.contents.find((file) => file.path.startsWith('linked-attachments/'))?.sha256,
    );
  });

  it('gives each item at most one primary attachment', () => {
    const primaries = library.db
      .select({ itemId: schema.attachments.itemId })
      .from(schema.attachments)
      .where(and(eq(schema.attachments.role, 'primary'), isNull(schema.attachments.trashedAt)))
      .all();
    expect(new Set(primaries.map((row) => row.itemId)).size).toBe(primaries.length);
  });

  it('records snapshots as snapshots', () => {
    const snapshots = library.db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(eq(schema.attachments.role, 'snapshot'))
      .all();
    expect(snapshots).toHaveLength(expected.zotero.attachments.byLinkMode['imported_url'] ?? 0);
  });
});

describe('collections, tags and creators', () => {
  it('reconciles the collections and their memberships', () => {
    expect(report.collections.zoteroTotal).toBe(expected.zotero.collections.total);
    expect(report.collections.recueilTotal).toBe(expected.zotero.collections.total);
    expect(report.collections.recueilTrashed).toBe(expected.zotero.collections.trashed);
    expect(report.collections.maxDepth).toBe(expected.zotero.collections.maxDepth);
    expect(report.collections.zoteroMemberships).toBe(expected.zotero.collections.memberships);
    // Two memberships are a note filed in a collection, which Recueil has no row for.
    expect(report.collections.recueilMemberships + report.collections.membershipsSkipped).toBe(
      expected.zotero.collections.memberships,
    );
    expect(report.collections.membershipsSkipped).toBe(2);
  });

  it('rebuilds the hierarchy, not a flat list', () => {
    const depths = library.db
      .select({ name: schema.collections.name, depth: schema.collections.depth })
      .from(schema.collections)
      .all();
    expect(Math.max(...depths.map((row) => row.depth))).toBe(expected.zotero.collections.maxDepth - 1);
    expect(depths.find((row) => row.name === 'Instrumente')?.depth).toBe(2);
  });

  it('reconciles the tags, their schemes and their colours', () => {
    expect(report.tags.zoteroTotal).toBe(expected.zotero.tags.total);
    expect(report.tags.recueilTotal).toBe(expected.zotero.tags.total);
    expect(report.tags.manual).toBe(expected.zotero.tags.manual);
    expect(report.tags.automatic).toBe(expected.zotero.tags.automatic);
    expect(report.tags.coloured).toBe(expected.zotero.tags.coloured);
    expect(report.tags.zoteroAssignments).toBe(expected.zotero.tags.assignments);
    expect(
      report.tags.itemAssignments + report.tags.annotationAssignments + report.tags.assignmentsSkipped,
    ).toBe(expected.zotero.tags.assignments);
    expect(report.tags.annotationAssignments).toBe(2);
  });

  it('reconciles the creators and every appearance', () => {
    expect(report.creators.zoteroTotal).toBe(expected.zotero.creators.total);
    expect(report.creators.recueilTotal).toBe(expected.zotero.creators.total);
    expect(report.creators.singleField).toBe(expected.zotero.creators.singleField);
    expect(report.creators.zoteroAppearances).toBe(expected.zotero.creators.assignments);
    expect(report.creators.recueilAppearances).toBe(expected.zotero.creators.assignments);
  });

  it('keeps particle surnames, single-field names and non-ASCII intact', () => {
    const creators = library.db.select().from(schema.creators).all();
    const byDisplay = new Map(creators.map((row) => [row.displayName, row]));

    expect(byDisplay.get('Willem J. van der Berg')).toMatchObject({
      kind: 'person',
      familyName: 'van der Berg',
      givenName: 'Willem J.',
      namePrefix: null,
    });
    expect(byDisplay.get('Simone de Beauvoir')?.familyName).toBe('de Beauvoir');
    expect(byDisplay.get('Caoimhín Ó Súilleabháin')?.familyName).toBe('Ó Súilleabháin');
    expect(byDisplay.get('Екатерина Сергеевна Иванова')?.familyName).toBe('Иванова');
    expect(byDisplay.get('Márton Szűcs')?.familyName).toBe('Szűcs');

    const organisations = creators.filter((row) => row.kind === 'organisation');
    expect(organisations).toHaveLength(expected.zotero.creators.singleField);
    expect(byDisplay.get('Ελληνική Στατιστική Αρχή')).toMatchObject({
      kind: 'organisation',
      literalName: 'Ελληνική Στατιστική Αρχή',
      familyName: null,
      givenName: null,
    });
    expect(byDisplay.get('Институт водных проблем РАН')?.literalName).toBe('Институт водных проблем РАН');
  });

  it('keeps the author order Zotero recorded', () => {
    const item = library.db
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(eq(schema.items.sourceId, 'DDJ88U8G'))
      .get();
    const names = library.creators.forItem(item!.id).map((record) => record.creator.displayName);
    expect(names).toEqual(['Lorenzo Bianchi', 'Anna-Lena Müller']);
  });
});

describe('notes, annotations and relations', () => {
  it('carries every note, keeping the HTML verbatim and the Markdown beside it', () => {
    expect(report.notes.zoteroTotal).toBe(expected.zotero.notes.total);
    expect(report.notes.recueilTotal).toBe(expected.zotero.notes.total);
    expect(report.notes.recueilChild).toBe(expected.zotero.notes.child);
    expect(report.notes.recueilStandalone).toBe(expected.zotero.notes.standalone);

    const notes = library.db.select().from(schema.notes).all();
    for (const note of notes) {
      expect(note.sourceFormat).toBe('html');
      expect(note.contentOriginal).toMatch(/^<div data-schema-version/u);
      expect(note.contentMarkdown.trim()).not.toBe('');
    }
    const quote = notes.find((note) => note.title === 'Zitat S. 224');
    expect(quote?.contentMarkdown).toContain('> „Die Trendanalyse ist gegenüber der Wahl des Referenzzeitraums robust.“');
  });

  it('does not decode the HTML entities in a note’s text twice', () => {
    const note = library.db
      .select()
      .from(schema.notes)
      .all()
      .find((row) => row.title === 'HTML-Entities im Notentext');
    expect(note?.contentMarkdown).toContain('&amp;, &lt;, &gt;');
  });

  it('carries every annotation, with its type, colour and reading position', () => {
    expect(report.annotations.zoteroTotal).toBe(expected.zotero.annotations.total);
    expect(report.annotations.recueilTotal).toBe(expected.zotero.annotations.total);
    expect(report.annotations.byType).toEqual(expected.zotero.annotations.byType);
    expect(report.annotations.external).toBe(expected.zotero.annotations.external);
    expect(report.annotations.skipped).toBe(0);

    const annotations = library.db.select().from(schema.annotations).all();
    expect(annotations).toHaveLength(expected.zotero.annotations.total);
    expect(annotations.filter((row) => row.isExternal)).toHaveLength(expected.zotero.annotations.external);

    for (const annotation of annotations) {
      const selectors = JSON.parse(annotation.selector) as Array<{ type: string }>;
      // Invariant AN4: at least one selector resolves without the text layer.
      expect(
        selectors.some((selector) =>
          ['FragmentSelector', 'RectangleSelector', 'InkSelector'].includes(selector.type),
        ),
        annotation.externalRef ?? annotation.id,
      ).toBe(true);
      expect(annotation.positionSortKey).toMatch(/^\d{5}\|\d{6}\|\d{5}$/u);
      expect(annotation.externalRef).toMatch(/^zotero:/u);
    }

    // The counters `attachments` denormalises for the reader (AT4).
    const annotated = library.db
      .select({ count: schema.attachments.annotationCount, has: schema.attachments.hasAnnotations })
      .from(schema.attachments)
      .where(isNotNull(schema.attachments.documentId))
      .all()
      .filter((row) => row.count > 0);
    expect(annotated.map((row) => row.count).reduce((sum, count) => sum + count, 0)).toBe(
      expected.zotero.annotations.total,
    );
    expect(annotated.every((row) => row.has)).toBe(true);
  });

  it('carries every relation and separates the dangling ones', () => {
    expect(report.relations.zoteroTotal).toBe(expected.zotero.relations.total);
    expect(report.relations.byPredicate).toEqual(expected.zotero.relations.byPredicate);
    expect(report.relations.dangling).toBe(expected.zotero.relations.dangling);
    expect(report.relations.resolved).toBe(
      expected.zotero.relations.total - expected.zotero.relations.dangling,
    );

    const values = library.customFields.listFields();
    expect(values.map((field) => field.fieldKey)).toContain('zotero_relations');

    const carrier = library.db
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(eq(schema.items.sourceId, 'DDJ88U8G'))
      .get();
    const relations = library.customFields.getValue({ fieldKey: 'zotero_relations', itemId: carrier!.id });
    const payload = (relations?.content as unknown as { value: Array<{ targetItemId: string | null }> }).value;
    expect(payload).toHaveLength(2);
    expect(payload.every((entry) => entry.targetItemId !== null)).toBe(true);
  });
});

describe('citation keys', () => {
  it('imports every key the library carries, pinned (ADR-0016)', () => {
    const rows = library.db
      .select({
        citationKey: schema.itemBibliographic.citationKey,
        locked: schema.itemBibliographic.citationKeyLocked,
      })
      .from(schema.itemBibliographic)
      .all()
      .filter((row) => row.citationKey !== null);

    // Twenty-six Better BibTeX rows name items in this library; the two stale ones do not.
    expect(rows).toHaveLength(
      expected.zotero.citationKeys.betterBibtexRows - expected.zotero.citationKeys.betterBibtexStale,
    );
    expect(rows.every((row) => row.locked)).toBe(true);
    expect(report.citationKeys.itemsWithKey).toBe(rows.length);
    expect(report.citationKeys.pinned).toBe(rows.length);
    expect(report.citationKeys.betterBibtexRows).toBe(expected.zotero.citationKeys.betterBibtexRows);
    expect(report.citationKeys.betterBibtexStale).toBe(expected.zotero.citationKeys.betterBibtexStale);
  });

  it('protects a pinned key with the field lock, not only with the column (P4-2)', () => {
    const item = library.db
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(eq(schema.items.sourceId, '46ICLQ9I'))
      .get();
    expect(library.library.lockedBibliographicFields(item!.id)).toContain('citationKey');

    // An automated write is refused, which is the whole point of importing a key pinned.
    const result = library.library.writeBibliographic(
      item!.id,
      { citationKey: 'somethingelse2019' },
      library.actor,
      { provenance: { source: 'crossref', lock: false } },
    );
    expect(result.skipped.map((field) => field.fieldPath)).toContain('citationKey');
    expect(result.record.bibliographic?.citationKey).toBe('mueller2019niederschlagsvariabilitat');
  });

  it('prefers Zotero’s own field over Better BibTeX, and reports the disagreement', () => {
    const row = library.db
      .select({ citationKey: schema.itemBibliographic.citationKey })
      .from(schema.itemBibliographic)
      .innerJoin(schema.items, eq(schema.items.id, schema.itemBibliographic.itemId))
      .where(eq(schema.items.sourceId, 'NIQ4Z95I'))
      .get();
    expect(row?.citationKey).toBe('vasquez2020trace');
    expect(report.citationKeys.conflicts).toBe(expected.zotero.citationKeys.threeWayConflicts);
    expect(report.review.filter((entry) => entry.kind === 'citation_key')).toHaveLength(
      expected.zotero.citationKeys.threeWayConflicts,
    );
  });

  it('takes the Extra line when there is no native field', () => {
    const row = library.db
      .select({ citationKey: schema.itemBibliographic.citationKey })
      .from(schema.itemBibliographic)
      .innerJoin(schema.items, eq(schema.items.id, schema.itemBibliographic.itemId))
      .where(eq(schema.items.sourceId, 'LMWABG86'))
      .get();
    expect(row?.citationKey).toBe('schmidt2017soil');
    expect(report.citationKeys.bySource['extra_line']).toBe(1);
  });

  it('counts every source it drew from', () => {
    const total = Object.values(report.citationKeys.bySource).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(report.citationKeys.itemsWithKey);
    expect(report.citationKeys.bySource['zotero_native']).toBe(expected.zotero.citationKeys.nativeField);
  });
});

describe('the trash', () => {
  it('puts every item Zotero has in its trash into the Recueil trash', () => {
    expect(report.trash.zoteroDeletedItems).toBe(expected.zotero.items.regularTrashed);
    expect(report.trash.recueilTrashedItems).toBe(expected.zotero.items.regularTrashed);
    expect(report.trash.zoteroDeletedRows).toBe(
      expected.zotero.items.regularTrashed +
        expected.zotero.notes.trashed +
        expected.zotero.attachments.trashed,
    );
  });

  it('hides the children of a trashed parent the way Zotero does, and records the cascade', () => {
    // One note is in Zotero's trash in its own right; one more hangs off a trashed parent.
    expect(report.notes.recueilTrashed).toBe(
      expected.zotero.notes.trashed + expected.zotero.notes.onTrashedParent,
    );
    expect(report.trash.cascaded).toBeGreaterThan(0);
  });

  it('keeps a trash row open for every trashed entity (invariant T1)', () => {
    const trashed = library.db
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(isNotNull(schema.items.trashedAt))
      .all();
    for (const item of trashed) {
      expect(library.trash.find('item', item.id), item.id).toBeDefined();
    }
  });

  it('lets a trashed item keep a DOI a live item also claims', () => {
    const live = library.db
      .select({ doi: schema.itemBibliographic.doi })
      .from(schema.itemBibliographic)
      .innerJoin(schema.items, eq(schema.items.id, schema.itemBibliographic.itemId))
      .where(eq(schema.items.sourceId, 'PMDB7EQ9'))
      .get();
    const trashed = library.db
      .select({ doi: schema.itemBibliographic.doi })
      .from(schema.itemBibliographic)
      .innerJoin(schema.items, eq(schema.items.id, schema.itemBibliographic.itemId))
      .where(eq(schema.items.sourceId, 'BU3YFHJE'))
      .get();
    expect(live?.doi).toBe('10.1177/0165551520917000');
    expect(trashed?.doi).toBe('10.1177/0165551520917000');
  });
});

describe('fields', () => {
  it('preserves Extra verbatim', () => {
    const row = library.db
      .select({ extra: schema.items.extra })
      .from(schema.items)
      .where(eq(schema.items.sourceId, 'LMWABG86'))
      .get();
    expect(row?.extra).toBe('Citation Key: schmidt2017soil\nPMID: 28123456\ntex.keywords: soil moisture, memory');
  });

  it('reads an identifier out of Extra when the item has no field for it', () => {
    const row = library.db
      .select({ pmid: schema.itemBibliographic.pmid })
      .from(schema.itemBibliographic)
      .innerJoin(schema.items, eq(schema.items.id, schema.itemBibliographic.itemId))
      .where(eq(schema.items.sourceId, 'LMWABG86'))
      .get();
    expect(row?.pmid).toBe('28123456');
  });

  it('maps base fields onto the facet, including the ones Zotero renames per item type', () => {
    const thesis = library.db
      .select()
      .from(schema.itemBibliographic)
      .innerJoin(schema.items, eq(schema.items.id, schema.itemBibliographic.itemId))
      .where(eq(schema.items.sourceId, '39NHXFPI'))
      .get();
    expect(thesis?.item_bibliographic).toMatchObject({
      publisher: 'Universität Ulm',
      publisherPlace: 'Ulm',
      numberOfPages: 214,
      issuedYear: 2022,
      languageCode: 'de',
      cslType: 'thesis',
    });

    const article = library.db
      .select()
      .from(schema.itemBibliographic)
      .innerJoin(schema.items, eq(schema.items.id, schema.itemBibliographic.itemId))
      .where(eq(schema.items.sourceId, '46ICLQ9I'))
      .get();
    expect(article?.item_bibliographic).toMatchObject({
      containerTitle: 'Hydrologie und Wasserbewirtschaftung',
      containerShort: 'HyWa',
      volume: '63',
      issue: '4',
      pages: '218–233',
      pageFirst: 218,
      pageLast: 233,
      doi: '10.5675/hywa_2019.4_2',
      issn: '1439-1783',
      issuedDate: '2019-08',
      issuedYear: 2019,
      issuedMonth: 8,
      cslType: 'article-journal',
    });
  });

  it('marks preprints as preprints', () => {
    const preprints = library.db
      .select({ isPreprint: schema.itemBibliographic.isPreprint })
      .from(schema.itemBibliographic)
      .innerJoin(schema.items, eq(schema.items.id, schema.itemBibliographic.itemId))
      .where(eq(schema.items.itemType, 'preprint'))
      .all();
    expect(preprints).toHaveLength(expected.zotero.allByType['preprint'] ?? 0);
    expect(preprints.every((row) => row.isPreprint)).toBe(true);
  });

  it('carries a field with no facet column into a custom field, rather than dropping it', () => {
    const keys = library.customFields.listFields().map((field) => field.fieldKey);
    expect(keys).toContain('zotero_thesis_type');
    expect(keys).toContain('zotero_report_number');
    expect(keys).toContain('zotero_isbn');

    const thesis = library.db
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(eq(schema.items.sourceId, '39NHXFPI'))
      .get();
    const value = library.customFields.getValue({ fieldKey: 'zotero_thesis_type', itemId: thesis!.id });
    expect(value?.content).toEqual({ type: 'long_text', value: 'Dissertation' });

    // Every carried field is accounted for in the report, with the reason it was carried.
    expect(report.carriedFields.length).toBeGreaterThan(0);
    expect(report.carriedFields.every((field) => field.count > 0)).toBe(true);
    expect(report.carriedFields.map((field) => field.reason)).toContain('rejected');
  });

  it('preserves the Zotero timestamps rather than stamping the import time', () => {
    const row = library.db
      .select({ dateAdded: schema.items.dateAdded, dateModified: schema.items.dateModified })
      .from(schema.items)
      .where(eq(schema.items.sourceId, '46ICLQ9I'))
      .get();
    expect(row?.dateAdded.startsWith('2019-')).toBe(true);
    expect(row?.dateModified.endsWith('Z')).toBe(true);
    expect(row!.dateModified >= row!.dateAdded).toBe(true);
  });
});

describe('what did not fit', () => {
  it('lists every skipped record with its reason', () => {
    expect(report.skipped.length).toBeGreaterThan(0);
    for (const entry of report.skipped) {
      expect(entry.reason, entry.kind).toBeTruthy();
      expect(entry.kind).toBeTruthy();
    }
    // A tag on a Zotero note, and a note filed in a collection: neither has a Recueil row.
    expect(report.skipped.filter((entry) => entry.kind === 'note_tag')).toHaveLength(2);
    expect(report.skipped.filter((entry) => entry.kind === 'note_collection')).toHaveLength(2);
  });

  it('lists every review entry with a reason and a suggested action (P3)', () => {
    expect(report.review.length).toBeGreaterThan(0);
    for (const entry of report.review) {
      expect(entry.reason, entry.kind).toBeTruthy();
      expect(entry.proposedAction, entry.kind).toBeTruthy();
    }
    expect(report.review.filter((entry) => entry.kind === 'relation')).toHaveLength(
      expected.zotero.relations.dangling,
    );
  });
});
