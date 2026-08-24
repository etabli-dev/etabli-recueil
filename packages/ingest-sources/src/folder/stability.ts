/**
 * Deciding that a file has finished arriving.
 *
 * A watched folder is fed by things that write slowly: a scanner streaming a fifty-page duplex job,
 * a sync client pulling a file down in chunks, `cp` over a slow USB bridge. Ingesting one of those
 * mid-copy produces a document whose hash is the hash of half a file — and because identity is the
 * hash (P2), that half file is a *different* document from the whole one, so the mistake is not
 * corrected when the copy finishes. It is filed for ever as a truncated PDF.
 *
 * There is no portable way to ask a kernel "is anyone writing to this file". What is portable is
 * evidence: two stats a moment apart that agree on size and mtime, plus a quiet period since the
 * last write. Both are needed. Two stats taken 250 ms apart can straddle a pause in a slow copy;
 * a quiet period alone says nothing about a file being written at a steady rate.
 *
 * What this cannot do, stated plainly rather than hidden: a writer that stalls for longer than
 * `quietMillis` mid-file and then resumes will be read while incomplete. The defences against that
 * are conventions rather than detection — the partial-name suffixes `scanFolder` refuses, and the
 * write-then-rename that every well-behaved producer (including the Brother ADS-4700W's FTP and
 * SMB targets, and every Nextcloud client) uses. `README.md` says which to configure.
 */
import { stat } from 'node:fs/promises';

import type { SkippedEntry } from '../types.js';
import type { FolderEntry } from './scan.js';

export interface StabilityOptions {
  /** How long since the last write before a file counts as settled. Default 2 s. */
  quietMillis?: number;
  /** The gap between the two stats. Default 250 ms. */
  pollMillis?: number;
  /** How many further stats to take after the scan's own. Default 1, i.e. two in total. */
  checks?: number;
}

export const DEFAULT_STABILITY = { quietMillis: 2_000, pollMillis: 250, checks: 1 } as const;

export interface StabilityResult {
  stable: FolderEntry[];
  /** Files that are still arriving. Reported so the poll is honest about what it saw. */
  unsettled: SkippedEntry[];
}

const sleep = (millis: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, millis);
    // Unref so a pending stability wait never keeps a process alive on its own.
    timer.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      { once: true },
    );
  });

/**
 * Split a scan's entries into the ones that have settled and the ones still arriving.
 *
 * One sleep for the whole batch rather than one per file: a folder with two hundred files in it
 * should not take fifty seconds to decide, and the comparison is per file either way.
 */
export const selectStable = async (
  entries: readonly FolderEntry[],
  options: StabilityOptions = {},
  signal?: AbortSignal,
): Promise<StabilityResult> => {
  if (entries.length === 0) return { stable: [], unsettled: [] };

  const quietMillis = options.quietMillis ?? DEFAULT_STABILITY.quietMillis;
  const pollMillis = options.pollMillis ?? DEFAULT_STABILITY.pollMillis;
  const checks = Math.max(1, options.checks ?? DEFAULT_STABILITY.checks);

  let candidates = [...entries];
  const unsettled: SkippedEntry[] = [];

  for (let pass = 0; pass < checks && candidates.length > 0; pass += 1) {
    await sleep(pollMillis, signal);
    if (signal?.aborted === true) break;

    const survivors: FolderEntry[] = [];
    for (const entry of candidates) {
      const info = await stat(entry.absolutePath).catch(() => null);
      if (info === null) {
        unsettled.push({
          externalId: entry.relativePath,
          reason: 'it disappeared while its stability was being checked',
        });
        continue;
      }
      if (info.size !== entry.byteSize || info.mtimeMs !== entry.mtimeMs) {
        unsettled.push({
          externalId: entry.relativePath,
          reason:
            `it changed while being watched — ${String(entry.byteSize)} bytes at ` +
            `${new Date(entry.mtimeMs).toISOString()}, then ${String(info.size)} bytes at ` +
            `${new Date(info.mtimeMs).toISOString()} — so it is still being written`,
          });
        continue;
      }
      survivors.push(entry);
    }
    candidates = survivors;
  }

  const now = Date.now();
  const stable: FolderEntry[] = [];
  for (const entry of candidates) {
    const age = now - entry.mtimeMs;
    // A negative age is a file whose mtime is in the future: a clock skew between a NAS and this
    // host, or a sync client preserving a stamp. Waiting for a quiet period that has not started
    // would mean waiting for ever, so the two agreeing stats are taken as the evidence instead.
    if (age >= 0 && age < quietMillis) {
      unsettled.push({
        externalId: entry.relativePath,
        reason:
          `it was last written ${String(age)} ms ago and the quiet period is ` +
          `${String(quietMillis)} ms`,
      });
      continue;
    }
    stable.push(entry);
  }

  return { stable, unsettled };
};
