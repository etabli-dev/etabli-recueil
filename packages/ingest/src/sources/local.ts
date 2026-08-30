/**
 * The candidate constructors a caller actually reaches for.
 *
 * CONCEPT §5.3 lists eight sources and they all feed the same pipeline, so the pipeline takes
 * `IngestCandidate`s and knows nothing about where they came from. These are the three that need no
 * plugin: a buffer somebody uploaded, a file on disk, and a watched folder.
 *
 * `folderCandidates` is the one with teeth. A watched folder is a directory a person drops files
 * into, and the path of a file inside it is therefore untrusted in exactly the way an archive
 * member name is: a symlink pointing at `/etc`, a name that escapes through `..`, a directory that
 * is itself a link to somewhere else. So every path is resolved with `realpath` and checked to be
 * inside the watched root before it is opened, and one that is not is reported rather than read.
 *
 * ## The gap between the check and the read
 *
 * That paragraph describes the *scan*, and the scan is not when the bytes are read. A candidate is
 * a promise: `read()` is called later, by the pipeline, after however many other candidates were
 * worked on first — and the watched folder is a directory somebody else is writing to the whole
 * time. Between the two, the name that was resolved and checked can be made to mean something
 * else. Nobody had named this; it reproduces in one line:
 *
 *     scan → offered ['scan.pdf'] → unlink('scan.pdf'); symlink('/somewhere/secret', 'scan.pdf')
 *          → candidate.read() → "SECRET-OUTSIDE-THE-WATCHED-ROOT"
 *
 * The same gap makes `maxBytes` a description rather than a bound: the scan compared it against
 * `stat().size` and the read was an unbounded `readFile`, so a 100-byte file that grew to 4 MiB
 * between the two was read whole (ADR-0022 §2 — bound the operation, not the result).
 *
 * So `read()` re-establishes both, and it does it over **identity** rather than over the path. The
 * file is opened with `O_NOFOLLOW`, so the final component cannot have become a symlink; the
 * descriptor is `fstat`ed and its device and inode compared against the ones the scan checked, so
 * substituting a different file anywhere along the path is refused whatever the name now resolves
 * to; and the read is a bounded read from that descriptor, so the size that bounds it is the size
 * of the thing actually being read. Every byte returned comes from the descriptor that passed the
 * check, which is the only version of "the file that was checked is the file that was read" that
 * survives a concurrent writer.
 */
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { isInside } from '../archive/safe-path.js';
import { ResourceBudgetError } from '../budgets.js';
import { IngestError } from '../errors.js';
import type { DocumentSourceKind, IngestCandidate, JsonObject } from '../types.js';

/**
 * The file at that path is not the file the scan checked.
 *
 * A refusal rather than a silent re-read, because the two are different documents and the
 * candidate's `revision`, `byteSize` and containment check all describe the first one. P3: the
 * pipeline routes this to the review queue with the reason, and the file is still on disk.
 */
export class SourceFileChangedError extends IngestError {
  constructor(path: string, reason: string) {
    super(
      `'${path}' is not the file that was offered: ${reason}. It was not read, because the ` +
        'containment check and the size limit were made against the file that was there then.',
      'source_changed_before_read',
      { path, reason },
    );
  }
}

export interface BufferCandidateOptions {
  sourceId?: string;
  sourceKind?: DocumentSourceKind;
  externalId?: string;
  revision?: string;
  filename?: string;
  mediaType?: string;
  observedAt?: string;
  sourceMetadata?: JsonObject;
}

/** Bytes already in memory: an API upload, a connector capture, a test. */
export const bufferCandidate = (
  bytes: Buffer,
  options: BufferCandidateOptions = {},
): IngestCandidate => ({
  ref: {
    sourceId: options.sourceId ?? 'upload',
    externalId: options.externalId ?? options.filename ?? 'buffer',
    ...(options.revision === undefined ? {} : { revision: options.revision }),
  },
  sourceKind: options.sourceKind ?? 'upload',
  ...(options.filename === undefined ? {} : { suggestedFilename: options.filename }),
  ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
  ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
  ...(options.sourceMetadata === undefined ? {} : { sourceMetadata: options.sourceMetadata }),
  read: async () => bytes,
});

export interface FileCandidateOptions extends Omit<BufferCandidateOptions, 'filename'> {
  /** Override the filename taken from the path. */
  filename?: string;
  /**
   * Refuse to read more than this many bytes.
   *
   * Enforced by the read, against the size of the descriptor actually opened — not against the
   * `stat` taken when the candidate was made, which is a number about a file that may since have
   * grown.
   */
  maxBytes?: number;
}

/** A file on disk. The path is the `externalId`, and the mtime is the revision. */
export const fileCandidate = async (
  path: string,
  options: FileCandidateOptions = {},
): Promise<IngestCandidate> => {
  const absolute = resolve(path);
  const info = await stat(absolute);
  // Identity, not metadata. `(dev, ino)` names the file itself; a size and an mtime name a
  // description of it that any writer — or any ordinary editor — can reproduce.
  const identity = { dev: info.dev, ino: info.ino };
  return {
    ref: {
      sourceId: options.sourceId ?? 'folder',
      externalId: options.externalId ?? absolute,
      revision: options.revision ?? `${String(info.mtimeMs)}:${String(info.size)}`,
    },
    sourceKind: options.sourceKind ?? 'folder',
    suggestedFilename: options.filename ?? basename(absolute),
    ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
    observedAt: options.observedAt ?? new Date(info.mtimeMs).toISOString(),
    sourceMetadata: {
      ...(options.sourceMetadata ?? {}),
      path: absolute,
      byteSize: info.size,
    },
    read: async () => readChecked(absolute, identity, options.maxBytes),
  };
};

