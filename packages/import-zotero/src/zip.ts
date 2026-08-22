/**
 * Just enough ZIP to read a Zotero WebDAV attachment.
 *
 * A WebDAV-synced Zotero library keeps each stored attachment as `<KEY>.zip` beside a `<KEY>.prop`
 * file; the zip holds the attachment's file (and, for a snapshot, the page's assets). Reading one
 * needs the central directory, the local header and two compression methods — stored and deflate,
 * the latter of which `node:zlib` already implements. That is a hundred lines, so it is a hundred
 * lines here rather than a dependency on an unmaintained archive library in the one code path that
 * touches the user's only copy of their files.
 *
 * Deliberately absent: writing, encryption, ZIP64, multi-disk archives and any compression method
 * beyond the two above. Each of those is refused by name, so an archive this cannot read produces a
 * review entry with the reason rather than a wrong answer (P3).
 */
import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_END_LOCATOR = 0x07064b50;

const STORED = 0;
const DEFLATED = 8;

export interface ZipEntry {
  /** The member's path inside the archive, as recorded. */
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  /** The CRC-32 the archive claims. Checked on extraction. */
  crc32: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/** The central directory of an archive held in memory. */
export const readZipDirectory = (archive: Buffer): ZipEntry[] => {
  const end = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);

  if (offset === 0xffffffff || entryCount === 0xffff) {
    throw new ZipError('ZIP64 archives are not supported by this reader.');
  }

  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new ZipError(`Central directory entry ${index} is malformed.`);
    }
    const flags = archive.readUInt16LE(offset + 8);
    if ((flags & 0x0001) !== 0) throw new ZipError('The archive is encrypted.');

    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    // Bit 11 says the name is UTF-8. Without it the specification says CP437; Zotero writes UTF-8
    // either way, and every other producer worth reading does too.
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({
      name,
      compressionMethod: archive.readUInt16LE(offset + 10),
      crc32: archive.readUInt32LE(offset + 16),
      compressedSize: archive.readUInt32LE(offset + 20),
      uncompressedSize: archive.readUInt32LE(offset + 24),
      localHeaderOffset: archive.readUInt32LE(offset + 42),
      isDirectory: name.endsWith('/'),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

/** The bytes of one member, decompressed and CRC-checked. */
export const readZipEntry = (archive: Buffer, entry: ZipEntry): Buffer => {
  const header = entry.localHeaderOffset;
  if (header + 30 > archive.length || archive.readUInt32LE(header) !== LOCAL_FILE_HEADER) {
    throw new ZipError(`Local header for '${entry.name}' is malformed.`);
  }
  const nameLength = archive.readUInt16LE(header + 26);
  const extraLength = archive.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);

  let bytes: Buffer;
  if (entry.compressionMethod === STORED) {
    bytes = Buffer.from(compressed);
  } else if (entry.compressionMethod === DEFLATED) {
    bytes = inflateRawSync(compressed);
  } else {
    throw new ZipError(
      `'${entry.name}' uses compression method ${entry.compressionMethod}; this reader handles ` +
        'stored (0) and deflate (8) only.',
    );
  }

  if (bytes.length !== entry.uncompressedSize) {
    throw new ZipError(
      `'${entry.name}' decompressed to ${bytes.length} bytes, not the ${entry.uncompressedSize} the ` +
        'directory claims.',
    );
  }
  const actual = crc32(bytes);
  if (actual !== entry.crc32) {
    throw new ZipError(
      `'${entry.name}' fails its CRC-32: the directory says ${entry.crc32.toString(16)}, the bytes ` +
        `give ${actual.toString(16)}.`,
    );
  }
  return bytes;
};

const findEndOfCentralDirectory = (archive: Buffer): number => {
  if (archive.length < 22) throw new ZipError('Too short to be a ZIP archive.');
  // The comment may be up to 64 KiB, so the record is searched for backwards from the end.
  const earliest = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    if (offset >= 20 && archive.readUInt32LE(offset - 20) === ZIP64_END_LOCATOR) {
      throw new ZipError('ZIP64 archives are not supported by this reader.');
    }
    return offset;
  }
  throw new ZipError('No end-of-central-directory record: this is not a ZIP archive.');
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

/** CRC-32 as the ZIP format defines it. */
export const crc32 = (bytes: Buffer): number => {
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  return (crc ^ -1) >>> 0;
};
