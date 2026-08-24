/**
 * The blocking checks, tested by breaking the thing each one claims to detect.
 *
 * M4. Three of the report's blocking checks were structurally incapable of failing, and the report
 * is the M1 deliverable — the artefact that decides whether "own library imported at 100% item
 * count" is true. A check that cannot fail is worse than no check, because it reads as evidence.
 *
 * The two proofs below are the adversarial reviewer's own, turned into tests:
 *
 * 1. Rewrite every imported row's `item_type` to `article` in the **target** database and re-run.
 *    The old per-type check bucketed both sides by the importer's mapping output and never compared
 *    the stored value, so it passed over a library in which every record was the wrong kind.
 * 2. Add a Zotero group library with five items to the **source** database. Every reader filters
 *    `libraryID = 1`, so those rows were excluded from both sides of every count and the delta was
 *    structurally zero: 67 of 67, pass, with five items left behind in silence.
 *
 * A third case covers the attachment check, which counted the importer's own `job_logs` entries
 * rather than rows in the target's `attachments` table.
 *
 * Every one of these must make `report.pass` false. A test that only asserted the numbers were
 * present would be the same mistake one level up.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { schema } from '@recueil/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { importZoteroLibrary } from '../src/import.js';
import { ZoteroLibrary } from '../src/reader/zotero-library.js';
import { buildReport, readImportLog } from '../src/report/build.js';
import type { ZoteroImportReport } from '../src/report/types.js';
import { fixtureImportOptions, makeLibrary, makeTempDirectory, ZOTERO_FIXTURE } from './helpers.js';

const disposables: { dispose(): void }[] = [];

afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose();
});

const library = () => {
  const made = makeLibrary();
  disposables.push(made);
  return made;
};

const temporary = () => {
  const made = makeTempDirectory();
  disposables.push(made);
  return made.path;
};

const failed = (report: ZoteroImportReport): string[] =>
  report.checks.filter((check) => check.blocking && !check.pass).map((check) => check.name);

/**
 * A writable copy of the fixture library, with its companions.
 *
 * The fixture itself is never opened for writing: `fixtures/zotero/zotero.sqlite` is checked in and
 * every other test in this package reads it.
 */
