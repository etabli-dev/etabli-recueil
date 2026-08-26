/**
 * Re-importing over items a person has since put in the trash (P9, CONCEPT §7 M2).
 *
 * The Phase 2 review binned the two items whose `source_id` was `1` and `2` and ran the import
 * again. It threw:
 *
 *     ConflictError Item '01M0…' is in the trash; restore it before adding notes.
 *
 * out of `importPaperless` entirely. The job was marked `failed`, **no report object was returned
 * or written**, and because the run never advanced its cursor past the offending document, runs 3
 * and 4 failed identically at the identical document — `cursor: {"stage":"documents","index":0,
 * "lastDocumentId":0}`, for ever. An ordinary librarian action permanently bricked the importer and
 * with it the M2 exit artefact, which is a verification report that can be regenerated until it is
 * clean.
 *
 * So: a re-import over trashed items must complete and report them. It must also not restore them —
 * the trash is a decision a person made about their own library (P5) — and it must not write into
 * them, because that is what the services refuse.
 */
import { schema } from '@recueil/core';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importPaperless } from '../src/import.js';
import { fixtureImportOptions, makeLibrary, startFixtureServer } from './helpers.js';
import type { TestLibrary, TestServer } from './helpers.js';

let recueil: TestLibrary;
let server: TestServer;

const itemFor = (paperlessId: number) =>
  recueil.db
    .select()
    .from(schema.items)
    .where(
      and(
        eq(schema.items.sourceSystem, 'paperless'),
        eq(schema.items.sourceId, String(paperlessId)),
      ),
    )
    .get();

beforeEach(async () => {
  recueil = makeLibrary();
  server = await startFixtureServer();
});

afterEach(async () => {
  await server.close();
  recueil.dispose();
});

describe('a re-import over trashed items', () => {
  it('completes, reports them, and leaves them in the trash', async () => {
    const first = await importPaperless(recueil, fixtureImportOptions(server) as never);
    expect(first.report.pass).toBe(true);

    const binned = [1, 2].map((paperlessId) => {
      const item = itemFor(paperlessId);
      recueil.library.trashItem(item?.id as string, recueil.actor);
      return { paperlessId, itemId: item?.id as string };
    });

    // The whole point: it returns rather than throwing.
    const second = await importPaperless(recueil, {
      ...fixtureImportOptions(server),
      reportDirectory: recueil.reportDirectory,
    } as never);

    // The job finished, and a report exists to be read.
    const jobs = recueil.db.select().from(schema.jobs).all();
    expect(jobs.map((row) => row.state)).not.toContain('failed');
    expect(second.reportPaths).not.toBeNull();

    // The two documents are named, not counted as imported and not counted as missing.
    expect(second.report.documents.trashedInRecueil).toStrictEqual([1, 2]);
    expect(second.report.documents.apiFetched).toBe(10);
    expect(second.report.documents.apiActive).toBe(8);
    expect(second.report.documents.recueilMatched).toBe(8);
    expect(second.report.documents.missingInRecueil).toStrictEqual([]);
    expect(second.report.documents.delta).toBe(0);

    const entries = second.report.review.filter((row) => row.kind === 'item_in_trash');
    expect(entries.map((row) => row.paperlessId).sort()).toStrictEqual([1, 2]);
    for (const entry of entries) expect(entry.proposedAction).toMatch(/Restore the item/u);

    // The check that says so is informational — a trashed item is not a defect — but it is in the
    // table, so the exclusion above is visible rather than quietly subtracted from both sides.
    const check = second.report.checks.find((row) => row.name === 'items_not_in_trash');
    expect(check?.pass).toBe(false);
    expect(check?.blocking).toBe(false);
    expect(check?.actual).toBe(2);

    // Nothing was restored and nothing was written into them.
    for (const { itemId } of binned) {
      const item = recueil.db.select().from(schema.items).where(eq(schema.items.id, itemId)).get();
      expect(item?.trashedAt).not.toBeNull();
    }

    // Everything else still verifies.
    expect(second.report.pass).toBe(true);
  });

  it('stays green over three more runs, and moves its cursor every time', async () => {
    await importPaperless(recueil, fixtureImportOptions(server) as never);
    for (const paperlessId of [1, 2]) {
      recueil.library.trashItem(itemFor(paperlessId)?.id as string, recueil.actor);
    }

    for (const attempt of [2, 3, 4]) {
      const result = await importPaperless(recueil, fixtureImportOptions(server) as never);
      expect(result.report.pass, `run ${attempt} failed its checks`).toBe(true);
      expect(result.report.documents.trashedInRecueil).toStrictEqual([1, 2]);
    }

    // One job, four attempts, succeeded — not a job stuck at `{"index":0,"lastDocumentId":0}`.
    const jobs = recueil.db.select().from(schema.jobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe('succeeded');
    expect(jobs[0]?.attempts).toBe(4);
  });

  it('restores the parity the moment the item is restored', async () => {
    await importPaperless(recueil, fixtureImportOptions(server) as never);
    const itemId = itemFor(2)?.id as string;
    recueil.library.trashItem(itemId, recueil.actor);
    await importPaperless(recueil, fixtureImportOptions(server) as never);

    recueil.library.restoreItem(itemId, recueil.actor);
    const after = await importPaperless(recueil, fixtureImportOptions(server) as never);

    expect(after.report.documents.trashedInRecueil).toStrictEqual([]);
    expect(after.report.documents.apiActive).toBe(10);
    expect(after.report.documents.recueilMatched).toBe(10);
    expect(after.report.pass).toBe(true);
  });

  it('does not write a document link into an item that is in the trash', async () => {
    // Document 2 links to document 1. With document 1's item binned, the link has no live end, so
    // it is reported as unresolved rather than written as a foreign key into the trash.
    await importPaperless(recueil, fixtureImportOptions(server) as never);
    recueil.library.trashItem(itemFor(1)?.id as string, recueil.actor);

    const second = await importPaperless(recueil, fixtureImportOptions(server) as never);

    const link = second.report.review.find(
      (row) => row.kind === 'document_link_unresolved' && row.paperlessId === 2,
    );
    expect(link?.detail?.['unresolved']).toStrictEqual([1]);
  });
});
