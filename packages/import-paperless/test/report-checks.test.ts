/**
 * ADR-0021: every blocking check ships with a test proving it can fail.
 *
 * `report.test.ts` came first and damages the target in the obvious ways. This file is the
 * exhaustive one, and it is exhaustive by construction: `FALSIFIED` below lists every blocking
 * check that has a falsification here, and the first test asserts that set is exactly the set of
 * blocking checks a real run emits. A check added without a test that watches it fail cannot slip
 * through — the suite goes red naming it.
 *
 * It also carries the three Phase 2 reproductions verbatim, because every one of them was a green
 * report over a real loss:
 *
 * - a Paperless whose `/api/tags/` answers empty while the documents still carry tag ids: nine tag
 *   assignments and four tags lost, `PASS tag_assignments_carried expected=9 actual=0`;
 * - a Paperless whose `/api/custom_fields/` answers empty while the documents still carry values:
 *   nineteen values lost, `PASS custom_field_values_carried expected=0 actual=0` — both sides
 *   bucketed through the importer's own plan, so both read zero;
 * - five hand-entered items already holding ASNs 1001–1005: no archive serial number reached
 *   `item_office.asn` at all, `PASS asn_preserved expected=6 actual=0`.
 *
 * Each of them turned on adding the importer's own `job_logs` narration to the target side of the
 * comparison, so there is a test here for that too: a target with every tag assignment deleted and
 * a job log stuffed with fabricated "skipped" records still fails.
 */
import { schema } from '@recueil/core';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importPaperless } from '../src/import.js';
import type { ApiSnapshot, PaperlessImportResult } from '../src/import.js';
import { buildReport, readImportLog } from '../src/report/build.js';
import type { PaperlessImportReport, ReportCheck } from '../src/report/types.js';
import { fixtureLibrary } from '../src/testing/fixtures.js';
import { fixtureImportOptions, makeLibrary, startFixtureServer } from './helpers.js';
import type { TestLibrary, TestServer } from './helpers.js';

/**
 * Every blocking check this file falsifies.
 *
 * Kept as data rather than left implicit in the test names, so that the coverage assertion below
 * can compare it against what the report actually emits.
 */
const FALSIFIED = new Set([
  'document_count_parity',
  'document_list_complete',
  'item_type_fidelity',
  'attachment_records_carried',
  'originals_accounted_for',
  'asn_preserved',
  'asn_carried_to_facet',
  'asn_unique',
  'tags_carried',
  'tag_references_resolvable',
  'tag_assignments_carried',
  'custom_fields_defined',
  'custom_field_references_resolvable',
  'custom_field_values_carried',
  'notes_carried',
]);

let recueil: TestLibrary;
let server: TestServer;
let run: PaperlessImportResult;

/** Rebuild the report against whatever state the library is in now, optionally against a changed source. */
const reverify = (snapshot: ApiSnapshot = run.snapshot): PaperlessImportReport =>
  buildReport({
    recueil,
    snapshot,
    plan: run.plan,
    log: readImportLog(recueil, run.jobId),
    baseUrl: `${server.baseUrl}/api/`,
    downloadOriginals: true,
    run: run.report.run,
  });

const check = (report: PaperlessImportReport, name: string): ReportCheck => {
  const found = report.checks.find((row) => row.name === name);
  expect(found, `the report has no check called '${name}'`).toBeDefined();
  return found as ReportCheck;
};

/** Assert that this one check failed, and that it is the reason the report failed. */
const failsOn = (report: PaperlessImportReport, name: string): ReportCheck => {
  const entry = check(report, name);
  expect(
    entry.pass,
    `${name} still passes: expected=${String(entry.expected)} actual=${String(entry.actual)}`,
  ).toBe(false);
  expect(entry.blocking).toBe(true);
  expect(report.pass).toBe(false);
  return entry;
};

