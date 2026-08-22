/**
 * The verification report (CONCEPT §6, §7 Phase 1 exit).
 *
 * "Own library imported at 100% item count with attachment-hash coverage report" is the M1 exit
 * criterion, and this is the artefact that decides it. Two rules shape the whole structure.
 *
 * **It is machine-readable first.** The JSON below is the report; the Markdown rendering is a view
 * of it. A number a person reads in the Markdown and a number a test asserts against are then the
 * same number by construction, and the exit criterion is a `pass` field rather than a judgement.
 *
 * **It says what did not happen.** Counts that match are the easy half. Every record that was
 * skipped, every attachment whose file was not found, every field that had no column, every tag on
 * a note that Recueil cannot represent, and every citation key whose three sources disagreed is
 * listed individually with its reason (P3). A report that only showed the successes would pass on
 * an importer that dropped half the library and counted the other half twice.
 */

/** The `schema` field of the JSON report. Bumped when the shape changes incompatibly. */
export const REPORT_SCHEMA = 'recueil.zotero-import-report/1';

/** Where the report's numbers came from. */
export interface ReportSource {
  databasePath: string;
  /** SHA-256 of `zotero.sqlite` at the moment the import started. */
  databaseSha256: string;
  /** The same digest taken after the run. Equal to the first, or the run touched the source. */
  databaseSha256AfterRun: string;
  /** False if the two digests differ, which would mean this importer, or Zotero, wrote to it. */
  sourceUnchanged: boolean;
  libraryId: number;
  libraryType: string | null;
  localUserKey: string | null;
  zoteroUserdataVersion: number | null;
  zoteroGlobalSchemaVersion: number | null;
  zoteroClientVersion: string | null;
  betterBibtexPath: string | null;
  storageDirectory: string | null;
  linkedAttachmentBase: string | null;
  webdavDirectory: string | null;
}

export interface ReportRun {
  jobId: string;
  idempotencyKey: string;
  runLabel: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempt: number;
  /** The stage this run picked up from, when it resumed an interrupted one. */
  resumedFromStage: string | null;
}

/** One row of the per-type parity table, which is what "100% item count" is measured on. */
export interface ItemTypeParity {
  zoteroType: string;
  recueilType: string;
  zoteroLive: number;
  zoteroTrashed: number;
  zoteroTotal: number;
  recueilLive: number;
  recueilTrashed: number;
  recueilTotal: number;
  /** `recueilTotal - zoteroTotal`. Zero on every row is the exit criterion. */
  delta: number;
}

export interface ItemCounts {
  byType: ItemTypeParity[];
  zoteroRegularTotal: number;
  recueilRegularTotal: number;
  delta: number;
  /**
   * Items Recueil created that have no Zotero regular item behind them — currently one per
   * standalone Zotero attachment, which needs a host item because `attachments.item_id` is not
   * nullable. Counted apart from parity, because counting them in would flatter it.
   */
  derived: number;
  derivedReason: string;
}

export type AttachmentStatus = 'resolved' | 'missing' | 'unreadable' | 'no_file';

export interface AttachmentReportEntry {
  zoteroKey: string;
  parentZoteroKey: string | null;
  title: string | null;
  linkMode: string;
  status: AttachmentStatus;
  /** Where the bytes came from: `storage`, `linked`, `webdav`. */
  origin: string | null;
  sha256: string | null;
  byteSize: number | null;
  /** Whether Zotero's recorded MD5 still matches. Null when Zotero recorded none. */
  matchesZoteroHash: boolean | null;
  /** How the attachment ended up in Recueil: `stored`, `linked_file`, `linked_url`, or `skipped`. */
  recueilLinkMode: string | null;
  reason: string | null;
  expectedPath: string | null;
}

/** The attachment-hash coverage the exit criterion names. */
export interface AttachmentCoverage {
  total: number;
  byLinkMode: Record<string, number>;
  /** Attachments claiming a file — everything but a linked URL. The denominator of coverage. */
  claimingFile: number;
  resolved: number;
  missing: number;
  unreadable: number;
  bookmarks: number;
  /** `resolved / claimingFile`, to one decimal place. 100 when nothing claims a file. */
  hashCoveragePercent: number;
  /** Resolved files whose bytes no longer match the MD5 Zotero recorded. */
  hashMismatches: number;
  /** Distinct SHA-256 digests, which is the number of Documents the import created or reused. */
  distinctDocuments: number;
  recueilAttachments: number;
  entries: AttachmentReportEntry[];
}

