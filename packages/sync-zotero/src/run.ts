/**
 * Syncing every library an API key can reach, and deciding conflicts.
 */
import type { Recueil } from '@recueil/core';

import type { ZoteroApiClient } from './api/client.js';
import type { ZoteroLibraryRef } from './api/types.js';
import type { SyncReport } from './report.js';
import { SyncState } from './state.js';
import { ZoteroSync } from './sync.js';
import type { ZoteroSyncOptions } from './sync.js';
import { ZoteroSchema } from './zotero-schema.js';

export interface SyncTarget extends ZoteroLibraryRef {
  name: string | null;
  /** Whether the key may write to this library. A read-only library is pulled only. */
  writable: boolean;
}

export interface SyncAllOptions extends Omit<ZoteroSyncOptions, 'library' | 'libraryName' | 'home' | 'schema'> {
  /** Restrict the run to these libraries (`user` or `group:<id>`). Default: every one the key reaches. */
  only?: readonly string[];
  /** The library new Recueil objects are created in. Default: the user library. */
  home?: string;
}

const refName = (ref: ZoteroLibraryRef): string => (ref.type === 'user' ? 'user' : `group:${ref.id}`);

/** Every library the key can read, and whether it may write there. */
export const discoverLibraries = async (client: ZoteroApiClient): Promise<SyncTarget[]> => {
  const key = await client.keyInfo();
  const targets: SyncTarget[] = [];
  if (key.access.user?.library === true) {
    targets.push({ type: 'user', id: key.userID, name: key.username, writable: key.access.user.write === true });
  }
  const groupAccess = key.access.groups ?? {};
  if (Object.keys(groupAccess).length > 0) {
    for (const group of await client.groups(key.userID)) {
      const access = groupAccess[String(group.id)] ?? groupAccess['all'];
      if (access?.library !== true) continue;
      targets.push({ type: 'group', id: group.id, name: group.data.name, writable: access.write === true });
    }
  }
  return targets;
};

/**
 * Sync every library the key reaches.
 *
 * All pulls run before any push. Otherwise a new-looking Recueil object that a later library's
 * pull would have claimed — a collection imported from a group library, say — could be pushed into
 * the home library first, and exist twice.
 */
export const syncZoteroLibraries = async (
  recueil: Recueil,
  client: ZoteroApiClient,
  options: SyncAllOptions = {},
): Promise<SyncReport[]> => {
  const schema = new ZoteroSchema(await client.schema());
  const home = options.home ?? 'user';
  const direction = options.direction ?? 'both';
  const targets = (await discoverLibraries(client)).filter(
    (target) => options.only === undefined || options.only.includes(refName(target)),
  );

  const run = (target: SyncTarget, phase: 'pull' | 'push') =>
    new ZoteroSync(recueil, client, {
      ...options,
      library: { type: target.type, id: target.id },
      libraryName: target.name,
      home: refName(target) === home && target.writable,
      direction: phase,
      schema,
    }).run();

  // A dry run is one transaction over every library, so the push half plans against what the
  // pull half would have written — and all of it is rolled back at the end.
  const connection = recueil.connection;
  const dryRun = options.dryRun === true && !connection.inTransaction;
  if (dryRun) connection.exec('BEGIN');
  try {
    const pulls = new Map<string, SyncReport>();
    if (direction !== 'push') {
      for (const target of targets) pulls.set(refName(target), await run(target, 'pull'));
    }
    const reports: SyncReport[] = [];
    for (const target of targets) {
      const pulled = pulls.get(refName(target));
      const pushed = direction !== 'pull' && target.writable ? await run(target, 'push') : undefined;
      reports.push(combineReports(pulled, pushed, direction));
    }
    return reports;
  } finally {
    if (dryRun) connection.exec('ROLLBACK');
  }
};

/** One report per library from its pull half and its push half. */
const combineReports = (
  pulled: SyncReport | undefined,
  pushed: SyncReport | undefined,
  direction: SyncReport['direction'],
): SyncReport => {
  if (pulled === undefined) return { ...pushed!, direction };
  if (pushed === undefined) return { ...pulled, direction };
  return {
    ...pulled,
    direction,
    finishedAt: pushed.finishedAt,
    toZotero: pushed.toZotero,
    files: {
      downloaded: pulled.files.downloaded + pushed.files.downloaded,
      uploaded: pulled.files.uploaded + pushed.files.uploaded,
      alreadyThere: pulled.files.alreadyThere + pushed.files.alreadyThere,
      skipped: pulled.files.skipped + pushed.files.skipped,
    },
    conflicts: [...pulled.conflicts, ...pushed.conflicts],
    deferred: [...pulled.deferred, ...pushed.deferred],
    notPushed: [...pulled.notPushed, ...pushed.notPushed],
    review: [...pulled.review, ...pushed.review],
    errors: [...pulled.errors, ...pushed.errors],
  };
};

export type ResolveChoice = 'zotero' | 'recueil';

/** Decide an open conflict. The next sync applies the decision to both sides. */
export const resolveConflict = (recueil: Recueil, conflictId: string, choice: ResolveChoice): void => {
  const state = new SyncState(recueil);
  const conflict = state.getConflict(conflictId);
  if (conflict === undefined) throw new Error(`no conflict '${conflictId}'`);
  if (conflict.state !== 'open') throw new Error(`conflict '${conflictId}' is already ${conflict.state}`);
  state.decideConflict(conflictId, choice);
};
