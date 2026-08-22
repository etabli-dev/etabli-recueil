/**
 * P9: idempotent and resumable.
 *
 * Both properties are tested the same way — by comparing whole-library snapshots — because both
 * claims are about the *library*, not about the importer's return value. An importer that reported
 * "67 items" twice while writing 134 rows would pass a weaker test.
 */
import { schema } from '@recueil/core';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ImportCancelledError, importZoteroLibrary } from '../src/import.js';
import { findImportJob } from '../src/job.js';
import type { ImportStage } from '../src/job.js';
import { fixtureImportOptions, makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

/**
 * Everything the import wrote, in a form two libraries can be compared by.
 *
 * Surrogate ids and timestamps are excluded on purpose: they are minted per run and differ between
 * two libraries that are otherwise identical. Everything the *source* determines is included.
 */
const snapshot = (library: TestLibrary): Record<string, unknown> => ({
  items: library.db
    .select()
    .from(schema.items)
    .orderBy(asc(schema.items.sourceId))
    .all()
    .map((row) => [row.sourceId, row.itemType, row.title, row.extra, row.dateAdded, row.trashedAt !== null]),
  bibliographic: library.db
    .select()
    .from(schema.itemBibliographic)
    .innerJoin(schema.items, eq(schema.items.id, schema.itemBibliographic.itemId))
    .orderBy(asc(schema.items.sourceId))
    .all()
    .map(({ item_bibliographic: bib, items: item }) => [
      item.sourceId,
      bib.title,
      bib.doi,
      bib.citationKey,
      bib.citationKeyLocked,
      bib.issuedDate,
      bib.containerTitle,
      bib.publisher,
      bib.pages,
      bib.isbn,
      bib.issn,
      bib.arxivId,
      bib.pmid,
      bib.languageCode,
      bib.cslType,
    ]),
  documents: library.db
    .select({ sha256: schema.documents.sha256, size: schema.documents.byteSize, mime: schema.documents.mimeType })
    .from(schema.documents)
    .orderBy(asc(schema.documents.sha256))
    .all(),
  attachments: library.db
    .select()
    .from(schema.attachments)
    .innerJoin(schema.items, eq(schema.items.id, schema.attachments.itemId))
    .all()
    .map(({ attachments: attachment, items: item }) => [
      item.sourceId,
      attachment.role,
      attachment.linkMode,
      attachment.title,
      attachment.url,
      attachment.linkedPath,
      attachment.annotationCount,
      attachment.trashedAt !== null,
    ])
    .sort(compare),
  notes: library.db
    .select({
      itemId: schema.notes.itemId,
      title: schema.notes.title,
      original: schema.notes.contentOriginal,
      markdown: schema.notes.contentMarkdown,
      trashed: schema.notes.trashedAt,
    })
    .from(schema.notes)
    .all()
    .map((row) => [row.title, row.original, row.markdown, row.trashed !== null, row.itemId !== null])
    .sort(compare),
  annotations: library.db
    .select()
    .from(schema.annotations)
    .orderBy(asc(schema.annotations.externalRef))
    .all()
    .map((row) => [
      row.externalRef,
      row.annotationType,
      row.motivation,
      row.selector,
      row.quotedText,
      row.bodyText,
      row.colour,
      row.pageIndex,
      row.pageLabel,
      row.positionSortKey,
      row.isExternal,
      row.trashedAt !== null,
    ]),
  collections: library.db
    .select({
      name: schema.collections.name,
      depth: schema.collections.depth,
      trashed: schema.collections.trashedAt,
    })
    .from(schema.collections)
    .all()
    .map((row) => [row.name, row.depth, row.trashed !== null])
    .sort(compare),
  memberships: library.db
    .select({ collection: schema.collections.name, item: schema.items.sourceId })
    .from(schema.collectionItems)
    .innerJoin(schema.collections, eq(schema.collections.id, schema.collectionItems.collectionId))
    .innerJoin(schema.items, eq(schema.items.id, schema.collectionItems.itemId))
    .all()
    .map((row) => [row.collection, row.item])
    .sort(compare),
  tags: library.db
    .select({ name: schema.tags.name, scheme: schema.tags.scheme, colour: schema.tags.colour })
    .from(schema.tags)
    .all()
    .map((row) => [row.name, row.scheme, row.colour])
    .sort(compare),
  itemTags: library.db
    .select({ item: schema.items.sourceId, tag: schema.tags.name })
    .from(schema.itemTags)
    .innerJoin(schema.items, eq(schema.items.id, schema.itemTags.itemId))
    .innerJoin(schema.tags, eq(schema.tags.id, schema.itemTags.tagId))
    .all()
    .map((row) => [row.item, row.tag])
    .sort(compare),
  annotationTags: library.db
    .select({ annotation: schema.annotations.externalRef, tag: schema.tags.name })
    .from(schema.annotationTags)
    .innerJoin(schema.annotations, eq(schema.annotations.id, schema.annotationTags.annotationId))
    .innerJoin(schema.tags, eq(schema.tags.id, schema.annotationTags.tagId))
    .all()
    .map((row) => [row.annotation, row.tag])
    .sort(compare),
  creators: library.db
    .select()
    .from(schema.creators)
    .orderBy(asc(schema.creators.sortName))
    .all()
    .map((row) => [row.kind, row.familyName, row.givenName, row.literalName, row.displayName]),
  appearances: library.db
    .select({
      item: schema.items.sourceId,
      ordinal: schema.itemCreators.ordinal,
      role: schema.itemCreators.role,
      raw: schema.itemCreators.rawName,
    })
    .from(schema.itemCreators)
    .innerJoin(schema.items, eq(schema.items.id, schema.itemCreators.itemId))
    .all()
    .map((row) => [row.item, row.ordinal, row.role, row.raw])
    .sort(compare),
  fieldValues: (() => {
    // `zotero_relations` resolves its targets to Recueil ids, which are minted per run. Swapping
    // each one back for the Zotero key it stands for keeps the comparison about the resolution
    // rather than about which ULIDs a particular run happened to generate.
    const keyById = new Map(
      library.db
        .select({ id: schema.items.id, sourceId: schema.items.sourceId })
        .from(schema.items)
        .all()
        .map((row) => [row.id, row.sourceId ?? row.id]),
    );
    const substitute = (json: string | null): string | null =>
      json === null ? null : json.replace(/[0-9A-HJKMNP-TV-Z]{26}/gu, (id) => keyById.get(id) ?? id);

    return library.db
      .select({
        key: schema.customFields.fieldKey,
        item: schema.items.sourceId,
        text: schema.fieldValues.valueText,
        json: schema.fieldValues.valueJson,
      })
      .from(schema.fieldValues)
      .innerJoin(schema.customFields, eq(schema.customFields.id, schema.fieldValues.fieldId))
      .innerJoin(schema.items, eq(schema.items.id, schema.fieldValues.itemId))
      .all()
      .map((row) => [row.key, row.item, row.text, substitute(row.json)])
      .sort(compare);
  })(),
  documentProvenance: library.db
    .select({ sha256: schema.documentProvenance.sha256, ref: schema.documentProvenance.sourceRef })
    .from(schema.documentProvenance)
    .all()
    .map((row) => [row.sha256, row.ref])
    .sort(compare),
  openTrash: library.db
    .select({ entityType: schema.trash.entityType, reason: schema.trash.reason })
    .from(schema.trash)
    .all()
    .map((row) => [row.entityType, row.reason])
    .sort(compare),
});

const compare = (left: unknown[], right: unknown[]): number =>
  JSON.stringify(left) < JSON.stringify(right) ? -1 : 1;

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

describe('running the same import twice', () => {
  it('produces the same library, not a doubled one', async () => {
    const first = await importZoteroLibrary(library, fixtureImportOptions());
    const after = snapshot(library);

    const second = await importZoteroLibrary(library, fixtureImportOptions());
    expect(snapshot(library)).toEqual(after);

    expect(second.report.items.recueilRegularTotal).toBe(first.report.items.recueilRegularTotal);
    expect(second.report.items.delta).toBe(0);
    expect(second.report.attachments.recueilAttachments).toBe(first.report.attachments.recueilAttachments);
    expect(second.report.notes.recueilTotal).toBe(first.report.notes.recueilTotal);
    expect(second.report.annotations.recueilTotal).toBe(first.report.annotations.recueilTotal);
    expect(second.report.creators.recueilAppearances).toBe(first.report.creators.recueilAppearances);
    expect(second.report.pass).toBe(true);
  }, 180_000);

  it('reuses the one job row, so the run is the same run (IK1)', async () => {
    const first = await importZoteroLibrary(library, fixtureImportOptions());
    const second = await importZoteroLibrary(library, fixtureImportOptions());

    expect(second.jobId).toBe(first.jobId);
    expect(second.report.run.idempotencyKey).toBe(first.report.run.idempotencyKey);
    expect(second.report.run.idempotencyKey).toMatch(/^import\.zotero:[0-9a-f]{32}:default$/u);
    expect(second.report.run.attempt).toBe(first.report.run.attempt + 1);

    const jobs = library.db
      .select({ id: schema.jobs.id, state: schema.jobs.state })
      .from(schema.jobs)
      .where(eq(schema.jobs.jobType, 'import.zotero'))
      .all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe('succeeded');
  }, 180_000);

  it('treats a different run label as a different run (IK3)', async () => {
    await importZoteroLibrary(library, fixtureImportOptions());
    const other = await importZoteroLibrary(library, fixtureImportOptions({ runLabel: 'again' }));

    expect(other.report.run.idempotencyKey.endsWith(':again')).toBe(true);
    expect(
      library.db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.jobType, 'import.zotero')).all(),
    ).toHaveLength(2);
    // A second run label is still the same library: nothing is duplicated.
    expect(other.report.items.recueilRegularTotal).toBe(other.report.items.zoteroRegularTotal);
  }, 180_000);
});