const itemFor = (paperlessId: number): string =>
  recueil.db
    .select({ id: schema.items.id })
    .from(schema.items)
    .where(
      and(
        eq(schema.items.sourceSystem, 'paperless'),
        eq(schema.items.sourceId, String(paperlessId)),
      ),
    )
    .get()?.id as string;

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

describe('the coverage rule', () => {
  it('has a falsification test for every blocking check the report emits', () => {
    const blocking = run.report.checks.filter((row) => row.blocking).map((row) => row.name);
    expect([...blocking].sort()).toStrictEqual([...FALSIFIED].sort());
  });

  it('leaves no blocking check whose verdict disagrees with the numbers beside it', () => {
    // ADR-0021 §3, made structural: `pass` is derived from `expected`, `actual` and `compare`, so
    // `PASS ... expected=6 actual=0` — which is what the Phase 2 review found and quoted — cannot
    // be written any more. Recomputing here proves the derivation is the one the table shows.
    for (const entry of run.report.checks) {
      const recomputed =
        entry.compare === 'equals'
          ? entry.expected === entry.actual
          : typeof entry.expected === 'number' &&
            typeof entry.actual === 'number' &&
            entry.actual >= entry.expected;
      expect(recomputed, `${entry.name} prints a comparison it did not use`).toBe(entry.pass);
    }
  });

  it('uses no inequality in a blocking check', () => {
    const inequalities = run.report.checks
      .filter((row) => row.blocking && row.compare !== 'equals')
      .map((row) => row.name);
    expect(inequalities).toStrictEqual([]);
  });
});

describe('the three Phase 2 reproductions', () => {
  it('fails when /api/tags/ answers empty and the documents still carry tag ids', async () => {
    const library = fixtureLibrary();
    library.tags = [];
    const other = await startFixtureServer({}, library);
    const fresh = makeLibrary();
    try {
      const { report } = await importPaperless(fresh, fixtureImportOptions(other) as never);

      // The loss is real: nine assignments on the wire, nothing in the target.
      const advertised = library.documents.reduce(
        (sum, document) => sum + (document.tags?.length ?? 0),
        0,
      );
      expect(advertised).toBe(9);
      expect(fresh.db.select().from(schema.itemTags).all()).toHaveLength(0);
      expect(fresh.db.select().from(schema.tags).all()).toHaveLength(0);

      const entry = report.checks.find((row) => row.name === 'tag_references_resolvable');
      expect(entry?.pass).toBe(false);
      expect(entry?.blocking).toBe(true);
      expect(report.tags.danglingTagIds).toStrictEqual([1, 2, 3, 4]);
      expect(report.pass).toBe(false);
    } finally {
      await other.close();
      fresh.dispose();
    }
  });

  it('fails when /api/custom_fields/ answers empty and the documents still carry values', async () => {
    const library = fixtureLibrary();
    library.customFields = [];
    const other = await startFixtureServer({}, library);
    const fresh = makeLibrary();
    try {
      const { report } = await importPaperless(fresh, fixtureImportOptions(other) as never);

      const advertised = library.documents.reduce(
        (sum, document) => sum + (document.custom_fields ?? []).length,
        0,
      );
      expect(advertised).toBe(19);
      expect(report.customFields.apiValueInstances).toBe(19);

      const entry = report.checks.find((row) => row.name === 'custom_field_references_resolvable');
      expect(entry?.pass).toBe(false);
      expect(entry?.blocking).toBe(true);
      expect(entry?.actual).toBe(report.customFields.danglingFieldIds.length);
      expect(report.pass).toBe(false);
    } finally {
      await other.close();
      fresh.dispose();
    }
  });

  it('fails when hand-entered items already hold every ASN the import carries', async () => {
    const fresh = makeLibrary();
    const other = await startFixtureServer();
    try {
      for (const asn of [1001, 1002, 1003, 1004, 1005]) {
        fresh.library.createItem(
          { itemType: 'letter', title: `Hand ${asn}`, office: { correspondent: 'Jemand', asn } },
          fresh.actor,
        );
      }

      const { report } = await importPaperless(fresh, fixtureImportOptions(other) as never);

      expect(report.asn.apiWithAsn).toBe(6);
      expect(report.asn.recueilCarried).toBe(0);

      // Nothing was destroyed — every number is on a `paperless_asn` field, and the report proves
      // it by looking rather than by counting its own review entries.
      expect(report.asn.recueilDeferred).toBe(6);
      expect(report.asn.lost).toStrictEqual([]);
      expect(report.checks.find((row) => row.name === 'asn_preserved')?.pass).toBe(true);

      // But not one of them reached the facet, and that is what the report is asked about.
      const carried = report.checks.find((row) => row.name === 'asn_carried_to_facet');
      expect(carried?.pass).toBe(false);
      expect(carried?.expected).toBe(5);
      expect(carried?.actual).toBe(0);
      expect(report.pass).toBe(false);
    } finally {
      await other.close();
      fresh.dispose();
    }
  });
});

