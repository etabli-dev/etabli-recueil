/**
 * Finding the bytes behind a Zotero attachment (CONCEPT §6, ADR-0004, P3).
 *
 * Zotero records where a file is in four different ways, and a real library uses all four:
 *
 * | `linkMode` | `path` | Where the bytes are |
 * |---|---|---|
 * | 0 `imported_file` | `storage:<name>` | `<data>/storage/<KEY>/<name>` |
 * | 1 `imported_url` | `storage:<name>` | the same place; the file is a saved snapshot |
 * | 2 `linked_file` | `attachments:<rel>` or an absolute path | outside the data directory |
 * | 3 `linked_url` | null | nowhere; the attachment is a bookmark |
 *
 * A WebDAV-synced library keeps the stored files as `<KEY>.zip` on the WebDAV server instead of in
 * `storage/`, so a local `storage/` miss falls back to the WebDAV directory when one is configured.
 *
 * The rule that governs the whole module is P3, flag never guess. Every outcome is one of five
 * named states, a file that is not there or cannot be read produces a review entry carrying the
 * reason, and nothing in here throws in a way that would end the run: an import that stops on the
 * first missing PDF is useless against a real library, where a handful of files are always missing.
 *
 * The digest is SHA-256 (ADR-0004). Zotero's own `storageHash` is MD5, and it is checked when
 * present — not as the identity, but because a mismatch means the file on disk is not the file
 * Zotero last saw, which is exactly the sort of thing a verification report exists to say.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { ZipError, readZipDirectory, readZipEntry } from './zip.js';
import type { ZoteroAttachmentRow } from './reader/types.js';
import { ZOTERO_LINK_MODES } from './reader/types.js';
import type { ZoteroLinkMode } from './reader/types.js';

export type AttachmentOrigin = 'storage' | 'linked' | 'webdav';

export interface ResolvedAttachment {
  status: 'resolved';
  origin: AttachmentOrigin;
  /** Where the bytes were read from: an absolute path, or `<zip>!<member>` for a WebDAV zip. */
  source: string;
  filename: string;
  bytes: Buffer;
  sha256: string;
  byteSize: number;
  /** Whether the MD5 Zotero recorded still matches. Null when Zotero recorded none. */
  matchesZoteroHash: boolean | null;
}

export interface UnresolvedAttachment {
  status: 'missing' | 'unreadable' | 'no_file';
  /** Human-readable, and written into the review entry as-is. */
  reason: string;
  /** Where the file was expected, when there was somewhere to expect it. */
  expectedPath: string | null;
  filename: string | null;
}

export type AttachmentResolution = ResolvedAttachment | UnresolvedAttachment;

export interface AttachmentSources {
  /** Zotero's `storage/` directory. Usually `<data directory>/storage`. */
  storageDirectory?: string | null;
  /** The base for `attachments:` relative paths — Zotero's "Linked Attachment Base Directory". */
  linkedAttachmentBase?: string | null;
  /** A directory of `<KEY>.zip` files, as a WebDAV sync target holds them. */
  webdavDirectory?: string | null;
}

/** `imported_file` and friends, by name rather than by Zotero's magic number. */
export const linkModeName = (linkMode: number): ZoteroLinkMode | 'unknown' =>
  ZOTERO_LINK_MODES[linkMode] ?? 'unknown';

/** Whether this attachment claims a file at all. Mode 3 is a bookmark and claims none. */
export const claimsFile = (linkMode: number): boolean => linkMode !== 3;

/**
 * Resolve one attachment to its bytes.
 *
 * Never throws for a missing or unreadable file: those are return values, because they are
 * expected outcomes of migrating a real library and the run has to carry on past them (P3).
 */
export const resolveAttachment = (
  attachment: ZoteroAttachmentRow,
  itemKey: string,
  sources: AttachmentSources,
): AttachmentResolution => {
  if (!claimsFile(attachment.linkMode)) {
    return {
      status: 'no_file',
      reason: 'a linked URL, which is a bookmark rather than a file',
      expectedPath: null,
      filename: null,
    };
  }

  const path = (attachment.path ?? '').trim();
  if (path === '') {
    return {
      status: 'missing',
      reason: 'the attachment claims a file but records no path',
      expectedPath: null,
      filename: null,
    };
  }

  if (path.startsWith('storage:')) {
    return resolveStored(path.slice('storage:'.length), itemKey, attachment, sources);
  }

  const linkedPath = path.startsWith('attachments:')
    ? joinBase(sources.linkedAttachmentBase, path.slice('attachments:'.length))
    : isAbsolute(path)
      ? path
      : joinBase(sources.linkedAttachmentBase, path);

  if (linkedPath === null) {
    return {
      status: 'missing',
      reason:
        `the linked file '${path}' is recorded relative to Zotero's linked-attachment base ` +
        'directory, and no base directory was configured for this import',
      expectedPath: null,
      filename: basenameOf(path),
    };
  }
  return readLocal(linkedPath, 'linked', attachment);
};