const mutableSource = (mutate: (db: BetterSqlite3.Database) => void): string => {
  const into = temporary();
  const copy = join(into, 'zotero.sqlite');
  copyFileSync(ZOTERO_FIXTURE.database, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${ZOTERO_FIXTURE.database}${suffix}`)) {
      copyFileSync(`${ZOTERO_FIXTURE.database}${suffix}`, `${copy}${suffix}`);
    }
  }

  const db = new BetterSqlite3(copy);
  try {
    mutate(db);
  } finally {
    db.close();
  }
  return copy;
};

describe('a healthy import passes every blocking check', () => {
  it('is the baseline the failures below are measured against', async () => {
    const recueil = library();
    const { report } = await importZoteroLibrary(recueil, fixtureImportOptions());

    expect(failed(report)).toEqual([]);
    expect(report.pass).toBe(true);
    // The guard that matters: the checks are looking at something.
    expect(report.items.zoteroRegularTotal).toBeGreaterThan(0);
    expect(report.attachments.total).toBeGreaterThan(0);
    expect(report.source.libraries.map((row) => row.libraryID)).toEqual([1]);
    expect(report.source.itemsInOtherLibraries).toBe(0);
  }, 120_000);
});

describe('the stored item_type is compared, not narrated (M4b)', () => {
  it("fails when every target row's item_type has been rewritten to 'article'", async () => {
    const recueil = library();
    const first = await importZoteroLibrary(recueil, fixtureImportOptions());
    expect(first.report.pass).toBe(true);
    // The fixture has to hold more than one type, or rewriting them all would be a no-op.
    expect(new Set(first.report.items.byType.map((row) => row.recueilType)).size).toBeGreaterThan(1);

    recueil.db
      .update(schema.items)
      .set({ itemType: 'article' })
      .where(eq(schema.items.sourceSystem, 'zotero'))
      .run();

    const second = await importZoteroLibrary(recueil, fixtureImportOptions());

    expect(second.report.pass).toBe(false);
    expect(failed(second.report)).toContain('item_type_fidelity');
    expect(failed(second.report)).toContain('item_count_parity_per_type');
    expect(second.report.items.recueilMistyped).toBeGreaterThan(0);
    // And the count of what is right went down by exactly what went wrong.
    expect(second.report.items.recueilRegularTotal + second.report.items.recueilMistyped).toBe(
      second.report.items.zoteroRegularTotal,
    );
  }, 180_000);

  it('fails when a single row is the wrong type, not only when all of them are', async () => {
    const recueil = library();
    await importZoteroLibrary(recueil, fixtureImportOptions());

    const victim = recueil.db
      .select({ id: schema.items.id, itemType: schema.items.itemType })
      .from(schema.items)
      .where(eq(schema.items.sourceSystem, 'zotero'))
      .all()
      .find((row) => row.itemType !== 'dataset');
    expect(victim).toBeDefined();

    recueil.db
      .update(schema.items)
      .set({ itemType: 'dataset' })
      .where(eq(schema.items.id, victim!.id))
      .run();

    const { report } = await importZoteroLibrary(recueil, fixtureImportOptions());
    expect(report.pass).toBe(false);
    expect(report.items.recueilMistyped).toBe(1);
    expect(failed(report)).toContain('item_type_fidelity');
  }, 180_000);
});

describe('a library the run did not read is reported, never hidden (M4c)', () => {
  it('fails when the source holds a Zotero group library with items in it', async () => {
    const source = mutableSource((db) => {
      db.exec(`
        insert into libraries (libraryID, type, editable, filesEditable, version)
        values (2, 'group', 1, 1, 0);
        insert into groups (groupID, libraryID, name, description, version)
        values (9001, 2, 'Departmental reading', 'Shared with the group', 0);
      `);
      const journalArticle = db
        .prepare("select itemTypeID from itemTypes where typeName = 'journalArticle'")
        .pluck()
        .get() as number;
      const nextId = (db.prepare('select coalesce(max(itemID), 0) from items').pluck().get() as number) + 1;
      const insert = db.prepare(
        'insert into items (itemID, itemTypeID, libraryID, key, dateAdded, dateModified, clientDateModified)' +
          " values (?, ?, 2, ?, '2024-01-01 00:00:00', '2024-01-01 00:00:00', '2024-01-01 00:00:00')",
      );
      for (let index = 0; index < 5; index += 1) {
        insert.run(nextId + index, journalArticle, `GROUP${String(index).padStart(3, '0')}`);
      }
    });

    const recueil = library();
    const { report } = await importZoteroLibrary(recueil, fixtureImportOptions({ databasePath: source }));

    expect(report.pass).toBe(false);
    expect(failed(report)).toContain('source_libraries_covered');
    expect(report.source.itemsInOtherLibraries).toBe(5);

    const group = report.source.libraries.find((row) => row.libraryID === 2);
    expect(group).toMatchObject({ libraryID: 2, libraryType: 'group', imported: false, regularItems: 5 });

    // Reported as something a person has to decide, not merely as a number in a table.
    const entry = report.review.find((row) => row.kind === 'library');
    expect(entry?.subject).toContain('library 2');
    expect(entry?.reason).toContain('5 regular items');
  }, 180_000);

  it('still passes when the extra library is empty, because nothing was left behind', async () => {
    const source = mutableSource((db) => {
      db.exec(`
        insert into libraries (libraryID, type, editable, filesEditable, version)
        values (2, 'group', 1, 1, 0);
        insert into groups (groupID, libraryID, name, description, version)
        values (9002, 2, 'Empty group', '', 0);
      `);
    });

    const recueil = library();
    const { report } = await importZoteroLibrary(recueil, fixtureImportOptions({ databasePath: source }));

    expect(report.source.libraries.map((row) => row.libraryID)).toEqual([1, 2]);
    expect(report.source.itemsInOtherLibraries).toBe(0);
    expect(failed(report)).toEqual([]);
    expect(report.pass).toBe(true);
  }, 180_000);
});

describe('attachment records are counted in the target (M4a)', () => {
  /**
   * Rebuild the report over the target as it is now.
   *
   * The import is not re-run, because a re-run is idempotent and would put back whatever was
   * removed — which would test the importer's repair rather than the report's honesty. `plans` is
   * empty on purpose: the item and attachment checks must not need it, and passing `[]` proves it.
   */
  const rebuild = (recueil: ReturnType<typeof library>, jobId: string): ZoteroImportReport => {
    const zotero = new ZoteroLibrary(ZOTERO_FIXTURE.database);
    try {
      return buildReport({
        library: zotero,
        recueil,
        plans: [],
        log: readImportLog(recueil, jobId),
        betterBibtex: [],
        betterBibtexPath: null,
        sources: {
          storageDirectory: ZOTERO_FIXTURE.storage,
          linkedAttachmentBase: ZOTERO_FIXTURE.linkedAttachments,
        },
        run: {
          jobId,
          idempotencyKey: 'test',
          runLabel: 'test',
          startedAt: '2026-08-22T00:00:00.000Z',
          finishedAt: '2026-08-22T00:00:01.000Z',
          durationMs: 1000,
          attempt: 1,
          resumedFromStage: null,
        },
      });
    } finally {
      zotero.close();
    }
  };

  it('fails when an attachment row is deleted from the Recueil database', async () => {
    const recueil = library();
    const { report: first, jobId } = await importZoteroLibrary(recueil, fixtureImportOptions());
    expect(first.attachments.recueilAttachments).toBe(first.attachments.total);
    expect(first.attachments.total).toBeGreaterThan(0);

    // The report rebuilt over an untouched target says the same thing, which is the control: the
    // difference below is caused by the deletion and not by the rebuild.
    expect(rebuild(recueil, jobId).attachments.recueilAttachments).toBe(first.attachments.total);

    // Remove one row from the target and nothing else. The importer's `job_logs` still say the
    // attachment was carried, which is exactly why the old check could not notice.
    const doomed = recueil.db.select({ id: schema.attachments.id }).from(schema.attachments).all()[0];
    expect(doomed).toBeDefined();
    recueil.db.delete(schema.attachments).where(eq(schema.attachments.id, doomed!.id)).run();

    const after = rebuild(recueil, jobId);
    expect(after.attachments.recueilAttachments).toBe(first.attachments.total - 1);
    expect(after.attachments.recueilAttachmentsMissing).toHaveLength(1);
    expect(failed(after)).toContain('attachment_records_carried');
    expect(after.pass).toBe(false);
  }, 180_000);

  it('fails when every attachment row is deleted, however complete the job log is', async () => {
    const recueil = library();
    const { report: first, jobId } = await importZoteroLibrary(recueil, fixtureImportOptions());
    expect(first.attachments.recueilAttachments).toBeGreaterThan(0);

    recueil.db.delete(schema.attachments).run();

    const after = rebuild(recueil, jobId);
    // `job_logs` is untouched: every attachment still has a `resolved` observation with a
    // `recueilLinkMode` on it, which is the number the old check reported.
    expect(after.attachments.entries.filter((entry) => entry.recueilLinkMode !== null).length).toBe(
      first.attachments.total,
    );
    expect(after.attachments.recueilAttachments).toBe(0);
    expect(failed(after)).toContain('attachment_records_carried');
  }, 180_000);
});
