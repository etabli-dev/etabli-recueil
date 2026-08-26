/**
 * Walking a watched folder, safely.
 *
 * A watched folder is a directory a person — or a scanner, or a phone, or a sync client — drops
 * files into, so every name inside it is untrusted in exactly the way an archive member name is:
 * `..` in a name, a symlink pointing at `/etc`, a directory that is itself a link to somewhere
 * else. One of the carried findings from the Phase 1 review says it plainly: *a path that arrives
 * in a manifest, an archive entry, a filename or a URL is hostile until it has been resolved and
 * checked to be inside its root.* So every entry is resolved with `realpath` and checked against
 * the resolved root **before** it is opened, and one that is not inside is reported by name rather
 * than read.
 *
 * `@recueil/ingest` has `folderCandidates`, which does the same walk and hands back candidates.
 * This walk exists alongside it because a watched folder needs the entries *before* they become
 * candidates: stability is decided by comparing two stats of the same file taken a moment apart,
 * and the consume policy needs the absolute path to move or delete afterwards.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { isInside } from '@recueil/ingest';

import type { SkippedEntry } from '../types.js';

export interface FolderEntry {
  /** Path relative to the resolved root, with `/` separators. The candidate's `externalId`. */
  relativePath: string;
  absolutePath: string;
  byteSize: number;
  mtimeMs: number;
  /**
   * `dev/ino` of the file this entry was built from.
   *
   * Carried because size and mtime alone cannot tell a rewrite in place from the write-then-rename
   * a well-behaved producer does: the inode is what distinguishes *this* file from a different one
   * that has taken its name. `revision.ts` says what it is compared against and when.
   */
  inode: string;
}

export interface FolderScanOptions {
  recursive?: boolean;
  skipHidden?: boolean;
  maxBytes?: number;
  /**
   * Directories never descended into: the processed and failed trees of a consume policy.
   *
   * An entry with no `/` in it is a *name*, excluded wherever it appears in the tree. An entry with
   * a `/` in it is a path relative to the root, excluded only at that exact place — which is what
   * a nested consume destination such as `archive/processed` needs, and what it did not get before
   * (excluding its first segment hid the whole `archive` tree from every scan).
   */
  excludeDirectories?: readonly string[];
}

export interface FolderScanResult {
  root: string;
  entries: FolderEntry[];
  skipped: SkippedEntry[];
}

/** The suffixes a partially written file wears while it is still arriving. */
export const PARTIAL_SUFFIXES = [
  '.part',
  '.partial',
  '.crdownload',
  '.download',
  '.tmp',
  '.temp',
  '.filepart',
  '.!ut',
  '.lock',
] as const;

export const looksPartial = (name: string): boolean => {
  const lower = name.toLowerCase();
  if (PARTIAL_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  // Office and LibreOffice lock files, and the `~$` shadow copies Word leaves behind.
  return lower.startsWith('~$') || lower.startsWith('.~lock.');
};

/** Every regular file under `root`, with the unsafe and the not-yet-arrived ones named. */
export const scanFolder = async (
  root: string,
  options: FolderScanOptions = {},
): Promise<FolderScanResult> => {
  const realRoot = await realpath(resolve(root));
  const entries: FolderEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const excluded = new Set(options.excludeDirectories ?? []);
  const seenDirectories = new Set<string>();

  const walk = async (directory: string): Promise<void> => {
    // A directory reached twice is a link loop. Two symlinked directories pointing at each other
    // would otherwise recurse until the process dies.
    if (seenDirectories.has(directory)) return;
    seenDirectories.add(directory);

    const listing = await readdir(directory, { withFileTypes: true });
    for (const child of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, child.name);
      const relative = path.slice(realRoot.length + 1).split(sep).join('/');

      if (options.skipHidden !== false && child.name.startsWith('.')) {
        skipped.push({ externalId: relative, reason: 'the name begins with a dot' });
        continue;
      }
      if (child.isDirectory() && (excluded.has(child.name) || excluded.has(relative))) {
        skipped.push({ externalId: relative, reason: 'the directory is excluded from the scan' });
        continue;
      }
      if (!child.isDirectory() && looksPartial(child.name)) {
        skipped.push({
          externalId: relative,
          reason: 'the name is one a half-written file wears, so it has not finished arriving',
        });
        continue;
      }

      // Resolve first, check second.
      let real: string;
      try {
        real = await realpath(path);
      } catch (error) {
        skipped.push({
          externalId: relative,
          reason: `it could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (!isInside(realRoot, real)) {
        skipped.push({
          externalId: relative,
          reason: `it resolves to '${real}', outside the watched folder`,
        });
        continue;
      }

      const info = await stat(real).catch(() => null);
      if (info === null) {
        skipped.push({ externalId: relative, reason: 'it disappeared between the listing and the stat' });
        continue;
      }
      if (info.isDirectory()) {
        if (options.recursive === false) {
          skipped.push({ externalId: relative, reason: 'it is a directory and the scan is not recursive' });
          continue;
        }
        await walk(real);
        continue;
      }
      if (!info.isFile()) {
        skipped.push({ externalId: relative, reason: 'it is not a regular file' });
        continue;
      }
      if (info.size === 0) {
        skipped.push({ externalId: relative, reason: 'it is empty, so it has either not arrived or has nothing in it' });
        continue;
      }
      if (options.maxBytes !== undefined && info.size > options.maxBytes) {
        skipped.push({
          externalId: relative,
          reason: `it is ${String(info.size)} bytes, over the ${String(options.maxBytes)}-byte limit`,
        });
        continue;
      }

      entries.push({
        relativePath: real.slice(realRoot.length + 1).split(sep).join('/'),
        absolutePath: real,
        byteSize: info.size,
        mtimeMs: info.mtimeMs,
        inode: `${String(info.dev)}/${String(info.ino)}`,
      });
    }
  };

  await walk(realRoot);
  return { root: realRoot, entries, skipped };
};
