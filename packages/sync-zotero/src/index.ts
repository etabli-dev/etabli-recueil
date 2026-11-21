/**
 * `@recueil/sync-zotero` — two-way sync between a Recueil library and zotero.org (ADR-0025).
 *
 * ```ts
 * const client = new ZoteroApiClient({ apiKey: process.env.RECUEIL_ZOTERO_API_KEY! });
 * const report = await syncZoteroLibraries(recueil, client, { dryRun: true });
 * ```
 */
export {
  ZOTERO_API_BASE,
  ZOTERO_WRITE_BATCH,
  ZoteroApiClient,
  ZoteroApiError,
  ZoteroPreconditionError,
  libraryPrefix,
} from './api/client.js';
export type { FetchLike, ZoteroApiClientOptions } from './api/client.js';
export type * from './api/types.js';

export { ZoteroSchema } from './zotero-schema.js';
export { mergeThreeWay } from './merge.js';
export type { ConflictPolicy, FieldConflict, Flat, MergeOptions, MergeResult } from './merge.js';
export {
  COLUMN_BASE_FIELDS,
  SYNC_COLUMNS,
  creatorsKey,
  normaliseMarkdown,
  projectRecueilItem,
  projectRecueilNote,
  projectZoteroItem,
  projectZoteroNote,
  zoteroFieldValues,
} from './projection.js';
export type { ItemProjection, NoteProjection, ProjectedCreator } from './projection.js';
export { markdownToNoteHtml } from './note-html.js';
export { SyncState } from './state.js';
export type { SyncConflictRow, SyncLibraryRow, SyncLinkRow, SyncObjectType } from './state.js';
export { SYNC_SOURCE, ZoteroSync, newZoteroKey } from './sync.js';
export type { PushNewPolicy, SyncDirection, ZoteroSyncOptions } from './sync.js';
export { emptyCounts, newReport, summariseReport } from './report.js';
export type { SyncConflictEntry, SyncCounts, SyncEvent, SyncReport } from './report.js';
export { discoverLibraries, resolveConflict, syncZoteroLibraries } from './run.js';
export type { ResolveChoice, SyncAllOptions, SyncTarget } from './run.js';
