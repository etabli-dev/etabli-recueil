/**
 * The read-only guarantee.
 *
 * The user's `zotero.sqlite` is their only copy, and CONCEPT §6 keeps Zotero read-only until M1 is
 * confirmed. These tests are the ones that would catch a regression that matters more than any
 * count: they check that the handle refuses to write, that the refusal happens at more than one
 * layer, and that the file is byte-for-byte unchanged after a whole import has run over it.
 */
import { copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReadOnlyDatabase, ReadOnlyViolationError, fingerprintFile } from '../src/reader/readonly-db.js';
import { ZoteroLibrary } from '../src/reader/zotero-library.js';
import { importZoteroLibrary } from '../src/import.js';
import { ZOTERO_FIXTURE, fixtureImportOptions, makeLibrary, makeTempDirectory } from './helpers.js';
import type { TestLibrary } from './helpers.js';

describe('ReadOnlyDatabase', () => {
  it('opens a copy by default, leaving the original untouched', () => {
    const before = fingerprintFile(ZOTERO_FIXTURE.database);
    const db = new ReadOnlyDatabase(ZOTERO_FIXTURE.database);
    try {
      expect(db.openedPath).not.toBe(ZOTERO_FIXTURE.database);
      expect(db.sourcePath).toBe(ZOTERO_FIXTURE.database);
      expect(db.get<{ n: number }>('select count(*) as n from items')?.n).toBe(103);
    } finally {
      db.close();
    }
    expect(fingerprintFile(ZOTERO_FIXTURE.database)).toEqual(before);
  });

  it('refuses every statement that is not a read', () => {
    const db = new ReadOnlyDatabase(ZOTERO_FIXTURE.database);
    try {
      for (const statement of [
        "insert into items (itemTypeID, libraryID, key) values (1, 1, 'AAAAAAAA')",
        'delete from items',
        "update items set key = 'x'",
        'drop table items',
        'create table sneaky (a int)',
        'pragma query_only = 0',
        'pragma journal_mode = delete',
        'vacuum',
      ]) {
        expect(() => db.all(statement), statement).toThrow(ReadOnlyViolationError);
      }
    } finally {
      db.close();
    }
  });

  it('still refuses a write when the statement guard is bypassed, because SQLite is read-only too', () => {
    // `with … as (…) delete` passes the leading-keyword check; better-sqlite3's own `readonly`
    // flag is the second layer and catches it.
    const db = new ReadOnlyDatabase(ZOTERO_FIXTURE.database);
    try {
      expect(() => db.all('with doomed as (select itemID from items) delete from items')).toThrow();
    } finally {
      db.close();
    }
  });

  it('reads in place when asked, and still cannot write', () => {
    const temp = makeTempDirectory();
    try {
      const copy = join(temp.path, 'zotero.sqlite');
      copyFileSync(ZOTERO_FIXTURE.database, copy);
      const before = statSync(copy).mtimeMs;

      const db = new ReadOnlyDatabase(copy, { copy: false });
      try {
        expect(db.openedPath).toBe(copy);
        expect(() => db.all('delete from items')).toThrow(ReadOnlyViolationError);
      } finally {
        db.close();
      }
      expect(statSync(copy).mtimeMs).toBe(before);
    } finally {
      temp.dispose();
    }
  });

  it('refuses a file that is not a Zotero database', () => {
    const temp = makeTempDirectory();
    try {
      const path = join(temp.path, 'not-zotero.sqlite');
      copyFileSync(ZOTERO_FIXTURE.betterBibtex, path);
      expect(() => new ZoteroLibrary(path)).toThrow(/not a Zotero database/u);
    } finally {
      temp.dispose();
    }
  });
});

describe('a whole import', () => {
  let library: TestLibrary;

  beforeEach(() => {
    library = makeLibrary();
  });

  afterEach(() => {
    library.dispose();
  });

  it('leaves the Zotero database byte-for-byte unchanged, and says so in the report', async () => {
    const before = fingerprintFile(ZOTERO_FIXTURE.database);
    const { report } = await importZoteroLibrary(library, fixtureImportOptions());
    const after = fingerprintFile(ZOTERO_FIXTURE.database);

    expect(after.sha256).toBe(before.sha256);
    expect(after.byteSize).toBe(before.byteSize);
    expect(report.source.sourceUnchanged).toBe(true);
    expect(report.source.databaseSha256).toBe(before.sha256);
    expect(report.source.databaseSha256AfterRun).toBe(before.sha256);
  });
});
