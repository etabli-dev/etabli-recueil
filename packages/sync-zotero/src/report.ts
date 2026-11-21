/**
 * What a sync run did, or — under `--dry-run` — would do.
 */
import type { ZoteroLibraryRef } from './api/types.js';
import type { FieldConflict } from './merge.js';
import type { SyncObjectType } from './state.js';

export interface SyncCounts {
  created: number;
  updated: number;
  trashed: number;
  restored: number;
  unchanged: number;
  adopted: number;
}

export const emptyCounts = (): SyncCounts => ({
  created: 0,
  updated: 0,
  trashed: 0,
  restored: 0,
  unchanged: 0,
  adopted: 0,
});

export interface SyncEvent {
  objectType: SyncObjectType;
  key: string | null;
  recueilId: string | null;
  subject: string | null;
  message: string;
}

export interface SyncConflictEntry extends FieldConflict {
  objectType: SyncObjectType;
  key: string;
  recueilId: string | null;
  subject: string | null;
  /** What the policy did: `held` (review), `zotero` or `recueil`. */
  outcome: 'held' | 'zotero' | 'recueil';
}

export interface SyncReport {
  schema: 'recueil.sync-zotero/1';
  library: ZoteroLibraryRef & { name: string | null };
  dryRun: boolean;
  direction: 'both' | 'pull' | 'push';
  policy: 'review' | 'zotero' | 'recueil';
  startedAt: string;
  finishedAt: string;
  /** The library version the pull started from, and the one it reached. */
  sinceVersion: number;
  reachedVersion: number;
  /** Changes written into Recueil. */
  toRecueil: Record<SyncObjectType, SyncCounts>;
  /** Changes written to zotero.org. */
  toZotero: Record<SyncObjectType, SyncCounts>;
  files: { downloaded: number; uploaded: number; alreadyThere: number; skipped: number };
  conflicts: SyncConflictEntry[];
  /** Writes Zotero refused because the object changed meanwhile; the next run picks them up. */
  deferred: SyncEvent[];
  /** Local changes that have no place in Zotero's model, and so were not pushed. */
  notPushed: SyncEvent[];
  /** Things a person should look at. */
  review: SyncEvent[];
  errors: SyncEvent[];
}

const allCounts = (): Record<SyncObjectType, SyncCounts> => ({
  collection: emptyCounts(),
  item: emptyCounts(),
  note: emptyCounts(),
  attachment: emptyCounts(),
});

export const newReport = (input: {
  library: ZoteroLibraryRef & { name: string | null };
  dryRun: boolean;
  direction: SyncReport['direction'];
  policy: SyncReport['policy'];
  sinceVersion: number;
}): SyncReport => ({
  schema: 'recueil.sync-zotero/1',
  library: input.library,
  dryRun: input.dryRun,
  direction: input.direction,
  policy: input.policy,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  sinceVersion: input.sinceVersion,
  reachedVersion: input.sinceVersion,
  toRecueil: allCounts(),
  toZotero: allCounts(),
  files: { downloaded: 0, uploaded: 0, alreadyThere: 0, skipped: 0 },
  conflicts: [],
  deferred: [],
  notPushed: [],
  review: [],
  errors: [],
});

const total = (counts: Record<SyncObjectType, SyncCounts>, key: keyof SyncCounts): number =>
  Object.values(counts).reduce((sum, entry) => sum + entry[key], 0);

/** A short human summary, for the CLI. */
export const summariseReport = (report: SyncReport): string => {
  const lib = `${report.library.type} library ${report.library.id}${report.library.name ? ` (${report.library.name})` : ''}`;
  const line = (label: string, counts: Record<SyncObjectType, SyncCounts>): string =>
    `${label}: ${total(counts, 'created')} created, ${total(counts, 'updated')} updated, ` +
    `${total(counts, 'trashed')} trashed, ${total(counts, 'restored')} restored, ${total(counts, 'adopted')} adopted`;
  return [
    `${report.dryRun ? 'Dry run — nothing was written. ' : ''}Zotero ${lib}, version ${report.sinceVersion} → ${report.reachedVersion}`,
    line('Into Recueil', report.toRecueil),
    line('To zotero.org', report.toZotero),
    `Files: ${report.files.downloaded} downloaded, ${report.files.uploaded} uploaded, ${report.files.alreadyThere} already there, ${report.files.skipped} skipped`,
    `Conflicts: ${report.conflicts.length}; deferred: ${report.deferred.length}; not pushed: ${report.notPushed.length}; review: ${report.review.length}; errors: ${report.errors.length}`,
  ].join('\n');
};
