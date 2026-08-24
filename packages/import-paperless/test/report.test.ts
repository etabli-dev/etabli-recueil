/**
 * Proving the checks can fail.
 *
 * The Phase 1 review found three blocking checks in the Zotero importer that were structurally
 * incapable of failing: one counted the importer's own log, one bucketed both sides through the
 * same mapping function, and one compared the run's own filter against itself. Every one of them
 * read as evidence and was worth nothing.
 *
 * So this file does not check that a good import passes — `import.test.ts` does that. It **damages
 * the target library** and checks that the report notices: rewrite every `item_type`, delete an
 * item, orphan an attachment, take a blob out from under one. If any of these were to still say
 * PASS, the check that covers it would be decoration.
 *
 * The report is rebuilt with `buildReport` against the damaged library, using the snapshot and plan
 * the run returned — that is, exactly the code path a real run uses, with only the *target* changed.
 */
import { schema } from '@recueil/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importPaperless } from '../src/import.js';
import type { PaperlessImportResult } from '../src/import.js';
import { buildReport, readImportLog } from '../src/report/build.js';
import { renderReportMarkdown } from '../src/report/markdown.js';
import type { PaperlessImportReport } from '../src/report/types.js';
import { fixtureImportOptions, makeLibrary, startFixtureServer } from './helpers.js';
import type { TestLibrary, TestServer } from './helpers.js';

let recueil: TestLibrary;
let server: TestServer;
let run: PaperlessImportResult;

/** Rebuild the report against whatever state the library is in now. */
const reverify = (): PaperlessImportReport =>
  buildReport({
    recueil,
    snapshot: run.snapshot,
    plan: run.plan,
    log: readImportLog(recueil, run.jobId),
    baseUrl: `${server.baseUrl}/api/`,
    downloadOriginals: true,
    run: run.report.run,
  });

const check = (report: PaperlessImportReport, name: string) =>
  report.checks.find((row) => row.name === name);

beforeEach(async () => {
  recueil = makeLibrary();
  server = await startFixtureServer();
  run = await importPaperless(recueil, fixtureImportOptions(server) as never);
  expect(run.report.pass).toBe(true);
});

afterEach(async () => {
  await server.close();
  recueil.dispose();
});

