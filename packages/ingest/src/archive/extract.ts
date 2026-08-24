/**
 * Stage 3: archive extraction.
 *
 * CONCEPT §5.3: "Archive extraction (zip, eml) to scratch; inner files re-enter at stage 1." Two
 * clauses, both load-bearing. *To scratch* means the members are written to a directory the run
 * owns and deletes, never anywhere near the content store — the store only ever receives bytes that
 * have been hashed. *Re-enter at stage 1* means an inner file is not a special case: it is hashed,
 * duplicate-checked, type-detected, OCR'd and filed exactly as if it had arrived on its own, and it
 * gets its own `documents` row with `parent_document_id` pointing at the archive it came out of.
 *
 * The limits in `IngestConfig` are the zip-bomb guard, and they are checked against the *declared*
 * sizes in the central directory before a single member is inflated, because checking afterwards is
 * checking after the damage. A member that fails a limit fails the archive: an archive designed to
 * exhaust the disk is not an archive with one awkward file in it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { IngestConfig } from '../config.js';
import { ArchiveLimitError } from '../errors.js';
import type { ScratchSpace } from '../scratch.js';
import type { JsonObject } from '../types.js';
import { looksLikeEmail, parseEmail } from './eml.js';
import type { ParsedEmail } from './eml.js';
import { resolveMemberPath } from './safe-path.js';
import { looksLikeZip, readZipDirectory, readZipEntry } from './zip.js';

export type ArchiveKind = 'zip' | 'eml';

/** One file recovered from an archive, sitting in scratch, waiting to be hashed. */
export interface ExtractedMember {
  /** The member name as the archive recorded it. Provenance only. */
  entryName: string;
  /** The checked, root-relative path. */
  relativePath: string;
  /** Where the bytes are, inside the scratch directory. */
  absolutePath: string;
  byteSize: number;
  /** What the archive claimed the member is, when it said. Advisory; the bytes are sniffed. */
  declaredMediaType: string | null;
}

export interface ExtractionResult {
  kind: ArchiveKind;
  members: ExtractedMember[];
  /** For `eml`: the envelope the rule engine matches on and the body the commit files as a Note. */
  email: ParsedEmail | null;
  /** Members the archive held that were not extracted, and why. Reported, never silent. */
  skipped: Array<{ entryName: string; reason: string }>;
}

/**
 * Which archive this is, or null when it is not one the pipeline expands.
 *
 * The declared type is consulted and then checked against the bytes, in that order and never the
 * other way round: a `.eml` saved by a mail client is sniffed as `text/plain` by any honest
 * sniffer, because that is what it is, and a `.zip` renamed to `.pdf` is still a zip. The magic
 * number decides; the media type only narrows where to look.
 */
export const archiveKind = (mediaType: string, bytes: Buffer): ArchiveKind | null => {
  if (looksLikeZip(bytes)) return 'zip';
  if (mediaType === 'message/rfc822') return 'eml';
  if ((mediaType === 'text/plain' || mediaType === 'application/octet-stream') && looksLikeEmail(bytes)) {
    return 'eml';
  }
  return null;
};

export interface ExtractOptions {
  bytes: Buffer;
  kind: ArchiveKind;
  scratch: ScratchSpace;
  config: IngestConfig;
}

/** Expand an archive into scratch. Throws rather than returning a partial expansion. */
export const extractArchive = async (options: ExtractOptions): Promise<ExtractionResult> =>
  options.kind === 'zip' ? extractZip(options) : extractEmail(options);

