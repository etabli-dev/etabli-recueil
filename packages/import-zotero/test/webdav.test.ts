/**
 * The two attachment layouts that are not "files sitting in `storage/`".
 *
 * A WebDAV-synced library keeps its stored files as `<KEY>.zip` on the server and frequently has no
 * local `storage/` at all, and a library that uses Zotero's linked-file feature keeps them outside
 * the data directory entirely. CONCEPT §6 names both — "storage directory or WebDAV zips" — so both
 * get an end-to-end import rather than only a unit test of the resolver.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { schema } from '@recueil/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importZoteroLibrary } from '../src/import.js';
import { crc32 } from '../src/zip.js';
import { ZOTERO_FIXTURE, fixtureImportOptions, makeLibrary, makeTempDirectory } from './helpers.js';
import type { TestLibrary } from './helpers.js';

/** Rewrite the fixture's `storage/<KEY>/<file>` tree as the `<KEY>.zip` files WebDAV sync writes. */
const buildWebdavMirror = (into: string): void => {
  mkdirSync(into, { recursive: true });
  for (const key of readdirSync(ZOTERO_FIXTURE.storage)) {
    const files = readdirSync(join(ZOTERO_FIXTURE.storage, key));
    const name = files[0];
    if (name === undefined) continue;
    writeZip(join(into, `${key}.zip`), name, readFileSync(join(ZOTERO_FIXTURE.storage, key, name)));
  }
};

const writeZip = (path: string, name: string, bytes: Buffer): void => {
  const nameBytes = Buffer.from(name, 'utf8');
  const payload = deflateRawSync(bytes);
  const crc = crc32(bytes);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const offset = local.length + nameBytes.length + payload.length;
  const directory = Buffer.concat([central, nameBytes]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  writeFileSync(path, Buffer.concat([local, nameBytes, payload, directory, end]));
};

let library: TestLibrary;
let temp: { path: string; dispose(): void };

beforeEach(() => {
  library = makeLibrary();
  temp = makeTempDirectory();
});

afterEach(() => {
  library.dispose();
  temp.dispose();
});

describe('a library whose files are WebDAV zips', () => {
  it('imports the same documents as one whose files are in storage/', async () => {
    const webdav = join(temp.path, 'webdav');
    buildWebdavMirror(webdav);

    const { report } = await importZoteroLibrary(
      library,
      fixtureImportOptions({
        // No local storage directory at all: this is what a WebDAV-only library looks like.
        storageDirectory: join(temp.path, 'absent-storage'),
        webdavDirectory: webdav,
      }),
    );

    expect(report.pass).toBe(true);
    expect(report.items.delta).toBe(0);

    // Every stored file arrives out of a zip; the one Zotero has no file for is still missing, and
    // the linked file is still where it always was.
    const fromZips = report.attachments.entries.filter((entry) => entry.origin === 'webdav');
    expect(fromZips.length).toBe(readdirSync(ZOTERO_FIXTURE.storage).length);
    expect(report.attachments.missing).toBe(2);
    expect(report.attachments.entries.filter((entry) => entry.origin === 'linked')).toHaveLength(1);
    for (const entry of fromZips) {
      expect(entry.sha256, entry.zoteroKey).toMatch(/^[0-9a-f]{64}$/u);
      expect(entry.matchesZoteroHash, entry.zoteroKey).toBe(true);
    }

    // The digests are the digests of the bytes, whichever route they arrived by (ADR-0004).
    const expectedDigests = readdirSync(ZOTERO_FIXTURE.storage).map((key) => {
      const name = readdirSync(join(ZOTERO_FIXTURE.storage, key))[0] as string;
      return createHash('sha256')
        .update(readFileSync(join(ZOTERO_FIXTURE.storage, key, name)))
        .digest('hex');
    });
    const stored = library.db.select({ sha256: schema.documents.sha256 }).from(schema.documents).all();
    for (const digest of expectedDigests) {
      expect(stored.map((row) => row.sha256), digest).toContain(digest);
    }
  }, 120_000);
});

describe('linkedFilePolicy', () => {
  it('stores a linked file by default, and records where it came from', async () => {
    const { report } = await importZoteroLibrary(library, fixtureImportOptions());
    const linked = report.attachments.entries.find((entry) => entry.origin === 'linked');
    expect(linked?.recueilLinkMode).toBe('stored');

    const row = library.db
      .select({ linkMode: schema.attachments.linkMode, linkedPath: schema.attachments.linkedPath })
      .from(schema.attachments)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.attachments.documentId))
      .where(eq(schema.documents.sha256, linked!.sha256!))
      .get();
    expect(row?.linkMode).toBe('stored');
    expect(row?.linkedPath).toContain('weiss-2018-sonderdruck.pdf');
  }, 120_000);

  it('keeps a linked file as a link when asked, and still hashes it for the report', async () => {
    const { report } = await importZoteroLibrary(
      library,
      fixtureImportOptions({ linkedFilePolicy: 'link' }),
    );

    const linked = report.attachments.entries.find((entry) => entry.origin === 'linked');
    expect(linked).toMatchObject({ status: 'resolved', recueilLinkMode: 'linked_file' });
    expect(linked?.sha256).toMatch(/^[0-9a-f]{64}$/u);

    // The bytes stay outside the store, so there is one document fewer than under `store`.
    const documents = library.db.select({ id: schema.documents.id }).from(schema.documents).all();
    expect(documents).toHaveLength(report.attachments.distinctDocuments - 1);
    expect(report.pass).toBe(true);
  }, 120_000);
});
