/**
 * Migrations (`spec/data-model.md` §11).
 *
 * Two things are being asserted, and the second is the one that bites in production: that an empty
 * database comes up complete, and that running the migrator again changes nothing. The server runs
 * migrations on every boot, and a desktop shell boots several times a day.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { migrate, openDatabase } from '../src/index.js';

const PHASE_ONE_TABLES = [
  'users',
  'api_tokens',
  'documents',
  'document_provenance',
  'items',
  'item_bibliographic',
  'item_office',
  'attachments',
  'collections',
  'collection_items',
  'tags',
  'item_tags',
  'annotation_tags',
  'custom_fields',
  'field_values',
  'notes',
  'annotations',
  'creators',
  'item_creators',
  'jobs',
  'job_logs',
  'audit_log',
  'trash',
];

const temporaryRoots: string[] = [];

const temporaryDatabase = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'recueil-migrate-'));
  temporaryRoots.push(root);
  return join(root, 'library.sqlite');
};

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('migrate', () => {
  it('brings an empty database up to the Phase 1 schema', () => {
    const { db, connection } = openDatabase({ databaseUrl: temporaryDatabase() });
    migrate(db);

    const tables = connection
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const table of PHASE_ONE_TABLES) expect(tables).toContain(table);
    connection.close();
  });

  it('is safe to run repeatedly', () => {
    const file = temporaryDatabase();

    const first = openDatabase({ databaseUrl: file });
    migrate(first.db);
    const appliedAfterFirst = first.connection
      .prepare('select count(*) as n from __drizzle_migrations')
      .get() as { n: number };
    first.connection.close();

    const second = openDatabase({ databaseUrl: file });
    migrate(second.db);
    migrate(second.db);
    const appliedAfterThird = second.connection
      .prepare('select count(*) as n from __drizzle_migrations')
      .get() as { n: number };
    second.connection.close();

    expect(appliedAfterThird.n).toBe(appliedAfterFirst.n);
  });

  it('sets the pragmas §1.1 requires, foreign keys above all', () => {
    const { connection } = openDatabase({ databaseUrl: temporaryDatabase() });
    expect(connection.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(connection.pragma('journal_mode', { simple: true })).toBe('wal');
    connection.close();
  });

  it('enforces the partial unique index on document hashes (ux_documents_sha256)', () => {
    const { db, connection } = openDatabase({ databaseUrl: temporaryDatabase() });
    migrate(db);

    const insert = connection.prepare(
      `insert into documents (id, sha256, byte_size, mime_type, mime_source, storage_backend,
        storage_key, storage_ok, ocr_status, source_kind, source_detail, ingested_at, created_at,
        updated_at)
       values (?, ?, 1, 'application/pdf', 'sniffed', 'local', ?, 1, 'not_applicable', 'upload',
        '{}', '2026-08-22T09:00:00.000Z', '2026-08-22T09:00:00.000Z', '2026-08-22T09:00:00.000Z')`,
    );
    const digest = 'a'.repeat(64);
    insert.run('01J8F3Z9K4ABCDEFGHJKMNPQR1', digest, 'aa/aa/x');

    expect(() => insert.run('01J8F3Z9K4ABCDEFGHJKMNPQR2', digest, 'aa/aa/y')).toThrow(/UNIQUE/iu);
    connection.close();
  });

  it('makes the audit log append-only in the database, not only by convention (AL1)', () => {
    const { db, connection } = openDatabase({ databaseUrl: temporaryDatabase() });
    migrate(db);

    connection
      .prepare(
        `insert into audit_log (id, occurred_at, actor_type, action, entity_type, entity_id)
         values ('01J8F3Z9K4ABCDEFGHJKMNPQR3', '2026-08-22T09:00:00.000Z', 'system', 'item.created',
          'item', '01J8F3Z9K4ABCDEFGHJKMNPQR4')`,
      )
      .run();

    expect(() => connection.prepare("update audit_log set action = 'tampered'").run()).toThrow(
      /append-only/iu,
    );
    expect(() => connection.prepare('delete from audit_log').run()).toThrow(/append-only/iu);
    connection.close();
  });
});
