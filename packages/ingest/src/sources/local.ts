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
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { isInside } from '../archive/safe-path.js';
import type { DocumentSourceKind, IngestCandidate, JsonObject } from '../types.js';

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
}

/** A file on disk. The path is the `externalId`, and the mtime is the revision. */
export const fileCandidate = async (
  path: string,
  options: FileCandidateOptions = {},
): Promise<IngestCandidate> => {
  const absolute = resolve(path);
  const info = await stat(absolute);
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
    read: async () => readFile(absolute),
  };
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
