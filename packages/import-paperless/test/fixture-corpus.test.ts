/**
 * The importer against the repository's committed Paperless corpus — `fixtures/paperless/`.
 *
 * `import.test.ts` runs against `src/testing/fixtures.ts`, a library written by the same hand as
 * the importer. That is the right shape for testing a decision in isolation and the wrong shape for
 * the M2 exit criterion, which is "Paperless decommissioned after verified import": a report whose
 * only corroboration is a fixture the importer's own author wrote is a report that agrees with
 * itself.
 *
 * `fixtures/paperless/` is the other side. Its counts were written by hand in
 * `fixtures/lib/paperless.mjs` before the generator ran, `fixtures/expected-counts.json` publishes
 * them, and a generator that disagreed with them refuses to finish. So every number below is
 * compared against a figure that was fixed before this importer read a byte of it.
 *
 * Both sides of every comparison are a query: the Paperless side is the committed dump (or the
 * manifest that describes it), the Recueil side is the target library's own tables through the
 * report, which `report/build.ts` populates by querying `items`, `documents`, `tags` and
 * `item_office` rather than by counting the run's own log.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import { schema } from '@recueil/core';

import { PaperlessApiVersionError } from '../src/client/errors.js';
import { importPaperless } from '../src/import.js';
import { DATA_TYPE_MAP } from '../src/map/custom-fields.js';
import { FakePaperlessServer } from '../src/testing/fake-server.js';
import { FIXTURE_TOKEN } from '../src/testing/fixtures.js';
import { paperlessFixtureCorpus } from '../src/testing/fixture-corpus.js';
import type { PaperlessFixtureCorpus } from '../src/testing/fixture-corpus.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

const FIXTURES = resolve(fileURLToPath(new URL('../../../fixtures', import.meta.url)));

const corpus: PaperlessFixtureCorpus = paperlessFixtureCorpus(FIXTURES);
const EXPECTED = corpus.expected;

let library: TestLibrary;
let server: FakePaperlessServer;

beforeEach(async () => {
  library = makeLibrary();
  server = await FakePaperlessServer.start(corpus.library, {
    token: FIXTURE_TOKEN,
    faults: corpus.faults,
    // The corpus's own page size, so the pagination the route table describes is the pagination the
    // importer walks.
    defaultPageSize: corpus.manifest.pageSize,
  });
});

afterEach(async () => {
  await server.close();
  library.dispose();
});

const runImport = async () =>
  importPaperless(library, {
    baseUrl: server.url,
    token: FIXTURE_TOKEN,
    pageSize: corpus.manifest.pageSize,
    reportDirectory: library.reportDirectory,
    runLabel: 'fixtures/paperless',
  });

describe('the committed corpus', () => {
  it('is the corpus expected-counts.json describes, before anything imports it', () => {
    // A guard on the loader itself: if it dropped a record on the way in, every count below would
    // still agree with a smaller library and prove nothing.
    expect(corpus.library.documents).toHaveLength(EXPECTED.documents.live);
    expect(corpus.library.tags).toHaveLength(EXPECTED.tags.total);
    expect(corpus.library.correspondents).toHaveLength(EXPECTED.correspondents.total);
    expect(corpus.library.documentTypes).toHaveLength(EXPECTED.documentTypes.total);
    expect(corpus.library.storagePaths).toHaveLength(EXPECTED.storagePaths.total);
    expect(corpus.library.customFields).toHaveLength(EXPECTED.customFields.total);
    expect(corpus.manifest.routes).toHaveLength(EXPECTED.routes);

    // The originals, hashed here rather than trusted from the manifest.
    const digests = EXPECTED.originals.contents.map((entry) => {
      const bytes = readFileSync(join(FIXTURES, entry.path));
      expect(bytes.length, `${entry.path} is not the size the manifest states`).toBe(entry.bytes);
      return createHash('sha256').update(bytes).digest('hex');
    });
    expect(digests).toEqual(EXPECTED.originals.contents.map((entry) => entry.sha256));
    expect(new Set(digests).size).toBe(EXPECTED.originals.distinctHashes);

    // One download the route table refuses, and one document with a hostile original filename.
    expect(corpus.unfetchable.map((entry) => entry.id)).toEqual(
      EXPECTED.documents.unfetchable.map((entry) => entry.id),
    );
    for (const hostile of EXPECTED.documents.hostileFilenames) {
      const document = corpus.library.documents.find((row) => row.id === hostile.id);
      expect(document?.original_file_name).toBe(hostile.originalFileName);
    }
  });
});

describe('importing it', () => {
  it('reaches document parity with the corpus, counted from the target’s own tables', async () => {
    const { report } = await runImport();

    expect(report.documents.apiReportedTotal).toBe(EXPECTED.documents.live);
    expect(report.documents.apiFetched).toBe(EXPECTED.documents.live);
    expect(report.documents.recueilTotal).toBe(EXPECTED.documents.live);
    expect(report.documents.recueilMatched).toBe(EXPECTED.documents.live);
    expect(report.documents.recueilMistyped).toBe(0);
    expect(report.documents.missingInRecueil).toEqual([]);
    expect(report.documents.orphanedInRecueil).toEqual([]);
    expect(report.documents.delta).toBe(0);

    // Read again, straight from the library, so the report is not the only witness.
    const items = library.db
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(and(eq(schema.items.sourceSystem, 'paperless'), isNull(schema.items.trashedAt)))
      .all();
    expect(items).toHaveLength(EXPECTED.documents.live);
  });

  it('carries every tag, correspondent, document type and custom field across', async () => {
    const { report } = await runImport();

    expect(report.tags.apiTotal).toBe(EXPECTED.tags.total);
    expect(report.tags.recueilTotal).toBe(EXPECTED.tags.total);
    expect(report.tags.missingInRecueil).toEqual([]);
    expect(report.tags.inboxTags).toBe(EXPECTED.tags.inbox);
    expect(report.tags.recueilAssignments).toBe(report.tags.apiAssignments - report.tags.skippedAssignments);

    expect(report.correspondents.apiTotal).toBe(EXPECTED.correspondents.total);
    expect(report.correspondents.withoutCorrespondent).toBe(EXPECTED.documents.withoutCorrespondent);
    expect(report.documentTypes.apiTotal).toBe(EXPECTED.documentTypes.total);
    expect(report.customFields.apiTotal).toBe(EXPECTED.customFields.total);
    // The report buckets by the *Recueil* data type, so the corpus's Paperless types are put
    // through the same map the importer used rather than compared to a different vocabulary.
    const mapped: Record<string, number> = {};
    for (const [paperlessType, count] of Object.entries(EXPECTED.customFields.byDataType)) {
      const recueilType = DATA_TYPE_MAP[paperlessType as keyof typeof DATA_TYPE_MAP];
      expect(recueilType, `the corpus uses '${paperlessType}', which the importer cannot map`).toBeTypeOf(
        'string',
      );
      mapped[recueilType] = (mapped[recueilType] ?? 0) + count;
    }
    expect(report.customFields.byDataType).toEqual(mapped);
    expect(report.notes.apiTotal).toBe(EXPECTED.documents.withNotes);
    expect(report.notes.recueilTotal).toBe(EXPECTED.documents.withNotes);

    // Every data type the corpus uses is one the importer knows; a corpus that grew a new one would
    // show up here rather than as a quietly dropped column.
    expect(report.customFields.unsupported).toEqual([]);
    const dataTypes = new Set(corpus.library.customFields.map((field) => field.data_type));
    expect([...dataTypes].sort()).toEqual(Object.keys(EXPECTED.customFields.byDataType).sort());
  });

  it('files the ASNs the corpus carries, and says which collided', async () => {
    const { report } = await runImport();

    expect(report.asn.apiWithAsn).toBe(EXPECTED.documents.withAsn);

    const withAsn = library.db
      .select({ id: schema.itemOffice.itemId })
      .from(schema.itemOffice)
      .innerJoin(schema.items, eq(schema.items.id, schema.itemOffice.itemId))
      .where(and(isNotNull(schema.itemOffice.asn), isNull(schema.items.trashedAt)))
      .all();
    expect(withAsn.length).toBe(report.asn.recueilWithAsn);
    // The corpus has no duplicate ASN, so nothing should have been dropped on the way in.
    expect(report.asn.recueilWithAsn).toBe(EXPECTED.documents.withAsn);
    expect(report.asn.collisions).toEqual([]);
  });

  it('routes the one original the server refuses to review, and imports the item anyway', async () => {
    const { report } = await runImport();

    const refused = EXPECTED.documents.unfetchable;
    expect(refused).toHaveLength(1);
    const [only] = refused;

    expect(report.originals.attempted).toBe(EXPECTED.documents.live);
    expect(report.originals.stored).toBe(EXPECTED.documents.live - refused.length);

    const failure = report.originals.entries.find((entry) => entry.paperlessId === only!.id);
    expect(failure, `the report says nothing about document ${String(only!.id)}`).toBeDefined();
    expect(failure!.status).not.toBe('stored');

    // P5 and P3: the item is in the library, and the reason its file is missing is queued for a
    // person rather than dropped.
    const item = library.db
      .select({ id: schema.items.id })
      .from(schema.items)
      .where(eq(schema.items.sourceId, String(only!.id)))
      .all();
    expect(item).toHaveLength(1);
    expect(report.review.some((entry) => entry.paperlessId === only!.id)).toBe(true);
  });

  it('never lets a hostile original_file_name reach a path', async () => {
    await runImport();

    const hostile = EXPECTED.documents.hostileFilenames[0]!;
    const rows = library.db
      .select({ filename: schema.documents.originalFilename, key: schema.documents.storageKey })
      .from(schema.documents)
      .all();

    for (const row of rows) {
      expect(row.filename ?? '', 'a traversal survived into original_filename').not.toContain('..');
      // The key is content-addressed, so nothing a server said can steer it (P2, ADR-0004).
      expect(row.key).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/u);
    }
    expect(hostile.originalFileName).toContain('..');
  });

  it('deduplicates the two documents that share their bytes', async () => {
    await runImport();

    const digests = library.db
      .select({ sha256: schema.documents.sha256 })
      .from(schema.documents)
      .all()
      .map((row) => row.sha256);

    // What the store *should* hold, computed from the manifest rather than asserted as a literal:
    // the digests of the originals belonging to documents this import actually fetches — the live
    // ones, less the one the server refuses.
    const live = new Set(corpus.library.documents.map((row) => row.id));
    const refused = new Set(corpus.unfetchable.map((entry) => entry.id));
    const fetchable = EXPECTED.originals.contents.filter((entry) => {
      const id = Number(/(\d+)\.[a-z]+$/u.exec(entry.path)?.[1]);
      return live.has(id) && !refused.has(id);
    });
    expect(fetchable.length).toBe(EXPECTED.documents.live - refused.size);

    const expectedDistinct = new Set(fetchable.map((entry) => entry.sha256));
    expect(expectedDistinct.size, 'the corpus has no duplicate original left to test with').toBeLessThan(
      fetchable.length,
    );
    expect(new Set(digests)).toEqual(expectedDistinct);
  });

  it('is idempotent: a second import of the same corpus does not double the library', async () => {
    await runImport();
    const after = await importPaperless(library, {
      baseUrl: server.url,
      token: FIXTURE_TOKEN,
      pageSize: corpus.manifest.pageSize,
      runLabel: 'fixtures/paperless (again)',
    });

    expect(after.report.documents.recueilTotal).toBe(EXPECTED.documents.live);
    expect(after.report.documents.delta).toBe(0);
  });

  it('states which Paperless release it was modelled against, next to the one it spoke to', async () => {
    const { report } = await runImport();

    // The corpus declares an older release than `client/types.ts` was transcribed from. The report
    // has to say so rather than let a reader assume the two agree: this is the field that tells
    // them how much of the report is a claim about *their* server.
    expect(report.source.modelledAgainstVersion).toBeTypeOf('string');
    expect(corpus.manifest.paperlessVersion).toBe(EXPECTED.paperlessVersion);
    expect(corpus.manifest.paperlessVersion).not.toBe(report.source.modelledAgainstVersion);

    // And be explicit about what the run above therefore is and is not. The fake advertises the
    // release `client/types.ts` was transcribed from, so the report's `versionMatchesModel` is a
    // property of the fake and not of the corpus. The corpus's own declared release is tested
    // separately, below, and this importer cannot talk to it.
    expect(report.source.versionMatchesModel).toBe(true);
    expect(Number(corpus.manifest.apiVersion)).toBeLessThan(Number(report.source.requestedApiVersion));
  });

  it('refuses the API version the corpus itself declares, rather than half-reading it', async () => {
    // `fixtures/paperless/index.json` says the dump was modelled on Paperless-ngx 2.14.7, whose
    // `ALLOWED_VERSIONS` stops at 6. This client asks for 10. Standing the same data up behind
    // those headers is the only way to find out what happens on the day, and what happens is a
    // named refusal — not a partial import against an envelope the client is guessing at.
    const older = await FakePaperlessServer.start(corpus.library, {
      token: FIXTURE_TOKEN,
      version: corpus.manifest.paperlessVersion,
      allowedApiVersions: [String(corpus.manifest.apiVersion)],
      defaultApiVersion: String(corpus.manifest.apiVersion),
      defaultPageSize: corpus.manifest.pageSize,
    });

    try {
      const attempt = importPaperless(library, {
        baseUrl: older.url,
        token: FIXTURE_TOKEN,
        pageSize: corpus.manifest.pageSize,
        attempts: 1,
        runLabel: 'against the release the corpus declares',
      });
      await expect(attempt).rejects.toBeInstanceOf(PaperlessApiVersionError);

      // Nothing was written on the way to that refusal.
      const items = library.db.select({ id: schema.items.id }).from(schema.items).all();
      expect(items).toEqual([]);
    } finally {
      await older.close();
    }
  }, 60_000);
});