const extractZip = async (options: ExtractOptions): Promise<ExtractionResult> => {
  const { bytes, scratch, config } = options;
  const entries = readZipDirectory(bytes);

  if (entries.length > config.maxArchiveEntries) {
    throw new ArchiveLimitError(
      `The archive declares ${entries.length} members; the limit is ${config.maxArchiveEntries}.`,
      { entries: entries.length, limit: config.maxArchiveEntries },
    );
  }

  const files = entries.filter((entry) => !entry.isDirectory);
  let declaredTotal = 0;
  for (const entry of files) {
    if (entry.uncompressedSize > config.maxArchiveEntryBytes) {
      throw new ArchiveLimitError(
        `Member '${entry.name}' declares ${entry.uncompressedSize} bytes; the per-member limit is ` +
          `${config.maxArchiveEntryBytes}.`,
        { entryName: entry.name, byteSize: entry.uncompressedSize },
      );
    }
    declaredTotal += entry.uncompressedSize;
  }
  if (declaredTotal > config.maxArchiveTotalBytes) {
    throw new ArchiveLimitError(
      `The archive declares ${declaredTotal} bytes uncompressed; the limit is ` +
        `${config.maxArchiveTotalBytes}.`,
      { declaredTotal, limit: config.maxArchiveTotalBytes },
    );
  }
  if (bytes.length > 0 && declaredTotal / bytes.length > config.maxArchiveExpansionRatio) {
    throw new ArchiveLimitError(
      `The archive expands ${(declaredTotal / bytes.length).toFixed(1)}x, over the limit of ` +
        `${config.maxArchiveExpansionRatio}x. This is the shape of a decompression bomb.`,
      { compressed: bytes.length, declaredTotal },
    );
  }

  // Every name is resolved before anything is written. One bad name refuses the whole archive.
  const resolved = files.map((entry) => ({
    entry,
    path: resolveMemberPath(scratch.path, entry.name),
  }));

  const members: ExtractedMember[] = [];
  const skipped: Array<{ entryName: string; reason: string }> = [];
  let actualTotal = 0;

  for (const { entry, path } of resolved) {
    const memberBytes = readZipEntry(bytes, entry);
    actualTotal += memberBytes.length;
    if (actualTotal > config.maxArchiveTotalBytes) {
      throw new ArchiveLimitError(
        `The archive has already produced ${actualTotal} bytes, over the limit of ` +
          `${config.maxArchiveTotalBytes}. The central directory understated the sizes.`,
        { actualTotal, limit: config.maxArchiveTotalBytes },
      );
    }
    if (memberBytes.length === 0) {
      skipped.push({ entryName: entry.name, reason: 'the member is empty' });
      continue;
    }
    await mkdir(dirname(path.absolutePath), { recursive: true });
    await writeFile(path.absolutePath, memberBytes);
    members.push({
      entryName: entry.name,
      relativePath: path.relativePath,
      absolutePath: path.absolutePath,
      byteSize: memberBytes.length,
      declaredMediaType: null,
    });
  }

  return { kind: 'zip', members, email: null, skipped };
};

const extractEmail = async (options: ExtractOptions): Promise<ExtractionResult> => {
  const { bytes, scratch, config } = options;
  const email = parseEmail(bytes);

  if (email.attachments.length > config.maxArchiveEntries) {
    throw new ArchiveLimitError(
      `The message carries ${email.attachments.length} attachments; the limit is ` +
        `${config.maxArchiveEntries}.`,
      { entries: email.attachments.length },
    );
  }

  const members: ExtractedMember[] = [];
  const skipped: Array<{ entryName: string; reason: string }> = [];
  let total = 0;

  for (const [index, part] of email.attachments.entries()) {
    if (part.bytes.length === 0) {
      skipped.push({ entryName: part.filename ?? `part-${index + 1}`, reason: 'the part is empty' });
      continue;
    }
    if (part.bytes.length > config.maxArchiveEntryBytes) {
      throw new ArchiveLimitError(
        `Attachment '${part.filename ?? index + 1}' is ${part.bytes.length} bytes; the per-member ` +
          `limit is ${config.maxArchiveEntryBytes}.`,
        { byteSize: part.bytes.length },
      );
    }
    total += part.bytes.length;
    if (total > config.maxArchiveTotalBytes) {
      throw new ArchiveLimitError(
        `The message's attachments total ${total} bytes, over the limit of ` +
          `${config.maxArchiveTotalBytes}.`,
        { total },
      );
    }

    // A mail attachment's filename is chosen by the sender, so it goes through exactly the same
    // resolution as a zip member name. A part with no name at all gets a positional one, which is
    // ours and therefore safe by construction.
    const declaredName = part.filename ?? `part-${index + 1}.bin`;
    const path = resolveMemberPath(scratch.path, `attachments/${index + 1}/${declaredName}`);
    await mkdir(dirname(path.absolutePath), { recursive: true });
    await writeFile(path.absolutePath, part.bytes);

    members.push({
      entryName: declaredName,
      relativePath: path.relativePath,
      absolutePath: path.absolutePath,
      byteSize: part.bytes.length,
      declaredMediaType: part.mediaType,
    });
  }

  return { kind: 'eml', members, email, skipped };
};

/** The envelope, flattened for `documents.source_detail` and for the rule engine to match on. */
export const emailMetadata = (email: ParsedEmail): JsonObject => ({
  from: email.from,
  to: email.to,
  subject: email.subject,
  date: email.date,
  messageId: email.messageId,
  attachmentCount: email.attachments.length,
});
