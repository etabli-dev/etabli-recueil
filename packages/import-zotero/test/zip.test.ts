/**
 * The WebDAV zip reader.
 *
 * A Zotero library synced over WebDAV keeps its stored files as `<KEY>.zip`, so this is the only
 * route to the bytes for such a library — and the archives are written by Zotero, not by us, which
 * is why the CRC is checked rather than trusted and why an archive this cannot read must produce a
 * named error rather than plausible rubbish.
 *
 * The archives here are built in the test, by hand, from the format's own byte layout. Writing them
 * with a library would test that library.
 */
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { ZipError, crc32, readZipDirectory, readZipEntry } from '../src/zip.js';

interface Member {
  name: string;
  bytes: Buffer;
  deflate: boolean;
}

/** A minimal ZIP writer: enough of the format to produce something a reader must accept. */
const makeZip = (members: readonly Member[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const payload = member.deflate ? deflateRawSync(member.bytes) : member.bytes;
    const crc = crc32(member.bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(member.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(member.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(member.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(member.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
};

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 0x41), Buffer.from('\n%%EOF\n')]);

describe('readZipDirectory / readZipEntry', () => {
  it('reads a stored member', () => {
    const archive = makeZip([{ name: 'paper.pdf', bytes: PDF, deflate: false }]);
    const entries = readZipDirectory(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('paper.pdf');
    expect(entries[0]?.compressionMethod).toBe(0);
    expect(readZipEntry(archive, entries[0]!)).toEqual(PDF);
  });

  it('reads a deflated member', () => {
    const archive = makeZip([{ name: 'paper.pdf', bytes: PDF, deflate: true }]);
    const entries = readZipDirectory(archive);
    expect(entries[0]?.compressionMethod).toBe(8);
    expect(entries[0]?.compressedSize).toBeLessThan(PDF.length);
    expect(readZipEntry(archive, entries[0]!)).toEqual(PDF);
  });

  it('reads several members, including non-ASCII names, and keeps their order', () => {
    const members = [
      { name: 'Müller — 2019.pdf', bytes: PDF, deflate: true },
      { name: 'assets/style.css', bytes: Buffer.from('body{}'), deflate: false },
      { name: 'index.html', bytes: Buffer.from('<html></html>'), deflate: true },
    ];
    const archive = makeZip(members);
    const entries = readZipDirectory(archive);
    expect(entries.map((entry) => entry.name)).toEqual(members.map((member) => member.name));
    for (const [index, entry] of entries.entries()) {
      expect(readZipEntry(archive, entry)).toEqual(members[index]?.bytes);
    }
  });

  it('rejects a member whose CRC does not match, rather than returning the bytes', () => {
    const archive = makeZip([{ name: 'paper.pdf', bytes: PDF, deflate: false }]);
    const entries = readZipDirectory(archive);
    // Corrupt one byte of the payload; the local header is 30 bytes plus the 9-byte name.
    archive[30 + 'paper.pdf'.length + 5] = 0x00;
    expect(() => readZipEntry(archive, entries[0]!)).toThrow(ZipError);
    expect(() => readZipEntry(archive, entries[0]!)).toThrow(/CRC-32/u);
  });

  it('rejects something that is not a ZIP archive at all', () => {
    expect(() => readZipDirectory(PDF)).toThrow(ZipError);
    expect(() => readZipDirectory(Buffer.alloc(4))).toThrow(/Too short/u);
  });

  it('rejects an encrypted archive by name rather than producing rubbish', () => {
    const archive = makeZip([{ name: 'paper.pdf', bytes: PDF, deflate: false }]);
    // Set the encryption bit in the central directory's general-purpose flags.
    const central = archive.length - 22 - (46 + 'paper.pdf'.length);
    archive.writeUInt16LE(0x0001, central + 8);
    expect(() => readZipDirectory(archive)).toThrow(/encrypted/u);
  });
});

describe('crc32', () => {
  it('agrees with the published check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});
