/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A zip writer that will write anything, including the things a library refuses to.
 *
 * That is the whole reason it is here. `archives/path-traversal.zip` needs an entry literally named
 * `../../../../tmp/recueil-pwned.txt`, one named `/etc/recueil-pwned.txt`, one with a backslash
 * separator and one that is a symbolic link to `/etc/passwd` — and every archiving library worth
 * using normalises at least three of those away. A hostile fixture has to be written by something
 * that does not know it should say no.
 *
 * It also needs control over general-purpose bit 11, because whether a filename is UTF-8 or CP437
 * is decided by that bit and half the archives in the world set it wrongly.
 *
 * Deterministic: a fixed DOS timestamp, `zlib.deflateRawSync` at a pinned level.
 */
import zlib from 'node:zlib';

import { crc32 } from './raster.mjs';

/** 2024-01-01 00:00:00, in the DOS date/time a zip local header carries. */
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

/** `0o100644 << 16` — a regular file, in the external attributes a Unix zip writes. */
const MODE_FILE = 0o100644 << 16;
/** `0o120777 << 16` — a symbolic link. The entry data is the link target, as bytes. */
export const MODE_SYMLINK = 0o120777 << 16;
/** `0o40755 << 16`, plus the MS-DOS directory bit. */
const MODE_DIRECTORY = (0o40755 << 16) | 0x10;

/**
 * @typedef {object} ZipEntry
 * @property {string} name          the entry name, written verbatim — never normalised
 * @property {Buffer|string} [data] the contents; a symlink's contents is its target
 * @property {boolean} [directory]
 * @property {boolean} [store]      write the entry uncompressed (method 0)
 * @property {boolean} [utf8]       set general-purpose bit 11. Default: set it when the name is not
 *                                  pure ASCII, which is what a correct writer does
 * @property {BufferEncoding} [nameEncoding]  how to encode the name. `latin1` here stands in for
 *                                  CP437 for the characters the fixture uses
 * @property {number} [externalAttributes]
 * @property {string} [comment]
 */

/**
 * Build a zip archive.
 *
 * @param {ZipEntry[]} entries
 * @param {object} [options]
 * @param {string} [options.comment]  the archive comment
 * @returns {Buffer}
 */
export function buildZip(entries, { comment = '' } = {}) {
  /** @type {Buffer[]} */
  const local = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, entry.nameEncoding ?? 'utf8');
    const utf8 =
      entry.utf8 ?? ((entry.nameEncoding ?? 'utf8') === 'utf8' && !isAscii(entry.name));
    const flags = utf8 ? 0x0800 : 0;

    const raw = entry.directory
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.data)
        ? entry.data
        : Buffer.from(entry.data ?? '', 'utf8');
    const store = entry.directory || entry.store || raw.length === 0;
    const body = store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const method = store ? 0 : 8;
    const crc = crc32(raw);

    const externalAttributes =
      entry.externalAttributes ?? (entry.directory ? MODE_DIRECTORY : MODE_FILE);

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(store ? 10 : 20, 4); // version needed
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(localHeader, 30);

    const commentBytes = Buffer.from(entry.comment ?? '', 'utf8');
    const centralHeader = Buffer.alloc(46 + nameBytes.length + commentBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4); // version made by: Unix, zip 3.0
    centralHeader.writeUInt16LE(store ? 10 : 20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(commentBytes.length, 32);
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    centralHeader.writeUInt32LE(externalAttributes >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBytes.copy(centralHeader, 46);
    commentBytes.copy(centralHeader, 46 + nameBytes.length);

    local.push(localHeader, body);
    central.push(centralHeader);
    offset += localHeader.length + body.length;
  }

  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
  const commentBytes = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22 + commentBytes.length);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  commentBytes.copy(end, 22);

  return Buffer.concat([...local, ...central, end]);
}

function isAscii(value) {
  return [...value].every((char) => char.codePointAt(0) < 0x80);
}