/**
 * Open the file the scan checked, prove it is still that file, and read it under a ceiling.
 *
 * Three things happen in an order that matters. `O_NOFOLLOW` refuses a final component that has
 * become a symbolic link — which is the substitution that turns a watched folder into a reader of
 * `/etc`. `fstat` on the open descriptor, compared against the scan's device and inode, catches
 * every other spelling of the same substitution, including a directory along the path having been
 * swapped. And the read is bounded and taken *from the descriptor*, so nothing between here and
 * the last byte can change what is being read.
 */
const readChecked = async (
  path: string,
  identity: { dev: number; ino: number },
  maxBytes: number | undefined,
): Promise<Buffer> => {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ELOOP') {
      throw new SourceFileChangedError(path, 'it is now a symbolic link');
    }
    throw error;
  }

  try {
    const info = await handle.stat();
    if (info.dev !== identity.dev || info.ino !== identity.ino) {
      throw new SourceFileChangedError(
        path,
        `it is now a different file (inode ${String(identity.ino)} then, ${String(info.ino)} now)`,
      );
    }
    if (!info.isFile()) throw new SourceFileChangedError(path, 'it is no longer a regular file');
    if (maxBytes !== undefined && info.size > maxBytes) {
      throw new ResourceBudgetError(
        'folder.maxBytes',
        maxBytes,
        `'${path}' is ${info.size} bytes, over the folder.maxBytes budget of ${maxBytes}. The ` +
          'size was taken from the open descriptor, not from the scan.',
        { path, byteSize: info.size },
      );
    }

    // Read at most what is allowed, and one byte more, so that a file growing under the read is a
    // refusal rather than a silent truncation.
    const ceiling = maxBytes ?? info.size;
    const buffer = Buffer.alloc(Math.min(info.size, ceiling) + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
      if (filled === buffer.length) break;
    }
    if (filled > ceiling) {
      throw new ResourceBudgetError(
        'folder.maxBytes',
        ceiling,
        `'${path}' grew past ${ceiling} bytes while it was being read, so it was refused rather ` +
          'than filed as a fragment of itself.',
        { path },
      );
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
};

export interface FolderScanOptions extends Omit<FileCandidateOptions, 'externalId' | 'revision'> {
  /** Descend into subdirectories. */
  recursive?: boolean;
  /** Skip names beginning with a dot, and the partial-download suffixes scanners leave behind. */
  skipHidden?: boolean;
  /** Refuse a file larger than this rather than reading it into memory. */
  maxBytes?: number;
}

export interface FolderScan {
  candidates: IngestCandidate[];
  /** Entries that were not offered, and why. Reported, never silently dropped. */
  skipped: Array<{ path: string; reason: string }>;
}

const PARTIAL_SUFFIXES = ['.part', '.crdownload', '.tmp', '.filepart', '.!ut'];

/** Every regular file under `root`, as candidates, with the unsafe ones named rather than read. */
export const folderCandidates = async (
  root: string,
  options: FolderScanOptions = {},
): Promise<FolderScan> => {
  const realRoot = await realpath(resolve(root));
  const candidates: IngestCandidate[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(directory, entry.name);

      if (options.skipHidden !== false && entry.name.startsWith('.')) {
        skipped.push({ path: child, reason: 'the name begins with a dot' });
        continue;
      }
      if (PARTIAL_SUFFIXES.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) {
        skipped.push({ path: child, reason: 'the name looks like a partial download' });
        continue;
      }

      // Resolve first, check second. A symlink that points outside the watched root is the
      // filesystem's version of an archive member called `../../etc/passwd`, and it gets the same
      // answer: refused by name.
      let real: string;
      try {
        real = await realpath(child);
      } catch (error) {
        skipped.push({ path: child, reason: `it could not be resolved: ${String(error)}` });
        continue;
      }
      if (!isInside(realRoot, real)) {
        skipped.push({ path: child, reason: `it resolves to '${real}', outside the watched folder` });
        continue;
      }

      const info = await stat(real);
      if (info.isDirectory()) {
        if (options.recursive === false) {
          skipped.push({ path: child, reason: 'it is a directory and the scan is not recursive' });
          continue;
        }
        await walk(real);
        continue;
      }
      if (!info.isFile()) {
        skipped.push({ path: child, reason: 'it is not a regular file' });
        continue;
      }
      if (options.maxBytes !== undefined && info.size > options.maxBytes) {
        skipped.push({
          path: child,
          reason: `it is ${String(info.size)} bytes, over the ${String(options.maxBytes)}-byte limit`,
        });
        continue;
      }

      candidates.push(
        // `maxBytes` travels with the candidate rather than staying behind in the scan, because a
        // limit compared against a `stat` and then not carried to the read is a description of a
        // limit. The scan's own check stays: refusing early is cheaper than refusing late.
        await fileCandidate(real, {
          ...options,
          sourceId: options.sourceId ?? realRoot,
          // The path relative to the watched root, so moving the whole folder does not turn every
          // file into a new candidate.
          externalId: real.slice(realRoot.length + 1),
        }),
      );
    }
  };

  await walk(realRoot);
  return { candidates, skipped };
};
