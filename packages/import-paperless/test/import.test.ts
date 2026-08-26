/**
 * The whole importer, end to end, against the fake server and a real library on disk.
 *
 * Every assertion about the target reads the target: `recueil.db`, `recueil.library`,
 * `recueil.customFields`. None of them reads the report to find out what the importer thinks it
 * did. Where the report is asserted on, it is asserted against numbers this test obtained the same
 * way, so that a report and a library that disagree fail the test rather than agreeing with each
 * other.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { schema } from '@recueil/core';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importPaperless } from '../src/import.js';
import { renderReportMarkdown } from '../src/report/markdown.js';
import type { PaperlessImportReport } from '../src/report/types.js';
import { FIXTURE_EXPECTATIONS, fakePdf, fixtureLibrary } from '../src/testing/fixtures.js';
import { fixtureImportOptions, makeLibrary, startFixtureServer } from './helpers.js';
import type { TestLibrary, TestServer } from './helpers.js';

let recueil: TestLibrary;
let server: TestServer;
let report: PaperlessImportReport;

const itemFor = (paperlessId: number) =>
  recueil.db
    .select()
    .from(schema.items)
    .where(and(eq(schema.items.sourceSystem, 'paperless'), eq(schema.items.sourceId, String(paperlessId))))
    .get();

const officeFor = (paperlessId: number) => {
  const item = itemFor(paperlessId);
  if (item === undefined) return undefined;
  return recueil.db.select().from(schema.itemOffice).where(eq(schema.itemOffice.itemId, item.id)).get();
};

const valueFor = (paperlessId: number, fieldKey: string) => {
  const item = itemFor(paperlessId);
  if (item === undefined) return undefined;
  return recueil.customFields
    .listValues(item.id)
    .find((value) => value.field.fieldKey === fieldKey);
};

beforeEach(async () => {
  recueil = makeLibrary();
  server = await startFixtureServer();
  const result = await importPaperless(recueil, {
    ...fixtureImportOptions(server),
    reportDirectory: recueil.reportDirectory,
  } as never);
  report = result.report;
});

afterEach(async () => {
  await server.close();
  recueil.dispose();
});

describe('items', () => {
  it('creates one item per Paperless document, and nothing else', () => {
    const rows = recueil.db
      .select()
      .from(schema.items)
      .where(eq(schema.items.sourceSystem, 'paperless'))
      .all();

    expect(rows).toHaveLength(FIXTURE_EXPECTATIONS.documents);
    expect(new Set(rows.map((row) => row.sourceId))).toStrictEqual(
      new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']),
    );
  });

  it('maps a recognised document type onto a core item type', () => {
    expect(itemFor(1)?.itemType).toBe('invoice');
    expect(itemFor(2)?.itemType).toBe('contract');
  });

  it('carries an unrecognised type in office_document_type and files it as a document', () => {
    expect(itemFor(4)?.itemType).toBe('document');
    expect(officeFor(4)?.officeDocumentType).toBe('kontoauszug');
    expect(valueFor(4, 'paperless_document_type')?.content).toStrictEqual({
      type: 'text',
      value: 'Kontoauszug',
    });
  });

  it('keeps the Paperless title and the Paperless timestamps', () => {
    expect(itemFor(1)?.title).toBe('Stadtwerke Rechnung März 2024');
    expect(itemFor(1)?.dateAdded).toBe('2024-03-02T07:15:00.000Z');
    expect(itemFor(1)?.dateModified).toBe('2024-03-04T10:02:33.000Z');
  });
});

describe('the Office facet', () => {
  it('writes correspondent, document date, ASN, amount and reference number', () => {
    const office = officeFor(1);
    expect(office?.correspondent).toBe('Stadtwerke Ulm');
    expect(office?.correspondentNormalised).toBe('stadtwerke ulm');
    expect(office?.documentDate).toBe('2024-03-01');
    expect(office?.asn).toBe(1001);
    expect(office?.amountMinor).toBe(8990);
    expect(office?.amountCurrency).toBe('EUR');
    expect(office?.referenceNumber).toBe('RE-2024-0031');
    expect(office?.dueDate).toBe('2024-03-20');
  });

  it('writes the contract period', () => {
    const office = officeFor(2);
    expect(office?.periodStart).toBe('2023-10-01');
    expect(office?.periodEnd).toBe('2026-09-30');
  });

  it('uses the placeholder for a document with no correspondent', () => {
    expect(officeFor(3)?.correspondent).toBe('Unknown correspondent');
    expect(report.correspondents.withoutCorrespondent).toBe(1);
  });

  it('records where every facet value came from (P4-1)', () => {
    const item = itemFor(1);
    const provenance = recueil.library.officeProvenance(item?.id as string);
    expect(provenance['correspondent']?.source).toBe('import:paperless');
    expect(provenance['asn']?.source).toBe('import:paperless');
    // An import is not a human, so nothing it writes is locked against a later resolver (P4-2).
    expect(provenance['correspondent']?.locked).toBe(false);
  });
});

describe('the archive serial number', () => {
  it('preserves every ASN it can', () => {
    expect(officeFor(1)?.asn).toBe(1001);
    expect(officeFor(2)?.asn).toBe(1002);
    expect(officeFor(4)?.asn).toBe(1003);
    expect(officeFor(5)?.asn).toBe(1004);
    expect(officeFor(10)?.asn).toBe(1005);
  });

  it('refuses the duplicate rather than failing the run, and says why', () => {
    expect(officeFor(6)?.asn).toBeNull();

    const entry = report.review.find((row) => row.kind === 'asn_duplicate_in_paperless');
    expect(entry?.paperlessId).toBe(6);
    expect(entry?.reason).toMatch(/1001/u);
    expect(entry?.proposedAction).toMatch(/paperless_asn/u);
  });

  it('keeps the refused number on a custom field, so nothing is lost', () => {
    expect(valueFor(6, 'paperless_asn')?.content).toStrictEqual({ type: 'integer', value: 1001 });
  });

  it('leaves the library with a unique ASN, by query', () => {
    const asns = recueil.db
      .select({ asn: schema.itemOffice.asn })
      .from(schema.itemOffice)
      .all()
      .map((row) => row.asn)
      .filter((asn): asn is number => asn !== null);

    expect(asns).toHaveLength(FIXTURE_EXPECTATIONS.asnWrittenToFacet);
    expect(new Set(asns).size).toBe(asns.length);
    expect(report.asn.unique).toBe(true);
  });
});

describe('originals', () => {
  it('hashes and stores every original it could fetch (ADR-0004)', () => {
    const documents = recueil.db.select().from(schema.documents).all();
    expect(documents).toHaveLength(FIXTURE_EXPECTATIONS.distinctDocuments);
    for (const document of documents) expect(document.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('stores the original, not Paperless’s archive copy', () => {
    const expected = createHash('sha256').update(fakePdf('stadtwerke-2024-03')).digest('hex');
    const attached = recueil.db
      .select({ sha256: schema.documents.sha256 })
      .from(schema.attachments)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.attachments.documentId))
      .where(eq(schema.attachments.itemId, itemFor(1)?.id as string))
      .get();

    expect(attached?.sha256).toBe(expected);
  });

  it('shares one blob between two documents with identical bytes', () => {
    const one = recueil.db
      .select({ documentId: schema.attachments.documentId })
      .from(schema.attachments)
      .where(eq(schema.attachments.itemId, itemFor(1)?.id as string))
      .get();
    const ten = recueil.db
      .select({ documentId: schema.attachments.documentId })
      .from(schema.attachments)
      .where(eq(schema.attachments.itemId, itemFor(10)?.id as string))
      .get();

    expect(one?.documentId).toBe(ten?.documentId);
    expect(report.originals.duplicateOriginals).toBe(1);
  });

  it('puts a document whose original is gone in the review queue, and keeps the item', () => {
    expect(itemFor(5)).toBeDefined();
    expect(officeFor(5)?.asn).toBe(1004);

    const attachments = recueil.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.itemId, itemFor(5)?.id as string))
      .all();
    expect(attachments).toHaveLength(0);

    const entry = report.review.find((row) => row.kind === 'original_missing');
    expect(entry?.paperlessId).toBe(5);
    expect(entry?.reason).toMatch(/404/u);
    expect(report.originals.missing).toBe(FIXTURE_EXPECTATIONS.originalsMissing);
  });

  it('reconciles our hash against the MD5 Paperless recorded', () => {
    expect(report.originals.checksumMismatches).toBe(FIXTURE_EXPECTATIONS.checksumMismatches);
    const entry = report.review.find((row) => row.kind === 'checksum_mismatch');
    expect(entry?.paperlessId).toBe(7);

    // The bytes are still stored: a mismatch is a fact to report, not a reason to drop a file.
    const attachments = recueil.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.itemId, itemFor(7)?.id as string))
      .all();
    expect(attachments).toHaveLength(1);
  });

  it('never lets a hostile original_file_name become a path', () => {
    const document = recueil.db
      .select({ originalFilename: schema.documents.originalFilename, storageKey: schema.documents.storageKey })
      .from(schema.attachments)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.attachments.documentId))
      .where(eq(schema.attachments.itemId, itemFor(3)?.id as string))
      .get();

    // The store is content-addressed, so the key is the digest and nothing else.
    expect(document?.storageKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/u);
    expect(document?.storageKey).not.toContain('..');
    expect(document?.storageKey).not.toContain('passwd');
  });

  it('sniffs the MIME type from the bytes rather than trusting the server', () => {
    const document = recueil.db
      .select({ mimeType: schema.documents.mimeType })
      .from(schema.attachments)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.attachments.documentId))
      .where(eq(schema.attachments.itemId, itemFor(3)?.id as string))
      .get();
    expect(document?.mimeType).toBe('image/png');
  });

  it('records where the bytes came from, so a resumed run can find them again', () => {
    const provenance = recueil.db
      .select()
      .from(schema.documentProvenance)
      .where(eq(schema.documentProvenance.sourceRef, 'paperless:document:2'))
      .get();

    expect(provenance).toBeDefined();
    expect(provenance?.sourceKind).toBe('import');
  });
});

describe('tags', () => {
  it('creates one Recueil tag per Paperless tag, with its colour', () => {
    const tags = recueil.tags.list();
    expect(tags).toHaveLength(FIXTURE_EXPECTATIONS.tags);

    const wohnung = recueil.tags.findByName('Wohnung');
    expect(wohnung?.colour).toBe('#ff0000');
    expect(wohnung?.scheme).toBe('imported');
  });

  it('assigns them to the right items', () => {
    const names = recueil.tags.forItem(itemFor(1)?.id as string).map((tag) => tag.name).sort();
    expect(names).toStrictEqual(['Energie', 'Wohnung']);
  });

  it('reports a tag id that was not in /api/tags/ rather than dropping it silently', async () => {
    // Built here rather than kept in the shared fixture: a document naming a tag `/api/tags/` never
    // defined is a library whose verification report is correctly FAIL, and the shared fixture is
    // the one every other test asserts a clean import against. `report-checks.test.ts` asserts the
    // report fails; this asserts the loss is named rather than dropped.
    const dangling = fixtureLibrary();
    const eight = dangling.documents.find((row) => row.id === 8) as { tags: number[] };
    eight.tags = [99];

    const fresh = makeLibrary();
    const other = await startFixtureServer({}, dangling);
    try {
      const { report: withDangling } = await importPaperless(
        fresh,
        fixtureImportOptions(other) as never,
      );

      const entry = withDangling.skipped.find((row) => row.kind === 'tag_assignment');
      expect(entry?.paperlessId).toBe(8);
      expect(entry?.subject).toMatch(/tag 99/u);
      expect(withDangling.tags.danglingTagIds).toStrictEqual([99]);
    } finally {
      await other.close();
      fresh.dispose();
    }
  });
});

describe('notes', () => {
  it('carries every Paperless note across', () => {
    expect(recueil.notes.forItem(itemFor(1)?.id as string)).toHaveLength(1);
    expect(recueil.notes.forItem(itemFor(2)?.id as string)).toHaveLength(2);
    expect(report.notes.apiTotal).toBe(FIXTURE_EXPECTATIONS.notes);
    expect(report.notes.recueilTotal).toBe(FIXTURE_EXPECTATIONS.notes);
  });

  it('keeps the note text and its original timestamp', () => {
    const note = recueil.notes.forItem(itemFor(1)?.id as string)[0];
    expect(note?.contentMarkdown).toBe('Per Lastschrift bezahlt.');
    expect(note?.createdAt).toBe('2024-03-05T09:00:00.000Z');
  });
});

describe('custom fields', () => {
  it('defines every supported Paperless field with its type preserved', () => {
    const defined = recueil.db.select().from(schema.customFields).all();
    const byKey = new Map(defined.map((row) => [row.fieldKey, row.dataType]));

    expect(byKey.get('betrag')).toBe('monetary');
    expect(byKey.get('rechnungsnummer')).toBe('text');
    expect(byKey.get('zeitraum_von')).toBe('date');
    expect(byKey.get('status')).toBe('choice');
    expect(byKey.get('verknuepfte_dokumente')).toBe('item_reference');
    expect(byKey.get('bemerkung')).toBe('long_text');
    expect(byKey.get('bezahlt')).toBe('boolean');
    expect(byKey.get('seitenzahl')).toBe('integer');
    expect(byKey.get('bewertung')).toBe('number');
    expect(byKey.get('webseite')).toBe('url');
    expect(byKey.has('zukunftsfeld')).toBe(false);
  });

  it('writes the values, typed', () => {
    // The currency is carried on the field, not on the value: `decodeContent` reads it from
    // `config.currency`, which the plan filled in because every value in this field agreed on EUR.
    expect(valueFor(1, 'betrag')?.field.config).toContain('"currency":"EUR"');
    expect(valueFor(1, 'betrag')?.content).toStrictEqual({
      type: 'monetary',
      value: 89.9,
      currency: 'EUR',
    });
    expect(valueFor(1, 'status')?.content).toStrictEqual({ type: 'choice', value: 'bezahlt' });
    expect(valueFor(1, 'bezahlt')?.content).toStrictEqual({ type: 'boolean', value: true });
    expect(valueFor(1, 'seitenzahl')?.content).toStrictEqual({ type: 'integer', value: 2 });
    expect(valueFor(1, 'bewertung')?.content).toStrictEqual({ type: 'number', value: 4.5 });
  });

  it('resolves a document link to the Recueil item it points at', () => {
    const link = valueFor(2, 'verknuepfte_dokumente');
    expect(link?.content).toStrictEqual({ type: 'item_reference', value: itemFor(1)?.id });
  });

  it('leaves out a link whose target is not in the import, and says so', () => {
    const item = itemFor(9);
    const links = recueil.customFields
      .listValues(item?.id as string)
      .filter((value) => value.field.fieldKey === 'verknuepfte_dokumente');

    expect(links).toHaveLength(1);
    expect(links[0]?.content).toStrictEqual({ type: 'item_reference', value: itemFor(2)?.id });

    const entry = report.review.find((row) => row.kind === 'document_link_unresolved');
    expect(entry?.paperlessId).toBe(9);
    expect(entry?.detail?.['unresolved']).toStrictEqual([999]);
  });

  it('skips a value it cannot represent, with a reason', () => {
    expect(valueFor(8, 'status')).toBeUndefined();
    const entry = report.skipped.find(
      (row) => row.kind === 'custom_field_value' && row.paperlessId === 8 && row.subject.includes('Status'),
    );
    expect(entry?.reason).toMatch(/select_options/u);
  });

  it('does not put an amount with no currency into the facet, but keeps it on the field', () => {
    expect(officeFor(4)?.amountMinor).toBeNull();
    expect(officeFor(4)?.amountCurrency).toBeNull();
    // 123.45 exactly: the minor units came from the digits, not from `1.2345 * 100`, which is
    // 123.44999999999999 in binary floating point.
    expect(valueFor(4, 'betrag')?.content).toStrictEqual({
      type: 'monetary',
      value: 123.45,
      currency: 'EUR',
    });
  });

  it('carries the Paperless storage path across', () => {
    expect(valueFor(1, 'paperless_storage_path')?.content).toStrictEqual({
      type: 'text',
      value: 'Wohnung',
    });
  });
});

describe('the verification report', () => {
  it('passes, and every blocking check passes', () => {
    const failed = report.checks.filter((check) => check.blocking && !check.pass);
    expect(failed.map((check) => check.name)).toStrictEqual([]);
    expect(report.pass).toBe(true);
  });

  it('agrees with the library about the document count', () => {
    const queried = recueil.db
      .select()
      .from(schema.items)
      .where(eq(schema.items.sourceSystem, 'paperless'))
      .all().length;

    expect(report.documents.recueilTotal).toBe(queried);
    expect(report.documents.apiFetched).toBe(FIXTURE_EXPECTATIONS.documents);
    expect(report.documents.delta).toBe(0);
    expect(report.documents.missingInRecueil).toStrictEqual([]);
  });

  it('reports hash coverage against what was attempted', () => {
    expect(report.originals.attempted).toBe(FIXTURE_EXPECTATIONS.documents);
    expect(report.originals.stored).toBe(FIXTURE_EXPECTATIONS.originalsStored);
    expect(report.originals.distinctDocuments).toBe(FIXTURE_EXPECTATIONS.distinctDocuments);
    expect(report.originals.hashCoveragePercent).toBe(90);
  });

  it('records the version it was modelled against, and whether the server matches', () => {
    expect(report.source.modelledAgainstVersion).toBe('3.0.5');
    expect(report.source.serverVersion).toBe('3.0.5');
    expect(report.source.versionMatchesModel).toBe(true);
  });

  it('names every field this phase cannot carry', () => {
    const fields = report.notCarried.map((row) => row.field);
    expect(fields).toContain('documents.content');
    expect(fields).toContain('tags.parent');
    expect(fields).toContain('documents.owner / permissions');
    expect(report.notCarried.find((row) => row.field === 'tags.parent')?.count).toBe(1);
  });

  it('explains how each facet column found its source field', () => {
    const amount = report.customFields.facetSources.find((row) => row.column === 'amount');
    expect(amount?.outcome).toBe('matched');
    expect(amount?.fieldName).toBe('Betrag');
  });

  it('writes report.json, report.md and one review file per entry', () => {
    const json = JSON.parse(
      readFileSync(`${recueil.reportDirectory}/report.json`, 'utf8'),
    ) as PaperlessImportReport;
    expect(json.pass).toBe(true);
    expect(json.documents.recueilMatched).toBe(report.documents.recueilMatched);

    const markdown = readFileSync(`${recueil.reportDirectory}/report.md`, 'utf8');
    expect(markdown).toContain('**PASS**');
    expect(markdown).toContain(`${report.originals.stored} originals hashed`);

    const index = JSON.parse(
      readFileSync(`${recueil.reportDirectory}/_REVIEW/index.json`, 'utf8'),
    ) as { count: number };
    expect(index.count).toBe(report.review.length);
    expect(report.review.length).toBeGreaterThan(0);
  });

  it('never writes the token anywhere in the report', () => {
    const json = readFileSync(`${recueil.reportDirectory}/report.json`, 'utf8');
    expect(json).not.toContain(server.token);
    expect(report.source.baseUrl).toBe(`${server.baseUrl}/api/`);
  });
});

describe('a metadata-only rehearsal', () => {
  it('says nothing about originals rather than passing four checks on no evidence', async () => {
    const fresh = makeLibrary();
    try {
      const { report: rehearsal } = await importPaperless(fresh, {
        ...fixtureImportOptions(server),
        downloadOriginals: false,
      } as never);

      expect(rehearsal.originals.fetchEnabled).toBe(false);
      expect(rehearsal.originals.attempted).toBe(0);
      expect(fresh.db.select().from(schema.documents).all()).toHaveLength(0);
      expect(fresh.db.select().from(schema.attachments).all()).toHaveLength(0);

      const names = rehearsal.checks.map((check) => check.name);
      expect(names).toContain('originals_not_fetched');
      expect(names).not.toContain('original_hash_coverage');
      expect(names).not.toContain('attachment_records_carried');
      expect(names).not.toContain('originals_accounted_for');
      expect(names).not.toContain('original_checksums_agree');

      // The rest of the library is complete, so the run still passes on what it did do.
      expect(rehearsal.documents.delta).toBe(0);
      expect(rehearsal.pass).toBe(true);

      const markdown = renderReportMarkdown(rehearsal);
      expect(markdown).toContain('originals not fetched');
      expect(markdown).not.toContain('100% coverage');
    } finally {
      fresh.dispose();
    }
  });

  it('attaches the files on a later run that does fetch them', async () => {
    const fresh = makeLibrary();
    try {
      await importPaperless(fresh, {
        ...fixtureImportOptions(server),
        downloadOriginals: false,
      } as never);
      const { report: full } = await importPaperless(fresh, fixtureImportOptions(server) as never);

      expect(full.originals.stored).toBe(FIXTURE_EXPECTATIONS.originalsStored);
      expect(full.pass).toBe(true);
      expect(fresh.db.select().from(schema.documents).all()).toHaveLength(
        FIXTURE_EXPECTATIONS.distinctDocuments,
      );
    } finally {
      fresh.dispose();
    }
  });
});

describe('the job record', () => {
  it('finishes as succeeded, with the key IK1 prescribes', () => {
    const job = recueil.db.select().from(schema.jobs).get();
    expect(job?.jobType).toBe('import.paperless');
    expect(job?.state).toBe('succeeded');
    expect(job?.idempotencyKey).toMatch(/^import\.paperless:[0-9a-f]{32}:default$/u);
    expect(job?.attempts).toBe(1);
  });
});
