/**
 * `@recueil/import-zotero` — the Zotero migrator.
 *
 * CONCEPT §6 makes Zotero migration first-class and §7 makes it the M1 exit criterion: "own library
 * imported at 100% item count with attachment-hash coverage report". This package is that, and the
 * report is the artefact the criterion is judged on.
 *
 * ```ts
 * const recueil = createRecueil({ databaseUrl: 'library.sqlite', storagePath: 'store' });
 * const { report } = await importZoteroLibrary(recueil, {
 *   databasePath: '/home/me/Zotero/zotero.sqlite',
 *   reportDirectory: './zotero-import',
 * });
 * if (!report.pass) process.exitCode = 1;
 * ```
 *
 * The source library is never written to. `reader/readonly-db.ts` copies it, opens the copy
 * read-only, sets `PRAGMA query_only` and refuses any statement that is not a `SELECT`, and the
 * report states the digest of the original before and after the run.
 */
export { ImportCancelledError, IMPORT_SOURCE, SOURCE_SYSTEM, importZoteroLibrary } from './import.js';
export type { ItemPlan, ZoteroImportOptions, ZoteroImportResult } from './import.js';

/* The run record: the `jobs` row that makes an import idempotent and resumable (P9) --------------- */
export {
  IMPORT_STAGES,
  findImportJob,
  importIdempotencyKey,
  libraryHash,
} from './job.js';
export type { ImportCursor, ImportProgress, ImportStage } from './job.js';

/* Reading `zotero.sqlite`, and doing so safely ---------------------------------------------------- */
export { ReadOnlyDatabase, ReadOnlyViolationError, fingerprintFile } from './reader/readonly-db.js';
export type { OpenReadOnlyOptions, SourceFingerprint } from './reader/readonly-db.js';
export { ZoteroLibrary, readBetterBibtexKeys } from './reader/zotero-library.js';
export type { ZoteroGlobalSchema, ZoteroLibraryOptions } from './reader/zotero-library.js';
export { ZOTERO_ANNOTATION_TYPES, ZOTERO_LINK_MODES } from './reader/types.js';
export type {
  BetterBibtexKeyRow,
  ZoteroAnnotationRow,
  ZoteroAnnotationType,
  ZoteroAttachmentRow,
  ZoteroCollectionItemRow,
  ZoteroCollectionRow,
  ZoteroCreatorRow,
  ZoteroFieldValue,
  ZoteroItemCreatorRow,
  ZoteroItemRow,
  ZoteroItemTagRow,
  ZoteroLinkMode,
  ZoteroNoteRow,
  ZoteroPosition,
  ZoteroRelationRow,
  ZoteroTagColour,
  ZoteroTagRow,
} from './reader/types.js';

/* Attachment resolution --------------------------------------------------------------------------- */
export { claimsFile, linkModeName, resolveAttachment } from './attachments.js';
export type {
  AttachmentOrigin,
  AttachmentResolution,
  AttachmentSources,
  ResolvedAttachment,
  UnresolvedAttachment,
} from './attachments.js';
export { ZipError, crc32, readZipDirectory, readZipEntry } from './zip.js';
export type { ZipEntry } from './zip.js';

/* Rediscovering the correspondence from the two databases ------------------------------------------ */
export {
  findItemByZoteroKey,
  importedDocumentIds,
  importedItemIds,
  reconcileAttachments,
} from './reconcile.js';
export type { AttachmentCorrespondence } from './reconcile.js';

/* The mapping ------------------------------------------------------------------------------------- */
export {
  CSL_TYPE_BY_ZOTERO_TYPE,
  ITEM_TYPE_MAP,
  mapZoteroItemType,
  slugify,
} from './map/item-types.js';
export type { ItemTypeMapping, ItemTypeMappingKind } from './map/item-types.js';
export { mapZoteroDate, mapZoteroTimestamp } from './map/dates.js';
export type { MappedDate } from './map/dates.js';
export { parseExtra } from './map/extra.js';
export type { ExtraLine, ParsedExtra } from './map/extra.js';
export { CREATOR_ROLE_MAP, creatorIdentity, mapCreatorName, mapCreatorRole } from './map/creators.js';
export type { MappedCreatorName, MappedCreatorRole } from './map/creators.js';
export { mapZoteroFields, parsePageSpan } from './map/fields.js';
export type { CarriedField, MapFieldsContext, MappedFields } from './map/fields.js';
export { resolveCitationKey } from './map/citation-keys.js';
export type { CitationKeyCandidate, CitationKeyInputs, CitationKeySource, ResolvedCitationKey } from './map/citation-keys.js';
export { UnmappableAnnotationError, mapZoteroAnnotation, normaliseSortIndex } from './map/annotations.js';
export type { AnnotationSelector, MappedAnnotation, Rectangle } from './map/annotations.js';

/* The verification report --------------------------------------------------------------------------- */
export { REPORT_SCHEMA } from './report/types.js';
export type {
  AnnotationReconciliation,
  AttachmentCoverage,
  AttachmentReportEntry,
  AttachmentStatus,
  CarriedFieldSummary,
  CitationKeyReconciliation,
  CollectionReconciliation,
  CreatorReconciliation,
  ItemCounts,
  ItemTypeParity,
  NoteReconciliation,
  RelationReconciliation,
  ReportCheck,
  ReportRun,
  ReportSource,
  ReviewEntry,
  SkippedRecord,
  SourceLibrarySummary,
  TagReconciliation,
  TrashReconciliation,
  ZoteroImportReport,
} from './report/types.js';
export { buildReport, readImportLog } from './report/build.js';
export type { BuildReportInput, ImportLog } from './report/build.js';
export { renderReportMarkdown } from './report/markdown.js';
export { writeReport } from './report/write.js';
export type { ReportPaths } from './report/write.js';
