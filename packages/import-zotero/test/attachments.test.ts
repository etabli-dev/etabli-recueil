/**
 * Finding the bytes behind an attachment.
 *
 * The four Zotero link modes, the WebDAV fallback, and every way a file can fail to be there. The
 * failures matter as much as the successes: P3 says a missing file produces a reason rather than an
 * exception, and a migration of a real library always finds a few.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimsFile, linkModeName, resolveAttachment } from '../src/attachments.js';
import { crc32 } from '../src/zip.js';
import type { ZoteroAttachmentRow } from '../src/reader/types.js';
import { makeTempDirectory } from './helpers.js';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('Niederschlag\n'), Buffer.from('%%EOF\n')]);
const SHA256 = createHash('sha256').update(PDF).digest('hex');
const MD5 = createHash('md5').update(PDF).digest('hex');

const attachment = (overrides: Partial<ZoteroAttachmentRow> = {}): ZoteroAttachmentRow => ({
  itemID: 1,
  parentItemID: 2,
  linkMode: 0,
  contentType: 'application/pdf',
  charset: null,
  path: 'storage:paper.pdf',
  storageHash: MD5,
  storageModTime: null,
  ...overrides,
});

/** A one-member zip, as Zotero's WebDAV sync writes it. */
const writeWebdavZip = (path: string, name: string, bytes: Buffer): void => {
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

let temp: { path: string; dispose(): void };

beforeEach(() => {
  temp = makeTempDirectory();
});

afterEach(() => {
  temp.dispose();
});

describe('link modes', () => {
  it('names Zotero’s numbers', () => {
    expect(linkModeName(0)).toBe('imported_file');
    expect(linkModeName(1)).toBe('imported_url');
    expect(linkModeName(2)).toBe('linked_file');
    expect(linkModeName(3)).toBe('linked_url');
    expect(linkModeName(9)).toBe('unknown');
  });

  it('knows which modes claim a file', () => {
    expect([0, 1, 2].every(claimsFile)).toBe(true);
    expect(claimsFile(3)).toBe(false);
  });
});

describe('a stored file', () => {
  it('resolves from the storage directory and hashes it', () => {
    const storage = join(temp.path, 'storage');
    mkdirSync(join(storage, 'ABCD1234'), { recursive: true });
    writeFileSync(join(storage, 'ABCD1234', 'paper.pdf'), PDF);

    const resolution = resolveAttachment(attachment(), 'ABCD1234', { storageDirectory: storage });
    expect(resolution).toMatchObject({
      status: 'resolved',
      origin: 'storage',
      filename: 'paper.pdf',
      sha256: SHA256,
      byteSize: PDF.length,
      matchesZoteroHash: true,
    });
  });

  it('finds a file whose name is normalised differently on disk than in the database', () => {
    const storage = join(temp.path, 'storage');
    mkdirSync(join(storage, 'ABCD1234'), { recursive: true });
    // macOS writes NFD; Zotero's database frequently holds NFC. They are different byte strings.
    writeFileSync(join(storage, 'ABCD1234', 'Müller 2019.pdf'.normalize('NFD')), PDF);

    const resolution = resolveAttachment(
      attachment({ path: `storage:${'Müller 2019.pdf'.normalize('NFC')}` }),
      'ABCD1234',
      { storageDirectory: storage },
    );
    expect(resolution.status).toBe('resolved');
  });

  it('reports a mismatch against the MD5 Zotero recorded, without refusing the bytes', () => {
    const storage = join(temp.path, 'storage');
    mkdirSync(join(storage, 'ABCD1234'), { recursive: true });
    writeFileSync(join(storage, 'ABCD1234', 'paper.pdf'), Buffer.concat([PDF, Buffer.from('edited')]));

    const resolution = resolveAttachment(attachment(), 'ABCD1234', { storageDirectory: storage });
    expect(resolution).toMatchObject({ status: 'resolved', matchesZoteroHash: false });
  });

  it('says nothing about a hash Zotero never recorded', () => {
    const storage = join(temp.path, 'storage');
    mkdirSync(join(storage, 'ABCD1234'), { recursive: true });
    writeFileSync(join(storage, 'ABCD1234', 'paper.pdf'), PDF);

    const resolution = resolveAttachment(attachment({ storageHash: null }), 'ABCD1234', {
      storageDirectory: storage,
    });
    expect(resolution).toMatchObject({ status: 'resolved', matchesZoteroHash: null });
  });

  it('reports a missing file with a reason and where it should have been', () => {
    const storage = join(temp.path, 'storage');
    mkdirSync(storage, { recursive: true });

    const resolution = resolveAttachment(attachment(), 'ABCD1234', { storageDirectory: storage });
    expect(resolution).toMatchObject({ status: 'missing', filename: 'paper.pdf' });
    expect(resolution.status === 'missing' && resolution.reason).toMatch(/absent from storage/u);
    expect(resolution.status === 'missing' && resolution.expectedPath).toBe(
      join(storage, 'ABCD1234', 'paper.pdf'),
    );
  });

  it('says so when no storage directory was configured at all', () => {
    const resolution = resolveAttachment(attachment(), 'ABCD1234', {});
    expect(resolution.status).toBe('missing');
    expect(resolution.status === 'missing' && resolution.reason).toMatch(/neither a storage directory/u);
  });
});

describe('a WebDAV-synced library', () => {
  it('falls back to <KEY>.zip when the file is not in storage/', () => {
    const webdav = join(temp.path, 'webdav');
    mkdirSync(webdav, { recursive: true });
    writeWebdavZip(join(webdav, 'ABCD1234.zip'), 'paper.pdf', PDF);

    const resolution = resolveAttachment(attachment(), 'ABCD1234', {
      storageDirectory: join(temp.path, 'storage'),
      webdavDirectory: webdav,
    });
    expect(resolution).toMatchObject({
      status: 'resolved',
      origin: 'webdav',
      sha256: SHA256,
      matchesZoteroHash: true,
    });
    expect(resolution.status === 'resolved' && resolution.source).toContain('ABCD1234.zip!paper.pdf');
  });

  it('prefers a local copy over the zip, because reading it is cheaper', () => {
    const storage = join(temp.path, 'storage');
    const webdav = join(temp.path, 'webdav');
    mkdirSync(join(storage, 'ABCD1234'), { recursive: true });
    mkdirSync(webdav, { recursive: true });
    writeFileSync(join(storage, 'ABCD1234', 'paper.pdf'), PDF);
    writeWebdavZip(join(webdav, 'ABCD1234.zip'), 'paper.pdf', PDF);

    const resolution = resolveAttachment(attachment(), 'ABCD1234', {
      storageDirectory: storage,
      webdavDirectory: webdav,
    });
    expect(resolution.status === 'resolved' && resolution.origin).toBe('storage');
  });

  it('reports a zip that does not hold the file it should', () => {
    const webdav = join(temp.path, 'webdav');
    mkdirSync(webdav, { recursive: true });
    writeWebdavZip(join(webdav, 'ABCD1234.zip'), 'something-else.pdf', PDF);

    const resolution = resolveAttachment(attachment(), 'ABCD1234', {
      storageDirectory: join(temp.path, 'storage'),
      webdavDirectory: webdav,
    });
    expect(resolution.status).toBe('missing');
    expect(resolution.status === 'missing' && resolution.reason).toMatch(/something-else\.pdf/u);
  });

  it('reports a corrupt zip as unreadable rather than throwing', () => {
    const webdav = join(temp.path, 'webdav');
    mkdirSync(webdav, { recursive: true });
    writeFileSync(join(webdav, 'ABCD1234.zip'), Buffer.from('not a zip at all, really'));

    const resolution = resolveAttachment(attachment(), 'ABCD1234', {
      storageDirectory: join(temp.path, 'storage'),
      webdavDirectory: webdav,
    });
    expect(resolution.status).toBe('unreadable');
    expect(resolution.status === 'unreadable' && resolution.reason).toMatch(/not a ZIP archive/u);
  });
});

describe('a linked file', () => {
  it('resolves an `attachments:` path against the linked-attachment base directory', () => {
    const base = join(temp.path, 'linked');
    mkdirSync(join(base, 'sonderdrucke'), { recursive: true });
    writeFileSync(join(base, 'sonderdrucke', 'weiss.pdf'), PDF);

    const resolution = resolveAttachment(
      attachment({ linkMode: 2, path: 'attachments:sonderdrucke/weiss.pdf' }),
      'ABCD1234',
      { linkedAttachmentBase: base },
    );
    expect(resolution).toMatchObject({ status: 'resolved', origin: 'linked', sha256: SHA256 });
  });

  it('resolves an absolute path as it stands', () => {
    const path = join(temp.path, 'somewhere', 'paper.pdf');
    mkdirSync(join(temp.path, 'somewhere'), { recursive: true });
    writeFileSync(path, PDF);

    const resolution = resolveAttachment(attachment({ linkMode: 2, path }), 'ABCD1234', {});
    expect(resolution).toMatchObject({ status: 'resolved', origin: 'linked' });
  });

  it('reports an absolute path from another machine as missing, naming the path', () => {
    const resolution = resolveAttachment(
      attachment({ linkMode: 2, path: '/home/someone-else/Literatur/paper.pdf', storageHash: null }),
      'ABCD1234',
      {},
    );
    expect(resolution.status).toBe('missing');
    expect(resolution.status === 'missing' && resolution.reason).toMatch(/not present on this machine/u);
    expect(resolution.status === 'missing' && resolution.expectedPath).toBe(
      '/home/someone-else/Literatur/paper.pdf',
    );
  });

  it('says so when a relative path has no base directory to resolve against', () => {
    const resolution = resolveAttachment(
      attachment({ linkMode: 2, path: 'attachments:sonderdrucke/weiss.pdf' }),
      'ABCD1234',
      {},
    );
    expect(resolution.status).toBe('missing');
    expect(resolution.status === 'missing' && resolution.reason).toMatch(/base directory/u);
  });

  it('reports a path that is a directory as unreadable', () => {
    const path = join(temp.path, 'a-directory');
    mkdirSync(path, { recursive: true });
    const resolution = resolveAttachment(attachment({ linkMode: 2, path }), 'ABCD1234', {});
    expect(resolution.status).toBe('unreadable');
    expect(resolution.status === 'unreadable' && resolution.reason).toMatch(/is a directory/u);
  });
});

describe('a linked URL', () => {
  it('claims no file at all', () => {
    const resolution = resolveAttachment(
      attachment({ linkMode: 3, path: null, storageHash: null }),
      'ABCD1234',
      {},
    );
    expect(resolution).toMatchObject({ status: 'no_file', filename: null });
    expect(resolution.status === 'no_file' && resolution.reason).toMatch(/bookmark/u);
  });
});

describe('a malformed record', () => {
  it('reports an attachment that claims a file but records no path', () => {
    const resolution = resolveAttachment(attachment({ path: '' }), 'ABCD1234', {
      storageDirectory: temp.path,
    });
    expect(resolution.status).toBe('missing');
    expect(resolution.status === 'missing' && resolution.reason).toMatch(/records no path/u);
  });
});