describe('falsifying each blocking check by mutating the target', () => {
  it('document_count_parity — an item loses its Paperless origin', () => {
    recueil.db
      .update(schema.items)
      .set({ sourceId: '424242' })
      .where(eq(schema.items.id, itemFor(9)))
      .run();

    const report = reverify();
    expect(report.documents.missingInRecueil).toStrictEqual([9]);
    const entry = failsOn(report, 'document_count_parity');
    expect(entry.expected).toBe(10);
    expect(entry.actual).toBe(9);
  });

  it('item_type_fidelity — one row is stored under the wrong type', () => {
    recueil.db
      .update(schema.items)
      .set({ itemType: 'article' })
      .where(eq(schema.items.id, itemFor(1)))
      .run();

    const report = reverify();
    expect(report.documents.recueilMistyped).toBe(1);
    failsOn(report, 'item_type_fidelity');
  });

  it('attachment_records_carried — a blob stays in the store with nothing pointing at it', () => {
    recueil.db.delete(schema.attachments).where(eq(schema.attachments.itemId, itemFor(2))).run();

    const report = reverify();
    expect(report.originals.recueilAttachmentsMissing).toStrictEqual([2]);
    failsOn(report, 'attachment_records_carried');
  });

  it('originals_accounted_for — a file goes missing with nothing explaining it', () => {
    const itemId = itemFor(2);
    recueil.db
      .delete(schema.documentProvenance)
      .where(eq(schema.documentProvenance.sourceRef, 'paperless:document:2'))
      .run();
    recueil.db.delete(schema.attachments).where(eq(schema.attachments.itemId, itemId)).run();

    const report = reverify();
    expect(report.originals.unaccountedWithoutOriginal).toStrictEqual([2]);
    failsOn(report, 'originals_accounted_for');
  });

  it('originals_accounted_for — and in the other direction, a recorded loss whose file is there', () => {
    // Document 5's original really is missing and the run recorded it. Putting a provenance row
    // back makes the two records contradict each other, which is the half a count could not see:
    // one missing file and one spurious explanation cancel out arithmetically.
    const existing = recueil.db
      .select()
      .from(schema.documentProvenance)
      .where(eq(schema.documentProvenance.sourceRef, 'paperless:document:2'))
      .get();
    recueil.db
      .insert(schema.documentProvenance)
      .values({
        ...(existing as typeof schema.documentProvenance.$inferInsert),
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        sourceRef: 'paperless:document:5',
        // `ux_document_provenance_first` is partial on `is_first`, so a second arrival of the same
        // blob is what this is — which is exactly what a second Paperless document sharing bytes
        // with the first looks like.
        isFirst: false,
      })
      .run();

    const report = reverify();
    expect(report.originals.contradictedByStore).toStrictEqual([5]);
    failsOn(report, 'originals_accounted_for');
  });

  it('asn_preserved — a deferred ASN loses the field that was keeping it', () => {
    // Document 6's ASN could not reach the facet because Paperless put 1001 on document 1 as well.
    // The number survives on `paperless_asn`; deleting that value is the loss the check is for.
    const field = recueil.db
      .select()
      .from(schema.customFields)
      .where(eq(schema.customFields.fieldKey, 'paperless_asn'))
      .get();
    recueil.db
      .delete(schema.fieldValues)
      .where(
        and(
          eq(schema.fieldValues.fieldId, field?.id as string),
          eq(schema.fieldValues.itemId, itemFor(6)),
        ),
      )
      .run();

    const report = reverify();
    expect(report.asn.lost.map((row) => row.paperlessId)).toStrictEqual([6]);
    const entry = failsOn(report, 'asn_preserved');
    expect(entry.expected).toBe(6);
    expect(entry.actual).toBe(5);
  });

  it('asn_carried_to_facet — an ASN is cleared off the facet', () => {
    recueil.db
      .update(schema.itemOffice)
      .set({ asn: null })
      .where(eq(schema.itemOffice.itemId, itemFor(4)))
      .run();

    const report = reverify();
    expect(report.asn.recueilCarried).toBe(4);
    const entry = failsOn(report, 'asn_carried_to_facet');
    expect(entry.expected).toBe(5);
    expect(entry.actual).toBe(4);
  });

  it('asn_unique — two live items come to share a number behind the partial index', () => {
    // `ux_item_office_asn` is partial on `item_office.item_trashed_at`, an application-maintained
    // mirror (§1.1). Drifting the mirror switches the index off for that row while the item is
    // still live, which is the one way two live items can share an ASN. Doing it here proves the
    // check reads `items`, not the mirror the index reads.
    recueil.connection.exec(
      "update item_office set item_trashed_at = '2020-01-01T00:00:00.000Z' where asn = 1003",
    );
    recueil.connection.exec('update item_office set asn = 1001 where asn = 1003');

    const report = reverify();
    expect(report.asn.unique).toBe(false);
    failsOn(report, 'asn_unique');
  });

  it('tags_carried — a tag is removed from the library', () => {
    const tag = recueil.tags.findByName('Steuer');
    recueil.db.delete(schema.itemTags).where(eq(schema.itemTags.tagId, tag?.id as string)).run();
    recueil.db.delete(schema.tags).where(eq(schema.tags.id, tag?.id as string)).run();

    const report = reverify();
    expect(report.tags.missingInRecueil).toStrictEqual(['Steuer']);
    failsOn(report, 'tags_carried');
  });

  it('tag_assignments_carried — the tags survive but one item loses its rows', () => {
    recueil.db.delete(schema.itemTags).where(eq(schema.itemTags.itemId, itemFor(1))).run();

    const report = reverify();
    // Isolated on purpose: every tag is still there, so only the assignment check may fail.
    expect(check(report, 'tags_carried').pass).toBe(true);
    const entry = failsOn(report, 'tag_assignments_carried');
    expect(entry.expected).toBe(9);
    expect(entry.actual).toBe(7);
  });

  it('custom_fields_defined — a definition is repurposed to another data type', () => {
    // CF1 makes the data type immutable, so this is not something the services would allow; it is
    // exactly the damage the check exists to notice, and §6 asks for the types to be preserved.
    recueil.db
      .update(schema.customFields)
      .set({ dataType: 'text' })
      .where(eq(schema.customFields.fieldKey, 'betrag'))
      .run();

    const report = reverify();
    const entry = failsOn(report, 'custom_fields_defined');
    expect(entry.expected).toBe(12);
    expect(entry.actual).toBe(11);
  });

  it('custom_field_values_carried — the values of one field are deleted', () => {
    const field = recueil.db
      .select()
      .from(schema.customFields)
      .where(eq(schema.customFields.fieldKey, 'rechnungsnummer'))
      .get();
    recueil.db
      .delete(schema.fieldValues)
      .where(eq(schema.fieldValues.fieldId, field?.id as string))
      .run();

    const report = reverify();
    expect(check(report, 'custom_fields_defined').pass).toBe(true);
    const entry = failsOn(report, 'custom_field_values_carried');
    expect(entry.expected).toBe(17);
    expect(entry.actual).toBe(15);
  });

  it('notes_carried — a note is deleted', () => {
    const note = recueil.db.select().from(schema.notes).get();
    recueil.db.delete(schema.notes).where(eq(schema.notes.id, note?.id as string)).run();

    const report = reverify();
    const entry = failsOn(report, 'notes_carried');
    expect(entry.expected).toBe(3);
    expect(entry.actual).toBe(2);
  });
});

