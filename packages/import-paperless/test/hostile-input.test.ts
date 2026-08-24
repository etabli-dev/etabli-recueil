/**
 * Everything the server sends is hostile until it has been checked.
 *
 * A Paperless install is trusted in the sense that its owner runs it. Its *contents* are not: a
 * filename, a title, a tag name and a custom-field value are all strings a person typed, and a
 * pagination link is a URL a reverse proxy composed. This file is the list of places where one of
 * those could become a path, a request to somewhere else, or a credential in someone else's log —
 * and the proof that none of them does.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { schema } from '@recueil/core';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importPaperless } from '../src/import.js';
import { fakePdf, fixtureLibrary } from '../src/testing/fixtures.js';
import { fixtureImportOptions, makeLibrary, startFixtureServer } from './helpers.js';
import type { TestLibrary, TestServer } from './helpers.js';

let recueil: TestLibrary;
let server: TestServer;

const everyFileUnder = (root: string): string[] => {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
};

beforeEach(() => {
  recueil = makeLibrary();
});

afterEach(async () => {
  if (server !== undefined) await server.close();
  recueil.dispose();
});

describe('filenames', () => {
  it('never writes a file outside the content-addressed store', async () => {
    const library = fixtureLibrary();
    // Four different shapes of the same idea, on four different documents.
    (library.documents[0] as { original_file_name?: string }).original_file_name =
      '../../../../../../tmp/recueil-escape-1.pdf';
    (library.documents[1] as { original_file_name?: string }).original_file_name =
      '/etc/recueil-escape-2.pdf';
    (library.documents[3] as { original_file_name?: string }).original_file_name =
      'C:\\Windows\\recueil-escape-3.pdf';
    library.originals.set(1, { bytes: fakePdf('escape-1'), filename: '../../escape.pdf' });

    server = await startFixtureServer({}, library);
    await importPaperless(recueil, fixtureImportOptions(server) as never);

    for (const path of everyFileUnder(recueil.storageRoot)) {
      expect(path.startsWith(recueil.storageRoot)).toBe(true);
      expect(path).not.toContain('escape');
      // `<root>/<aa>/<bb>/<sha256>`, and nothing else.
      expect(path.slice(recueil.storageRoot.length)).toMatch(
        /^[/\\][0-9a-f]{2}[/\\][0-9a-f]{2}[/\\][0-9a-f]{64}$/u,
      );
    }
  });

  it('reduces a hostile original_file_name to a basename before storing it', async () => {
    const library = fixtureLibrary();
    (library.documents[0] as { original_file_name?: string }).original_file_name =
      '../../../../etc/passwd';

    server = await startFixtureServer({}, library);
    await importPaperless(recueil, fixtureImportOptions(server) as never);

    const item = recueil.db
      .select()
      .from(schema.items)
      .where(and(eq(schema.items.sourceSystem, 'paperless'), eq(schema.items.sourceId, '1')))
      .get();
    const document = recueil.db
      .select({
        originalFilename: schema.documents.originalFilename,
        sourceDetail: schema.documents.sourceDetail,
      })
      .from(schema.attachments)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.attachments.documentId))
      .where(eq(schema.attachments.itemId, item?.id as string))
      .get();

    expect(document?.originalFilename).toBe('passwd');
    expect(document?.originalFilename).not.toContain('..');

    // Nothing is lost: the string Paperless sent is kept where it is data, not a path.
    const provenance = recueil.db
      .select({ sourceDetail: schema.documentProvenance.sourceDetail })
      .from(schema.documentProvenance)
      .where(eq(schema.documentProvenance.sourceRef, 'paperless:document:1'))
      .get();
    expect(provenance?.sourceDetail).toContain('../../../../etc/passwd');
  });

  it('does not let a hostile title escape the review directory', async () => {
    const library = fixtureLibrary();
    // Document 5's original is the one that 404s, so this title reaches a review filename.
    (library.documents[4] as { title: string }).title = '../../../../etc/cron.d/evil';

    server = await startFixtureServer({}, library);
    const { reportPaths } = await importPaperless(recueil, {
      ...fixtureImportOptions(server),
      reportDirectory: recueil.reportDirectory,
    } as never);

    for (const path of everyFileUnder(reportPaths?.review as string)) {
      expect(path.startsWith(reportPaths?.review as string)).toBe(true);
      expect(path).not.toContain('cron.d');
    }
  });
});

describe('names that are not slugs', () => {
  it('accepts a document type and a custom field whose names are punctuation', async () => {
    const library = fixtureLibrary();
    library.documentTypes.push({ id: 9, name: '!!! ??? ###' });
    library.customFields.push({ id: 20, name: '***', data_type: 'string' });
    library.customFields.push({ id: 21, name: '///', data_type: 'string' });
    (library.documents[2] as { document_type: number | null }).document_type = 9;
    (library.documents[2] as { custom_fields?: unknown[] }).custom_fields = [
      { field: 20, value: 'eins' },
      { field: 21, value: 'zwei' },
    ];

    server = await startFixtureServer({}, library);
    const { report } = await importPaperless(recueil, fixtureImportOptions(server) as never);

    expect(report.pass).toBe(true);
    for (const field of recueil.db.select().from(schema.customFields).all()) {
      expect(field.fieldKey).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
    for (const item of recueil.db.select().from(schema.items).all()) {
      expect(item.itemType).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
    for (const office of recueil.db.select().from(schema.itemOffice).all()) {
      if (office.officeDocumentType === null) continue;
      expect(office.officeDocumentType).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
  });

  it('gives two fields whose names slug the same two distinct keys', async () => {
    const library = fixtureLibrary();
    library.customFields.push({ id: 30, name: 'Müller', data_type: 'string' });
    library.customFields.push({ id: 31, name: 'Mueller', data_type: 'string' });
    (library.documents[2] as { custom_fields?: unknown[] }).custom_fields = [
      { field: 30, value: 'mit Umlaut' },
      { field: 31, value: 'ohne Umlaut' },
    ];

    server = await startFixtureServer({}, library);
    await importPaperless(recueil, fixtureImportOptions(server) as never);

    const keys = recueil.db
      .select({ fieldKey: schema.customFields.fieldKey })
      .from(schema.customFields)
      .all()
      .map((row) => row.fieldKey);
    expect(keys).toContain('mueller');
    expect(keys).toContain('mueller_2');

    const item = recueil.db.select().from(schema.items).where(eq(schema.items.sourceId, '3')).get();
    const values = recueil.customFields.listValues(item?.id as string);
    expect(values.filter((value) => value.field.fieldKey.startsWith('mueller'))).toHaveLength(2);
  });
});

describe('the credential', () => {
  it('is never written to the job record, the log or the report', async () => {
    server = await startFixtureServer();
    const { report } = await importPaperless(recueil, fixtureImportOptions(server) as never);

    const job = recueil.db.select().from(schema.jobs).get();
    expect(JSON.stringify(job)).not.toContain(server.token);

    const logs = recueil.db.select().from(schema.jobLogs).all();
    expect(JSON.stringify(logs)).not.toContain(server.token);

    expect(JSON.stringify(report)).not.toContain(server.token);

    const audit = recueil.db.select().from(schema.auditLog).all();
    expect(JSON.stringify(audit)).not.toContain(server.token);
  });

  it('is refused in the base URL, where it would leak into every log', async () => {
    server = await startFixtureServer();
    const url = new URL(server.baseUrl);
    await expect(
      importPaperless(recueil, {
        baseUrl: `${url.protocol}//user:secret@${url.host}`,
        token: server.token,
      } as never),
    ).rejects.toThrow(/token/iu);
  });
});