describe('the parity checks are real comparisons', () => {
  it('fails when every stored item_type is rewritten', () => {
    recueil.db.update(schema.items).set({ itemType: 'article' }).run();

    const report = reverify();
    expect(check(report, 'item_type_fidelity')?.pass).toBe(false);
    expect(report.documents.recueilMistyped).toBe(10);
    expect(check(report, 'document_count_parity')?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('fails when one item is missing', () => {
    const item = recueil.db.select().from(schema.items).where(eq(schema.items.sourceId, '3')).get();
    recueil.db.delete(schema.attachments).where(eq(schema.attachments.itemId, item?.id as string)).run();
    recueil.db.delete(schema.itemTags).where(eq(schema.itemTags.itemId, item?.id as string)).run();
    recueil.db.delete(schema.itemOffice).where(eq(schema.itemOffice.itemId, item?.id as string)).run();
    recueil.db.delete(schema.items).where(eq(schema.items.id, item?.id as string)).run();

    const report = reverify();
    expect(report.documents.missingInRecueil).toStrictEqual([3]);
    expect(report.documents.delta).toBe(-1);
    expect(check(report, 'document_count_parity')?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('fails when a blob is in the store but reachable from no item', () => {
    const item = recueil.db.select().from(schema.items).where(eq(schema.items.sourceId, '2')).get();
    recueil.db.delete(schema.attachments).where(eq(schema.attachments.itemId, item?.id as string)).run();

    const report = reverify();
    expect(report.originals.recueilAttachmentsMissing).toStrictEqual([2]);
    expect(check(report, 'attachment_records_carried')?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('fails when a document that should have an original has none', () => {
    // The provenance row is what says "we stored this document's original"; removing it and the
    // attachment leaves an item that quietly has no file, which is the loss the check is for.
    const item = recueil.db.select().from(schema.items).where(eq(schema.items.sourceId, '2')).get();
    const attachment = recueil.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.itemId, item?.id as string))
      .get();
    recueil.db
      .delete(schema.documentProvenance)
      .where(eq(schema.documentProvenance.sourceRef, 'paperless:document:2'))
      .run();
    recueil.db.delete(schema.attachments).where(eq(schema.attachments.id, attachment?.id as string)).run();

    const report = reverify();
    expect(report.originals.recueilWithoutOriginal).toContain(2);
    expect(check(report, 'originals_accounted_for')?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('fails when a tag is removed from the library', () => {
    const tag = recueil.tags.findByName('Energie');
    recueil.db.delete(schema.itemTags).where(eq(schema.itemTags.tagId, tag?.id as string)).run();
    recueil.db.delete(schema.tags).where(eq(schema.tags.id, tag?.id as string)).run();

    const report = reverify();
    expect(report.tags.missingInRecueil).toStrictEqual(['Energie']);
    expect(check(report, 'tags_carried')?.pass).toBe(false);
    expect(check(report, 'tag_assignments_carried')?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('fails when a custom-field definition is removed', () => {
    const field = recueil.db
      .select()
      .from(schema.customFields)
      .where(eq(schema.customFields.fieldKey, 'rechnungsnummer'))
      .get();
    recueil.db.delete(schema.fieldValues).where(eq(schema.fieldValues.fieldId, field?.id as string)).run();
    recueil.db.delete(schema.customFields).where(eq(schema.customFields.id, field?.id as string)).run();

    const report = reverify();
    expect(check(report, 'custom_fields_defined')?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('fails when a value is deleted from a field that should hold one', () => {
    const field = recueil.db
      .select()
      .from(schema.customFields)
      .where(eq(schema.customFields.fieldKey, 'betrag'))
      .get();
    recueil.db.delete(schema.fieldValues).where(eq(schema.fieldValues.fieldId, field?.id as string)).run();

    const report = reverify();
    expect(check(report, 'custom_field_values_carried')?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('fails when a note is deleted', () => {
    const note = recueil.db.select().from(schema.notes).get();
    recueil.db.delete(schema.notes).where(eq(schema.notes.id, note?.id as string)).run();

    const report = reverify();
    expect(check(report, 'notes_carried')?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('fails when two live items share an ASN because the trashed mirror drifted', () => {
    // `ux_item_office_asn` is partial on `item_office.item_trashed_at`, which is an
    // application-maintained mirror of `items.trashed_at` (§1.1). A mirror that has drifted — a
    // restore that half-finished, a hand-edited row — switches the index off for that row while
    // the item is still live, which is the one way two live items can come to share an ASN. Doing
    // it here proves the check reads `items`, not the mirror the index reads.
    recueil.connection.exec(
      "update item_office set item_trashed_at = '2020-01-01T00:00:00.000Z' where asn = 1002",
    );
    recueil.connection.exec('update item_office set asn = 1001 where asn = 1002');

    // The library really is in the forbidden state: two live items, one ASN.
    const live = recueil.connection
      .prepare(
        'select o.asn as asn from item_office o join items i on i.id = o.item_id ' +
          'where o.asn = 1001 and i.trashed_at is null',
      )
      .all() as unknown[];
    expect(live).toHaveLength(2);

    const report = reverify();
    expect(report.asn.unique).toBe(false);
    expect(check(report, 'asn_unique')?.pass).toBe(false);
    expect(report.pass).toBe(false);
  });

  it('fails when the whole target is emptied', () => {
    recueil.db.delete(schema.itemTags).run();
    recueil.db.delete(schema.fieldValues).run();
    recueil.db.delete(schema.notes).run();
    recueil.db.delete(schema.attachments).run();
    recueil.db.delete(schema.itemOffice).run();
    recueil.db.delete(schema.items).run();

    const report = reverify();
    expect(report.documents.recueilMatched).toBe(0);
    expect(report.documents.delta).toBe(-10);
    expect(report.pass).toBe(false);
    expect(report.checks.filter((row) => row.blocking && !row.pass).length).toBeGreaterThan(3);
  });
});

describe('the ASN collision path', () => {
  it('leaves an ASN alone when an item outside the import already holds it', async () => {
    const fresh = makeLibrary();
    try {
      // A hand-entered item that already has ASN 1002, which Paperless document 2 also claims.
      const existing = fresh.library.createItem(
        {
          itemType: 'letter',
          title: 'Hand-filed letter',
          office: { correspondent: 'Someone', asn: 1002 },
        },
        fresh.actor,
      );

      const { report } = await importPaperless(fresh, fixtureImportOptions(server) as never);

      const collision = report.review.find((entry) => entry.kind === 'asn_collision');
      expect(collision?.paperlessId).toBe(2);
      expect(collision?.detail?.['heldByItemId']).toBe(existing.item.id);
      expect(report.asn.collisions).toHaveLength(1);

      // The hand-entered item keeps the number; the imported one records it on a custom field.
      const imported = fresh.db.select().from(schema.items).where(eq(schema.items.sourceId, '2')).get();
      const office = fresh.db
        .select()
        .from(schema.itemOffice)
        .where(eq(schema.itemOffice.itemId, imported?.id as string))
        .get();
      expect(office?.asn).toBeNull();

      const carried = fresh.customFields
        .listValues(imported?.id as string)
        .find((value) => value.field.fieldKey === 'paperless_asn');
      expect(carried?.content).toStrictEqual({ type: 'integer', value: 1002 });

      expect(report.asn.unique).toBe(true);
      expect(report.pass).toBe(true);
    } finally {
      fresh.dispose();
    }
  });
});

describe('the Markdown rendering', () => {
  it('says FAIL when the JSON says FAIL, and names the checks that failed', () => {
    recueil.db.update(schema.items).set({ itemType: 'article' }).run();
    const report = reverify();

    // Rendered from the object, so the two cannot disagree.
    const markdown = renderReportMarkdown(report);

    expect(markdown).toContain('**FAIL**');
    expect(markdown).toContain('item_type_fidelity');
    expect(markdown).toContain(String(report.documents.recueilMistyped));
  });
});