describe('falsifying each blocking check by mutating the source', () => {
  it('document_list_complete — the server reported more documents than the walk returned', () => {
    const report = reverify({ ...run.snapshot, reportedTotal: run.snapshot.reportedTotal + 1 });
    const entry = failsOn(report, 'document_list_complete');
    expect(entry.expected).toBe(11);
    expect(entry.actual).toBe(10);
  });

  it('tag_references_resolvable — a document names a tag id /api/tags/ never defined', () => {
    const snapshot: ApiSnapshot = {
      ...run.snapshot,
      tags: run.snapshot.tags.filter((tag) => tag.name !== 'Steuer'),
    };

    const report = reverify(snapshot);
    expect(report.tags.danglingTagIds).toStrictEqual([4]);
    failsOn(report, 'tag_references_resolvable');
  });

  it('custom_field_references_resolvable — a document holds a value for an undefined field', () => {
    const snapshot: ApiSnapshot = {
      ...run.snapshot,
      customFields: run.snapshot.customFields.filter((field) => field.id !== 2),
    };

    const report = reverify(snapshot);
    expect(report.customFields.danglingFieldIds).toStrictEqual([2]);
    failsOn(report, 'custom_field_references_resolvable');
  });
});

describe('no blocking check can be satisfied by narration', () => {
  it('stays red however many skipped records the job log claims', () => {
    recueil.db.delete(schema.itemTags).run();

    // The Phase 1 and Phase 2 defect in one line: the target side used to be
    // `recueilAssignments + skippedAssignments`, so writing enough of these made the check pass.
    for (let index = 0; index < 20; index += 1) {
      recueil.db
        .insert(schema.jobLogs)
        .values({
          id: `01ARZ3NDEKTSV4RRFFQ69G5${String(index).padStart(3, '0')}`,
          jobId: run.jobId,
          level: 'warn',
          message: 'skipped',
          data: JSON.stringify({
            kind: 'tag_assignment',
            paperlessId: index + 1,
            subject: `fabricated ${index}`,
            reason: 'invented so that the check would pass',
          }),
          loggedAt: '2024-01-01T00:00:00.000Z',
        })
        .run();
    }

    const report = reverify();
    expect(report.tags.skippedAssignments).toBe(20);
    const entry = failsOn(report, 'tag_assignments_carried');
    expect(entry.expected).toBe(9);
    expect(entry.actual).toBe(0);
  });

  it('stays red however many ASN collisions the job log claims', () => {
    recueil.db.update(schema.itemOffice).set({ asn: null }).run();

    for (let index = 0; index < 10; index += 1) {
      recueil.db
        .insert(schema.jobLogs)
        .values({
          id: `01ARZ3NDEKTSV4RRFFQ69G6${String(index).padStart(3, '0')}`,
          jobId: run.jobId,
          level: 'warn',
          message: 'review',
          data: JSON.stringify({
            kind: 'asn_collision',
            paperlessId: index + 1,
            subject: 'fabricated',
            reason: 'invented so that the check would pass',
            proposedAction: 'none',
            detail: { asn: 1000 + index, heldByItemId: 'nobody' },
          }),
          loggedAt: '2024-01-01T00:00:00.000Z',
        })
        .run();
    }

    const report = reverify();
    expect(report.asn.collisions).toHaveLength(10);
    failsOn(report, 'asn_carried_to_facet');
    failsOn(report, 'asn_preserved');
  });
});