const resolveStored = (
  filename: string,
  itemKey: string,
  attachment: ZoteroAttachmentRow,
  sources: AttachmentSources,
): AttachmentResolution => {
  const storage = sources.storageDirectory ?? null;

  if (storage !== null) {
    const directory = join(storage, itemKey);
    const candidate = matchFilename(directory, filename);
    if (candidate !== null) return readLocal(candidate, 'storage', attachment);
  }

  const webdav = sources.webdavDirectory ?? null;
  if (webdav !== null) {
    const archive = join(webdav, `${itemKey}.zip`);
    if (existsSync(archive)) return readFromZip(archive, filename, attachment);
  }

  const expected = storage === null ? null : join(storage, itemKey, filename);
  return {
    status: 'missing',
    reason:
      storage === null && webdav === null
        ? 'the attachment is stored in Zotero, and neither a storage directory nor a WebDAV ' +
          'directory was configured for this import'
        : `stored file recorded in itemAttachments but absent from storage/${itemKey}/` +
          (webdav === null ? '' : ` and from ${itemKey}.zip in the WebDAV directory`),
    expectedPath: expected,
    filename,
  };
};

const readLocal = (
  path: string,
  origin: AttachmentOrigin,
  attachment: ZoteroAttachmentRow,
): AttachmentResolution => {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    return {
      status: 'missing',
      reason:
        origin === 'linked'
          ? `linked file recorded at '${absolute}', which is not present on this machine`
          : `stored file recorded at '${absolute}', which is not present`,
      expectedPath: absolute,
      filename: basenameOf(absolute),
    };
  }
  try {
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      return {
        status: 'unreadable',
        reason: `'${absolute}' is a directory, not a file`,
        expectedPath: absolute,
        filename: basenameOf(absolute),
      };
    }
    const bytes = readFileSync(absolute);
    return describe(bytes, origin, absolute, basenameOf(absolute), attachment);
  } catch (error) {
    return {
      status: 'unreadable',
      reason: `could not read '${absolute}': ${messageOf(error)}`,
      expectedPath: absolute,
      filename: basenameOf(absolute),
    };
  }
};

const readFromZip = (
  archivePath: string,
  filename: string,
  attachment: ZoteroAttachmentRow,
): AttachmentResolution => {
  try {
    const archive = readFileSync(archivePath);
    const entries = readZipDirectory(archive).filter((entry) => !entry.isDirectory);
    const wanted =
      entries.find((entry) => entry.name === filename) ??
      entries.find((entry) => basenameOf(entry.name) === filename) ??
      entries.find((entry) => normaliseName(basenameOf(entry.name)) === normaliseName(filename));

    if (wanted === undefined) {
      return {
        status: 'missing',
        reason:
          `'${filename}' is not in '${archivePath}', which holds ` +
          `${entries.map((entry) => entry.name).join(', ') || 'nothing'}`,
        expectedPath: `${archivePath}!${filename}`,
        filename,
      };
    }
    const bytes = readZipEntry(archive, wanted);
    return describe(bytes, 'webdav', `${archivePath}!${wanted.name}`, filename, attachment);
  } catch (error) {
    return {
      status: 'unreadable',
      reason:
        error instanceof ZipError
          ? `could not read '${archivePath}': ${error.message}`
          : `could not read '${archivePath}': ${messageOf(error)}`,
      expectedPath: `${archivePath}!${filename}`,
      filename,
    };
  }
};

const describe = (
  bytes: Buffer,
  origin: AttachmentOrigin,
  source: string,
  filename: string,
  attachment: ZoteroAttachmentRow,
): ResolvedAttachment => {
  const recorded = (attachment.storageHash ?? '').trim().toLowerCase();
  return {
    status: 'resolved',
    origin,
    source,
    filename,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.byteLength,
    matchesZoteroHash:
      recorded === '' ? null : createHash('md5').update(bytes).digest('hex') === recorded,
  };
};

/**
 * Find a file in a directory, tolerating Unicode normalisation.
 *
 * A filename written on macOS is NFD on disk and frequently NFC in the database, and the two are
 * different byte strings to every filesystem call. Trying the recorded name first keeps the common
 * case one `stat`; the directory listing is only read when that misses.
 */
const matchFilename = (directory: string, filename: string): string | null => {
  const direct = join(directory, filename);
  if (existsSync(direct)) return direct;
  if (!existsSync(directory)) return null;

  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return null;
  }
  const wanted = normaliseName(filename);
  const found = names.find((name) => normaliseName(name) === wanted);
  return found === undefined ? null : join(directory, found);
};

const normaliseName = (name: string): string => name.normalize('NFC');

const joinBase = (base: string | null | undefined, relative: string): string | null =>
  base === null || base === undefined || base === '' ? null : join(base, relative);

const basenameOf = (path: string): string => {
  const parts = path.split(/[\\/]/u);
  return parts[parts.length - 1] ?? path;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
