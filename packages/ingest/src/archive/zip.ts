/**
 * Just enough ZIP for stage 3.
 *
 * The pipeline needs to read the central directory of an archive it has in memory, decide whether
 * the archive is safe to expand, and produce each member's bytes. That is the local header, two
 * compression methods — stored and deflate, the second of which `node:zlib` implements — and the
 * CRC-32 check that says the bytes came out the way they went in. A hundred and fifty lines, which
 * is cheaper than a dependency in the code path that reads untrusted archives.
 *
 * Deliberately absent: writing, encryption, multi-disk archives and every compression method beyond
 * the two above. Each is refused **by name**, so an archive this cannot read produces a review entry
 * with the reason rather than a silent skip or a wrong answer (P3). ZIP64 is read far enough to
 * report that it is ZIP64 and stop, rather than truncating a four-gigabyte member to its low 32 bits.
 *
 * Nothing here touches the filesystem, and nothing here trusts a member name: names come out as
 * recorded and are resolved by `safe-path.ts` before anything is written.
 *
 * Nothing here trusts a *size*, either, which is ADR-0022 and the correction of a real defect.
 * `uncompressedSize` is a 32-bit field the person who built the archive wrote; it is read, it is
 * used for a fast rejection, and it bounds nothing. The bound is `maxOutputLength` on the inflate
 * call itself, because a length compared after the buffer exists is a length compared after the
 * memory is already committed — which is exactly how an 815 KB archive bought 1.6 GB of resident
 * memory before the old guard fired.
 */
import { inflateRawSync } from 'node:zlib';

import { ArchiveFormatError, ArchiveLimitError } from '../errors.js';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_END_LOCATOR = 0x07064b50;

const STORED = 0;
const DEFLATED = 8;

export interface ZipEntry {
  /** The member's path inside the archive, exactly as recorded. Never used as a path unchecked. */
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  /** The CRC-32 the archive claims. Checked on extraction. */
  crc32: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

/** Is this buffer a zip? Cheap enough to ask before paying for the directory. */
export const looksLikeZip = (bytes: Buffer): boolean =>
  bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_FILE_HEADER;

/** The central directory of an archive held in memory. */
export const readZipDirectory = (archive: Buffer): ZipEntry[] => {
  const end = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);

  if (offset === 0xffffffff || entryCount === 0xffff) {
    throw new ArchiveFormatError('ZIP64 archives are not supported by this reader.');
  }

  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new ArchiveFormatError(`Central directory entry ${index} is malformed.`);
    }
    const flags = archive.readUInt16LE(offset + 8);
    if ((flags & 0x0001) !== 0) throw new ArchiveFormatError('The archive is encrypted.');

    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
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

/**
 * The allowance a member gets when the caller does not say.
 *
 * `extractArchive` always says — it hands down `min(maxArchiveEntryBytes, what the container has
 * left)`. This default is for a direct caller, and it is a real ceiling rather than `Infinity`,
 * because a caller that forgets is the failure this parameter exists to prevent.
 */
export const DEFAULT_MEMBER_OUTPUT_BYTES = 256 * 1024 * 1024;

export interface ZipEntryLimits {
  /**
   * The most this member may produce, in bytes. Enforced by the decompressor, not checked after.
   * The caller passes the smaller of its per-member limit and what the container has left, so this
   * one number carries both budgets (ADR-0022 §3).
   */
  maxOutputBytes: number;
  /** Named in the refusal so the message says which limit was hit. */
  limitName?: string;
}

/**
 * The bytes of one member, decompressed and CRC-checked, inside a budget.
 *
 * `limits` defaults to the conservative per-member budget rather than to "no limit", because a
 * caller that forgets is the failure this function exists to prevent.
 */
