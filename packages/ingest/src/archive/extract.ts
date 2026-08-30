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
 * The limits in `IngestConfig` are the zip-bomb guard, and they are applied twice, because the
 * Phase 2 review proved that once is not enough (ADR-0022). The declared sizes in the central
 * directory are checked first, since refusing a lying archive early is cheaper than refusing it
 * late — but they are the archive author's numbers, so they bound nothing. The bound is the same
 * two limits carried by a `BudgetLedger` and handed to each inflate call as its `maxOutputLength`:
 * the allowance for a member is the smaller of `maxArchiveEntryBytes` and what is left of
 * `maxArchiveTotalBytes`, so no member can materialise more than the archive still has to spend,
 * and a nested archive inherits the remainder rather than a fresh ceiling. A member that fails a
 * limit fails the archive: an archive designed to exhaust the disk is not an archive with one
 * awkward file in it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { BudgetLedger, DEFAULT_EMAIL_BUDGET } from '../budgets.js';
import type { EmailBudget } from '../budgets.js';
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
  /**
   * The output budget this container spends from (ADR-0022 §3).
   *
   * A caller that is expanding an archive found *inside* another archive passes the outer
   * container's ledger through `child()`, so the nested container inherits the remaining allowance
   * rather than a fresh one. Omitted, a fresh ledger is made at the configured ceiling, which is
   * the right answer for a top-level file.
   */
  budget?: BudgetLedger;
}

const containerLedger = (options: ExtractOptions): BudgetLedger =>
  options.budget ?? new BudgetLedger(options.config.maxArchiveTotalBytes, 'maxArchiveTotalBytes');

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

  /*
   * Every name is resolved before anything is written. One bad name refuses the whole archive.
   *
   * Two distinct entries may resolve to the same relative path: `resolveMemberPath` drops `.` and
   * empty segments, so `./invoice.pdf` and `invoice.pdf` normalise to one name, and a zip may
   * simply carry the same name twice. The Phase 2 review turned that into a silent loss — both
   * members were written to the same scratch file with no `wx` flag, `pipeline.ts` read every
   * member's bytes back *after* the extraction loop, and so both members read the last writer's
   * bytes, were filed as one document, and were reported as two ingested members with nothing in
   * `skipped`. The first member's bytes were discarded and the run's own verification was happy.
   *
   * So a member whose relative path is already taken is given a positional directory of its own,
   * which is exactly what the `.eml` path opposite has always done (`attachments/<index>/`). The
   * prefix is applied only on a collision, so the ordinary archive's member — and the
   * `<container>!/<member>` external id the pipeline builds from it — is unchanged.
   */
  const takenPaths = new Set<string>();
  const resolved = files.map((entry, index) => {
    const first = resolveMemberPath(scratch.path, entry.name);
    const path = takenPaths.has(first.relativePath)
      ? resolveMemberPath(scratch.path, `${String(index + 1)}/${entry.name}`)
      : first;
    takenPaths.add(path.relativePath);
    return { entry, path };
  });

  const members: ExtractedMember[] = [];
  const skipped: Array<{ entryName: string; reason: string }> = [];
  const ledger = containerLedger(options);

  for (const { entry, path } of resolved) {
    // The allowance is the composition rule: a member may produce at most its own ceiling, and at
    // most what this container — which may itself be a nested one, spending an inherited
    // remainder — still has left. It goes into the inflate call as `maxOutputLength`, so a member
    // that lies about its size is stopped at the budget, not measured after it.
    const allowance = ledger.allowance(config.maxArchiveEntryBytes);
    const memberBytes = readZipEntry(bytes, entry, {
      maxOutputBytes: allowance,
      limitName:
        allowance < config.maxArchiveEntryBytes
          ? `${ledger.label} (remaining)`
          : 'maxArchiveEntryBytes',
    });
    // Belt and braces. A member cannot exceed the allowance it was given, and a member that
    // understates its size is refused by the size-equality check in `readZipEntry`, so for a zip
    // the running total cannot pass the ceiling by this route. It is still counted and still
    // checked, because that argument depends on two other checks staying where they are.
    if (!ledger.spend(memberBytes.length)) {
      throw new ArchiveLimitError(
        `The archive has already produced ${ledger.spent} bytes, over the ${ledger.label} budget ` +
          `of ${ledger.ceiling}. The central directory understated the sizes.`,
        { actualTotal: ledger.spent, limitName: ledger.label, limit: ledger.ceiling },
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

/**
 * The parser's budget, derived from the pipeline's configuration and from what the containing
 * archive has left.
 *
 * Three of the five numbers come from `IngestConfig`, so an operator who raises the archive limits
 * for a legitimately large import raises these with them rather than hitting a second, hidden
 * ceiling. The fourth — the whole-message total — is the container's *remaining* allowance, which
 * is what makes a `.eml` inside a zip decode out of the zip's budget instead of opening its own
 * (ADR-0022 §3). The input and header ceilings are this module's own, because `IngestConfig` has no
 * opinion about how big a single message may be.
 */
const emailBudget = (config: IngestConfig, ledger: BudgetLedger): EmailBudget => ({
  maxInputBytes: DEFAULT_EMAIL_BUDGET.maxInputBytes,
  maxHeaderBytes: DEFAULT_EMAIL_BUDGET.maxHeaderBytes,
  maxParts: config.maxArchiveEntries,
  maxPartBytes: config.maxArchiveEntryBytes,
  maxTotalBytes: ledger.allowance(config.maxArchiveTotalBytes),
});

const extractEmail = async (options: ExtractOptions): Promise<ExtractionResult> => {
  const { bytes, scratch, config } = options;
  // The same ledger as the zip path, so a message carried inside an archive spends what that
  // archive has left rather than opening a second budget of its own.
  const ledger = containerLedger(options);

  // Parsed under a budget, not parsed and then measured. The `maxArchiveEntries` check below used
  // to be the first size comparison of any kind on this path, and by then every part of the tree
  // had already been decoded and allocated.
  const email = parseEmail(bytes, emailBudget(config, ledger));

  if (email.attachments.length > config.maxArchiveEntries) {
    throw new ArchiveLimitError(
      `The message carries ${email.attachments.length} attachments; the limit is ` +
        `${config.maxArchiveEntries}.`,
      { entries: email.attachments.length },
    );
  }

  const members: ExtractedMember[] = [];
  const skipped: Array<{ entryName: string; reason: string }> = [];

  for (const [index, part] of email.attachments.entries()) {
    if (part.bytes.length === 0) {
      skipped.push({ entryName: part.filename ?? `part-${index + 1}`, reason: 'the part is empty' });
      continue;
    }
    if (part.bytes.length > ledger.allowance(config.maxArchiveEntryBytes)) {
      throw new ArchiveLimitError(
        `Attachment '${part.filename ?? index + 1}' is ${part.bytes.length} bytes; the allowance ` +
          `left for one part is ${ledger.allowance(config.maxArchiveEntryBytes)} (maxArchiveEntryBytes ` +
          `${config.maxArchiveEntryBytes}, ${ledger.label} ${ledger.ceiling}).`,
        { byteSize: part.bytes.length, limitName: 'maxArchiveEntryBytes', limit: config.maxArchiveEntryBytes },
      );
    }
    if (!ledger.spend(part.bytes.length)) {
      throw new ArchiveLimitError(
        `The message's attachments total ${ledger.spent} bytes, over the ${ledger.label} budget ` +
          `of ${ledger.ceiling}.`,
        { total: ledger.spent, limitName: ledger.label, limit: ledger.ceiling },
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