export interface CollectionReconciliation {
  zoteroTotal: number;
  zoteroLive: number;
  zoteroTrashed: number;
  recueilTotal: number;
  recueilTrashed: number;
  maxDepth: number;
  zoteroMemberships: number;
  recueilMemberships: number;
  /** Memberships whose member is a note or an annotation, which Recueil files by item only. */
  membershipsSkipped: number;
}

export interface TagReconciliation {
  zoteroTotal: number;
  recueilTotal: number;
  manual: number;
  automatic: number;
  coloured: number;
  zoteroAssignments: number;
  itemAssignments: number;
  annotationAssignments: number;
  /** Assignments Recueil has no join table for — a tag on a note. */
  assignmentsSkipped: number;
}

export interface NoteReconciliation {
  zoteroTotal: number;
  zoteroChild: number;
  zoteroStandalone: number;
  recueilTotal: number;
  recueilChild: number;
  recueilStandalone: number;
  recueilTrashed: number;
  delta: number;
}

export interface AnnotationReconciliation {
  zoteroTotal: number;
  recueilTotal: number;
  byType: Record<string, number>;
  external: number;
  skipped: number;
  delta: number;
}

export interface RelationReconciliation {
  zoteroTotal: number;
  byPredicate: Record<string, number>;
  /** Relations whose object is an item in this library. */
  resolved: number;
  /** Relations pointing at an item that is not here — a group library, or a deleted item. */
  dangling: number;
  /** Items carrying at least one relation, each of which holds them in `zotero_relations`. */
  itemsCarrying: number;
}

export interface CreatorReconciliation {
  zoteroTotal: number;
  recueilTotal: number;
  singleField: number;
  zoteroAppearances: number;
  recueilAppearances: number;
  /** Zotero creator types with no Recueil role of their own, by type. */
  lossyRoles: Record<string, number>;
}

export interface CitationKeyReconciliation {
  itemsWithKey: number;
  itemsWithoutKey: number;
  bySource: Record<string, number>;
  pinned: number;
  generated: number;
  /** Items whose native field, `Extra` line and Better BibTeX row do not agree. */
  conflicts: number;
  betterBibtexRows: number;
  /** Better BibTeX rows naming an item that is not in this library. */
  betterBibtexStale: number;
  /** Keys that could not be written because a live item already held them. */
  collisions: number;
}

export interface TrashReconciliation {
  zoteroDeletedRows: number;
  zoteroDeletedItems: number;
  zoteroDeletedNotes: number;
  zoteroDeletedAttachments: number;
  zoteroDeletedCollections: number;
  recueilTrashedItems: number;
  recueilTrashedNotes: number;
  recueilTrashedAttachments: number;
  recueilTrashedCollections: number;
  /** Children trashed because their parent was, which Zotero hides but does not list. */
  cascaded: number;
}

/** A record the importer did not write, and why. */
export interface SkippedRecord {
  kind: string;
  zoteroKey: string | null;
  subject: string;
  reason: string;
}

/** Something a person has to look at (P3, CONCEPT §6's `_REVIEW/`). */
export interface ReviewEntry {
  kind: string;
  zoteroKey: string | null;
  subject: string;
  reason: string;
  proposedAction: string;
  detail?: Record<string, unknown>;
}

/** A field that could not go into a facet column. */
export interface CarriedFieldSummary {
  zoteroField: string;
  fieldKey: string;
  reason: string;
  count: number;
}

/** One named assertion, so that `pass` can be traced to the checks that decided it. */
export interface ReportCheck {
  name: string;
  description: string;
  pass: boolean;
  expected: number | string;
  actual: number | string;
  /** False when the check is informational and does not affect `pass`. */
  blocking: boolean;
}

export interface ZoteroImportReport {
  schema: typeof REPORT_SCHEMA;
  generatedAt: string;
  /** The top-level verdict: exact item-count parity, and nothing dropped without a reason. */
  pass: boolean;
  source: ReportSource;
  run: ReportRun;
  items: ItemCounts;
  attachments: AttachmentCoverage;
  collections: CollectionReconciliation;
  tags: TagReconciliation;
  notes: NoteReconciliation;
  annotations: AnnotationReconciliation;
  relations: RelationReconciliation;
  creators: CreatorReconciliation;
  citationKeys: CitationKeyReconciliation;
  trash: TrashReconciliation;
  carriedFields: CarriedFieldSummary[];
  skipped: SkippedRecord[];
  review: ReviewEntry[];
  checks: ReportCheck[];
}