export const readZipEntry = (
  archive: Buffer,
  entry: ZipEntry,
  limits: ZipEntryLimits = { maxOutputBytes: DEFAULT_MEMBER_OUTPUT_BYTES },
): Buffer => {
  const maxOutputBytes = Math.max(0, Math.floor(limits.maxOutputBytes));
  const limitName = limits.limitName ?? 'maxOutputBytes';
  const header = entry.localHeaderOffset;
  if (header + 30 > archive.length || archive.readUInt32LE(header) !== LOCAL_FILE_HEADER) {
    throw new ArchiveFormatError(`The local header for '${entry.name}' is malformed.`);
  }
  const nameLength = archive.readUInt16LE(header + 26);
  const extraLength = archive.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.length) {
    throw new ArchiveFormatError(`The data for '${entry.name}' runs past the end of the archive.`);
  }

  // The declared size informs a fast rejection and nothing else. A member that declares more than
  // the budget is refused before a byte is inflated; a member that declares less and produces more
  // is stopped by `maxOutputLength` below, which is the case the directory can lie about.
  if (entry.uncompressedSize > maxOutputBytes) {
    throw new ArchiveLimitError(
      `Member '${entry.name}' declares ${entry.uncompressedSize} bytes; the ${limitName} budget ` +
        `for this member is ${maxOutputBytes} bytes.`,
      { entryName: entry.name, declared: entry.uncompressedSize, limitName, limit: maxOutputBytes },
    );
  }

  const compressed = archive.subarray(start, end);
  let bytes: Buffer;
  if (entry.compressionMethod === STORED) {
    // Stored members cannot expand, so the compressed length is the output length and checking it
    // before the copy is a real bound rather than a description of one.
    if (compressed.length > maxOutputBytes) {
      throw new ArchiveLimitError(
        `Member '${entry.name}' holds ${compressed.length} stored bytes, over the ${limitName} ` +
          `budget of ${maxOutputBytes} bytes.`,
        { entryName: entry.name, byteSize: compressed.length, limitName, limit: maxOutputBytes },
      );
    }
    bytes = Buffer.from(compressed);
  } else if (entry.compressionMethod === DEFLATED) {
    try {
      bytes = inflateRawSync(compressed, { maxOutputLength: maxOutputBytes });
    } catch (error) {
      if (isOutputTooLarge(error)) {
        throw new ArchiveLimitError(
          `Member '${entry.name}' inflates past the ${limitName} budget of ${maxOutputBytes} ` +
            `bytes; the directory declares ${entry.uncompressedSize}. The declared size was a lie ` +
            'and the inflate was stopped at the budget rather than after it.',
          {
            entryName: entry.name,
            declared: entry.uncompressedSize,
            limitName,
            limit: maxOutputBytes,
          },
        );
      }
      throw new ArchiveFormatError(
        `'${entry.name}' could not be inflated: ${error instanceof Error ? error.message : String(error)}`,
        { entryName: entry.name },
      );
    }
  } else {
    throw new ArchiveFormatError(
      `'${entry.name}' uses compression method ${entry.compressionMethod}; this reader supports ` +
        'stored (0) and deflate (8).',
    );
  }

  if (bytes.length !== entry.uncompressedSize) {
    throw new ArchiveFormatError(
      `'${entry.name}' decompressed to ${bytes.length} bytes; the directory says ` +
        `${entry.uncompressedSize}.`,
    );
  }
  const actual = crc32(bytes);
  if (actual !== entry.crc32) {
    throw new ArchiveFormatError(
      `'${entry.name}' failed its CRC-32 check: the archive says ` +
        `${entry.crc32.toString(16)}, the bytes are ${actual.toString(16)}.`,
    );
  }
  return bytes;
};

/**
 * Did `node:zlib` stop because the output ran past `maxOutputLength`?
 *
 * It reports that as `ERR_BUFFER_TOO_LARGE`, which is also what an inflate with no limit throws on
 * a payload past `buffer.kMaxLength`. Both mean the same thing here — the member produced more
 * than it was allowed to — so both become the budget refusal rather than "unreadable archive".
 */
const isOutputTooLarge = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE';

const findEndOfCentralDirectory = (archive: Buffer): number => {
  if (archive.length < 22) throw new ArchiveFormatError('The buffer is too short to be an archive.');
  // The comment may be up to 64 KiB, so the record is somewhere in the last 64 KiB + 22 bytes.
  const earliest = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== archive.length) continue;
    if (offset >= 20 && archive.readUInt32LE(offset - 20) === ZIP64_END_LOCATOR) {
      throw new ArchiveFormatError('ZIP64 archives are not supported by this reader.');
    }
    const disk = archive.readUInt16LE(offset + 4);
    const directoryDisk = archive.readUInt16LE(offset + 6);
    if (disk !== 0 || directoryDisk !== 0) {
      throw new ArchiveFormatError('Multi-disk archives are not supported by this reader.');
    }
    return offset;
  }
  throw new ArchiveFormatError('No end-of-central-directory record: this is not a readable ZIP.');
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
