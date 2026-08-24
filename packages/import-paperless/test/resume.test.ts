/**
 * Interrupting an import and picking it up again (P9, IK4).
 *
 * Two things have to be true, and only one of them is obvious.
 *
 * The obvious one: the finished library must be the library an uninterrupted run would have made.
 *
 * The other one: the resumed run must not re-fetch the originals it already has. Downloading is the
 * whole cost of this import — the JSON of a page is a few kilobytes and one original is a few
 * megabytes — so a "resume" that starts the download loop again is a re-run wearing a hat, and the
 * only way to tell the difference is to count the requests the server saw.
 */
import { schema } from '@recueil/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ImportCancelledError, importPaperless } from '../src/import.js';
import { FIXTURE_EXPECTATIONS } from '../src/testing/fixtures.js';
import { fixtureImportOptions, makeLibrary, startFixtureServer } from './helpers.js';
import type { TestLibrary, TestServer } from './helpers.js';

let recueil: TestLibrary;
let server: TestServer;

const downloadsSeen = (): number =>
  server.server.requests.filter((request) => request.url.includes('/download/')).length;

const stopAfter = (documents: number) => (progress: { stage: string; index: number }) =>
  progress.stage === 'documents' && progress.index >= documents;

beforeEach(async () => {
  recueil = makeLibrary();
  server = await startFixtureServer();
});

afterEach(async () => {
  await server.close();
  recueil.dispose();
});

describe('an interrupted run', () => {
  it('stops cleanly and keeps its cursor', async () => {
    const error = await importPaperless(recueil, {
      ...fixtureImportOptions(server),
      abortAfter: stopAfter(4),
    } as never).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ImportCancelledError);
    const cancelled = error as ImportCancelledError;
    expect(cancelled.cursor.stage).toBe('documents');
    expect(cancelled.cursor.lastDocumentId).toBe(4);

    const job = recueil.db.select().from(schema.jobs).get();
    expect(job?.state).toBe('cancelled');
    expect(JSON.parse(job?.cursor ?? '{}')).toMatchObject({ stage: 'documents', lastDocumentId: 4 });

    // Four documents are already complete, files and all.
    expect(
      recueil.db.select().from(schema.items).where(eq(schema.items.sourceSystem, 'paperless')).all(),
    ).toHaveLength(4);
    expect(recueil.db.select().from(schema.documents).all()).toHaveLength(4);
  });

  it('resumes where it stopped and finishes the library', async () => {
    await importPaperless(recueil, {
      ...fixtureImportOptions(server),
      abortAfter: stopAfter(4),
    } as never).catch(() => undefined);

    const downloadsBefore = downloadsSeen();
    const { report } = await importPaperless(recueil, fixtureImportOptions(server) as never);

    expect(report.pass).toBe(true);
    expect(report.run.attempt).toBe(2);
    expect(report.run.resumedFromStage).toBe('documents');
    expect(report.run.resumedAfterDocumentId).toBe(4);
    expect(report.run.documentsSkippedAsAlreadyDone).toBe(4);
    expect(report.documents.delta).toBe(0);

    expect(
      recueil.db.select().from(schema.items).where(eq(schema.items.sourceSystem, 'paperless')).all(),
    ).toHaveLength(FIXTURE_EXPECTATIONS.documents);

    // Six documents were left: the resumed run downloaded those and not the four it already had.
    expect(downloadsSeen() - downloadsBefore).toBe(6);
  });

  it('produces the report an uninterrupted run would have produced', async () => {
    await importPaperless(recueil, {
      ...fixtureImportOptions(server),
      abortAfter: stopAfter(4),
    } as never).catch(() => undefined);
    const resumed = (await importPaperless(recueil, fixtureImportOptions(server) as never)).report;

    const fresh = makeLibrary();
    try {
      const straight = (
        await importPaperless(fresh, fixtureImportOptions(server) as never)
      ).report;

      expect(resumed.documents.recueilMatched).toBe(straight.documents.recueilMatched);
      expect(resumed.originals.attempted).toBe(straight.originals.attempted);
      expect(resumed.originals.stored).toBe(straight.originals.stored);
      expect(resumed.originals.distinctDocuments).toBe(straight.originals.distinctDocuments);
      expect(resumed.originals.missing).toBe(straight.originals.missing);
      expect(resumed.originals.checksumMismatches).toBe(straight.originals.checksumMismatches);
      expect(resumed.asn.recueilWithAsn).toBe(straight.asn.recueilWithAsn);
      expect(resumed.notes.recueilTotal).toBe(straight.notes.recueilTotal);
      expect(resumed.customFields.recueilValues).toBe(straight.customFields.recueilValues);

      // The observations of the first attempt are still there, which is why the review queue of a
      // resumed run is not shorter than an uninterrupted one's.
      expect(resumed.review.map((entry) => entry.kind).sort()).toStrictEqual(
        straight.review.map((entry) => entry.kind).sort(),
      );
      expect(resumed.skipped.map((entry) => entry.kind).sort()).toStrictEqual(
        straight.skipped.map((entry) => entry.kind).sort(),
      );
    } finally {
      fresh.dispose();
    }
  });

  it('survives being interrupted twice', async () => {
    await importPaperless(recueil, {
      ...fixtureImportOptions(server),
      abortAfter: stopAfter(2),
    } as never).catch(() => undefined);
    await importPaperless(recueil, {
      ...fixtureImportOptions(server),
      abortAfter: stopAfter(3),
    } as never).catch(() => undefined);

    const { report } = await importPaperless(recueil, fixtureImportOptions(server) as never);

    expect(report.run.attempt).toBe(3);
    expect(report.pass).toBe(true);
    expect(report.documents.recueilMatched).toBe(FIXTURE_EXPECTATIONS.documents);
    expect(report.originals.stored).toBe(FIXTURE_EXPECTATIONS.originalsStored);
  });

  it('re-reads the whole document list on a resume, so the report compares like with like', async () => {
    await importPaperless(recueil, {
      ...fixtureImportOptions(server),
      abortAfter: stopAfter(4),
    } as never).catch(() => undefined);

    const { report } = await importPaperless(recueil, fixtureImportOptions(server) as never);

    // A resumed run that only walked the tail would report `apiFetched: 6` and call the four it
    // skipped a loss.
    expect(report.documents.apiFetched).toBe(FIXTURE_EXPECTATIONS.documents);
    expect(report.documents.apiReportedTotal).toBe(FIXTURE_EXPECTATIONS.documents);
    expect(report.documents.missingInRecueil).toStrictEqual([]);
  });

  it('recovers from a mid-run server failure without losing what it had done', async () => {
    // The originals of documents 5 onwards become unreachable in a way retrying cannot fix.
    server.server.fail({ path: /\/api\/documents\/[5-9]\/metadata\//u, status: 500, times: 100 });
    server.server.fail({ path: /\/api\/documents\/[5-9]\/download\//u, status: 500, times: 100 });

    const partial = await importPaperless(recueil, {
      ...fixtureImportOptions(server),
      attempts: 1,
    } as never);

    // Nothing failed the run: the unreachable files are review entries (P3, CONCEPT §6).
    expect(partial.report.originals.stored).toBeLessThan(FIXTURE_EXPECTATIONS.documents);
    expect(partial.report.review.filter((entry) => entry.kind === 'original_unreadable').length).toBe(5);
    expect(partial.report.documents.delta).toBe(0);

    // And every item is there, with its facet, even though five files are not.
    expect(
      recueil.db.select().from(schema.itemOffice).all(),
    ).toHaveLength(FIXTURE_EXPECTATIONS.documents);
  });
});
