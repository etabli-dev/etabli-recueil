/**
 * Running the import twice must produce the library the first run produced (P9).
 *
 * Not "roughly the same": the same row counts, the same digests, and — this is the part that is
 * easy to get wrong — the same `items.version`. That column is the REST ETag, so a re-run that
 * rewrote every unchanged row would silently invalidate every client's conditional-write token, and
 * the library would look identical while every cached copy of it stopped working.
 */
import { schema } from '@recueil/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importPaperless } from '../src/import.js';
import { fixtureImportOptions, makeLibrary, startFixtureServer } from './helpers.js';
import type { TestLibrary, TestServer } from './helpers.js';

let recueil: TestLibrary;
let server: TestServer;

interface Census {
  items: number;
  documents: number;
  attachments: number;
  tags: number;
  tagAssignments: number;
  notes: number;
  customFields: number;
  fieldValues: number;
  office: number;
  versions: Record<string, number>;
  digests: string[];
}

const census = (): Census => ({
  items: recueil.db.select().from(schema.items).all().length,
  documents: recueil.db.select().from(schema.documents).all().length,
  attachments: recueil.db.select().from(schema.attachments).all().length,
  tags: recueil.db.select().from(schema.tags).all().length,
  tagAssignments: recueil.db.select().from(schema.itemTags).all().length,
  notes: recueil.db.select().from(schema.notes).all().length,
  customFields: recueil.db.select().from(schema.customFields).all().length,
  fieldValues: recueil.db.select().from(schema.fieldValues).all().length,
  office: recueil.db.select().from(schema.itemOffice).all().length,
  versions: Object.fromEntries(
    recueil.db
      .select({ sourceId: schema.items.sourceId, version: schema.items.version })
      .from(schema.items)
      .all()
      .map((row) => [row.sourceId ?? '', row.version]),
  ),
  digests: recueil.db
    .select({ sha256: schema.documents.sha256 })
    .from(schema.documents)
    .all()
    .map((row) => row.sha256)
    .sort(),
});

beforeEach(async () => {
  recueil = makeLibrary();
  server = await startFixtureServer();
});

afterEach(async () => {
  await server.close();
  recueil.dispose();
});

describe('a second run', () => {
  it('changes nothing at all', async () => {
    const first = await importPaperless(recueil, fixtureImportOptions(server) as never);
    const before = census();

    const second = await importPaperless(recueil, fixtureImportOptions(server) as never);
    const after = census();

    expect(after).toStrictEqual(before);
    expect(second.report.pass).toBe(true);
    expect(second.report.documents.delta).toBe(0);
    expect(second.jobId).toBe(first.jobId);
  });

  it('is the same job, on its second attempt', async () => {
    await importPaperless(recueil, fixtureImportOptions(server) as never);
    await importPaperless(recueil, fixtureImportOptions(server) as never);

    const jobs = recueil.db.select().from(schema.jobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.attempts).toBe(2);
    expect(jobs[0]?.state).toBe('succeeded');
  });

  it('starts a separate job under a different run label (IK1)', async () => {
    await importPaperless(recueil, fixtureImportOptions(server) as never);
    await importPaperless(recueil, fixtureImportOptions(server, { runLabel: 'second' }) as never);

    const jobs = recueil.db.select().from(schema.jobs).all();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((row) => row.idempotencyKey).sort()).toStrictEqual([
      expect.stringMatching(/:default$/u),
      expect.stringMatching(/:second$/u),
    ]);
  });

  it('re-observes everything, so the second report is as complete as the first', async () => {
    const first = await importPaperless(recueil, fixtureImportOptions(server) as never);
    const second = await importPaperless(recueil, fixtureImportOptions(server) as never);

    expect(second.report.originals.attempted).toBe(first.report.originals.attempted);
    expect(second.report.originals.stored).toBe(first.report.originals.stored);
    expect(second.report.review.map((entry) => entry.kind).sort()).toStrictEqual(
      first.report.review.map((entry) => entry.kind).sort(),
    );
  });

  it('picks up a document added between the two runs', async () => {
    await importPaperless(recueil, fixtureImportOptions(server) as never);

    server.library.documents.push({
      id: 42,
      correspondent: 1,
      document_type: 1,
      title: 'Nachzügler',
      tags: [1],
      created: '2025-01-01',
      modified: '2025-01-01T12:00:00.000000+01:00',
      added: '2025-01-01T12:00:00.000000+01:00',
      deleted_at: null,
      archive_serial_number: 2001,
      original_file_name: 'Nachzuegler.pdf',
      mime_type: 'application/pdf',
      notes: [],
      custom_fields: [],
    });
    server.library.originals.set(42, { bytes: Buffer.from('%PDF-1.7\nlate\n%%EOF\n', 'utf8') });

    const second = await importPaperless(recueil, fixtureImportOptions(server) as never);

    expect(second.report.documents.apiFetched).toBe(11);
    expect(second.report.documents.delta).toBe(0);
    expect(second.report.pass).toBe(true);

    const late = recueil.db
      .select()
      .from(schema.items)
      .where(eq(schema.items.sourceId, '42'))
      .get();
    expect(late?.title).toBe('Nachzügler');
  });

  it('brings a changed document into line, and bumps only that item’s version', async () => {
    await importPaperless(recueil, fixtureImportOptions(server) as never);
    const before = census();

    const document = server.library.documents.find((row) => row.id === 4);
    if (document !== undefined) document.title = 'Kontoauszug Februar 2024 (korrigiert)';

    await importPaperless(recueil, fixtureImportOptions(server) as never);
    const after = census();

    expect(after.versions['4']).toBe((before.versions['4'] as number) + 1);
    for (const [sourceId, version] of Object.entries(before.versions)) {
      if (sourceId === '4') continue;
      expect(after.versions[sourceId]).toBe(version);
    }

    const changed = recueil.db.select().from(schema.items).where(eq(schema.items.sourceId, '4')).get();
    expect(changed?.title).toBe('Kontoauszug Februar 2024 (korrigiert)');
  });

  it('notices a document deleted in Paperless rather than tidying it away', async () => {
    await importPaperless(recueil, fixtureImportOptions(server) as never);

    server.library.documents = server.library.documents.filter((row) => row.id !== 9);
    const second = await importPaperless(recueil, fixtureImportOptions(server) as never);

    expect(second.report.documents.orphanedInRecueil).toHaveLength(1);
    const check = second.report.checks.find((row) => row.name === 'no_orphaned_items');
    expect(check?.pass).toBe(false);
    expect(check?.blocking).toBe(false);

    // The item is still there: deleting a person's record is not an importer's decision (P5).
    expect(recueil.db.select().from(schema.items).where(eq(schema.items.sourceId, '9')).get()).toBeDefined();
  });
});