describe('an interrupted import', () => {
  it('resumes to exactly the library an uninterrupted one produces', async () => {
    const reference = makeLibrary();
    try {
      const clean = await importZoteroLibrary(reference, fixtureImportOptions());
      const expectedSnapshot = snapshot(reference);

      const stops: ImportStage[] = ['items', 'attachments', 'notes', 'trash'];
      for (const stage of stops) {
        await expect(
          importZoteroLibrary(
            library,
            fixtureImportOptions({
              // The trash stage is a single record, so the cut-off has to be per-stage rather
              // than a fixed index, or the run would sail past it and finish.
              abortAfter: (progress: { stage: ImportStage; index: number; total: number }) =>
                progress.stage === stage && progress.index >= Math.min(3, progress.total),
            }),
          ),
        ).rejects.toBeInstanceOf(ImportCancelledError);
      }

      const resumed = await importZoteroLibrary(library, fixtureImportOptions());
      expect(snapshot(library)).toEqual(expectedSnapshot);
      expect(resumed.report.pass).toBe(true);
      expect(resumed.report.items.delta).toBe(0);
      expect(resumed.report.run.resumedFromStage).not.toBeNull();

      // The report of an interrupted-and-resumed run says what the clean one says.
      expect(resumed.report.attachments.resolved).toBe(clean.report.attachments.resolved);
      expect(resumed.report.attachments.missing).toBe(clean.report.attachments.missing);
      expect(resumed.report.attachments.distinctDocuments).toBe(clean.report.attachments.distinctDocuments);
      expect(resumed.report.review.length).toBe(clean.report.review.length);
      expect(resumed.report.skipped.length).toBe(clean.report.skipped.length);
      expect(resumed.report.citationKeys).toEqual(clean.report.citationKeys);
    } finally {
      reference.dispose();
    }
  }, 300_000);

  it('leaves the cursor on the job, so the next run knows where to pick up (IK4)', async () => {
    await expect(
      importZoteroLibrary(
        library,
        fixtureImportOptions({
          abortAfter: (progress: { stage: ImportStage; index: number }) =>
            progress.stage === 'items' && progress.index === 10,
        }),
      ),
    ).rejects.toThrow(ImportCancelledError);

    const key = library.db
      .select({ key: schema.jobs.idempotencyKey })
      .from(schema.jobs)
      .where(eq(schema.jobs.jobType, 'import.zotero'))
      .get()?.key;
    const job = findImportJob(library, key!);

    expect(job?.state).toBe('cancelled');
    expect(JSON.parse(job!.cursor!)).toEqual({ stage: 'items', index: 10 });
    expect(job?.progressDone).toBeGreaterThan(0);
  }, 120_000);

  it('writes nothing beyond the point it stopped', async () => {
    await expect(
      importZoteroLibrary(
        library,
        fixtureImportOptions({
          abortAfter: (progress: { stage: ImportStage }) => progress.stage === 'tags',
        }),
      ),
    ).rejects.toThrow(ImportCancelledError);

    // Collections came before tags and are complete; items came after and were never reached.
    expect(library.db.select({ id: schema.collections.id }).from(schema.collections).all().length).toBe(9);
    expect(library.db.select({ id: schema.items.id }).from(schema.items).all()).toHaveLength(0);
    expect(library.db.select({ id: schema.documents.id }).from(schema.documents).all()).toHaveLength(0);
  }, 120_000);
});
