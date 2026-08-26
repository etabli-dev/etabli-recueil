/**
 * `@recueil/import-paperless` — the Paperless-ngx migrator.
 *
 * CONCEPT.md §6 makes Paperless-ngx the second first-class migration and §7 makes it the M2 exit
 * criterion: "Paperless decommissioned after verified import". This package is that importer, and
 * the report it produces is the artefact that decision is made on.
 *
 * ```ts
 * const recueil = createRecueil({ databaseUrl: 'library.sqlite', storagePath: 'store' });
 * const { report } = await importPaperless(recueil, {
 *   baseUrl: 'https://paperless.example',
 *   token: process.env.PAPERLESS_TOKEN,
 *   reportDirectory: './paperless-import',
 * });
 * if (!report.pass) process.exitCode = 1;
 * ```
 *
 * **This package has never spoken to a real Paperless-ngx server.** Every type, every route and
 * every envelope was transcribed from the published source of the release named in
 * `PAPERLESS_MODELLED_VERSION`, and the tests run against a faithful in-process fake of it. That is
 * enough to prove the mapping, the pagination, the resumption, the ASN rules and the report; it is
 * not a compatibility claim, and `README.md` §"What is unproven" says what would make it one.
 */

/* The importer ------------------------------------------------------------------------------------ */
export {
  ASN_FIELD_KEY,
  DOCUMENT_TYPE_FIELD_KEY,
  IMPORT_SOURCE,
  ImportCancelledError,
  SOURCE_SYSTEM,
  STORAGE_PATH_FIELD_KEY,
  importPaperless,
} from './import.js';
export type {
  ApiSnapshot,
  ImportPlan,
  PaperlessImportOptions,
  PaperlessImportResult,
} from './import.js';

/* The run record: the `jobs` row that makes an import idempotent and resumable (P9) ----------------- */
export {
  IMPORT_STAGES,
  JOB_TYPE,
  findImportJob,
  importIdempotencyKey,
  serverHash,
} from './job.js';
export type { ImportCursor, ImportProgress, ImportStage } from './job.js';

/* The client -------------------------------------------------------------------------------------- */
export { PaperlessClient, apiRootOf, dispositionFilename, safeBasename } from './client/client.js';
export type {
  DocumentPage,
  FetchLike,
  PaperlessClientOptions,
  PaperlessFile,
} from './client/client.js';
export {
  PaperlessApiVersionError,
  PaperlessAuthError,
  PaperlessError,
  PaperlessNotFoundError,
  PaperlessProtocolError,
  PaperlessUntrustedUrlError,
  redactUrl,
} from './client/errors.js';
export type { PaperlessErrorContext } from './client/errors.js';
export {
  PAPERLESS_API_VERSION,
  PAPERLESS_CUSTOM_FIELD_DATA_TYPES,
  PAPERLESS_MODELLED_VERSION,
  SUPPORTED_API_VERSIONS,
} from './client/types.js';
export type {
  PaperlessCorrespondent,
  PaperlessCustomField,
  PaperlessCustomFieldDataType,
  PaperlessCustomFieldInstance,
  PaperlessDocument,
  PaperlessDocumentMetadata,
  PaperlessDocumentType,
  PaperlessNote,
  PaperlessPage,
  PaperlessSelectOption,
  PaperlessServerInfo,
  PaperlessStoragePath,
  PaperlessTag,
} from './client/types.js';

/* The mapping -------------------------------------------------------------------------------------- */
export { slugify, uniqueSlug } from './map/slug.js';
export {
  DEFAULT_OFFICE_ITEM_TYPE,
  ITEM_TYPE_BY_DOCUMENT_TYPE,
  mapDocumentType,
} from './map/document-types.js';
export type { DocumentTypeMapping, DocumentTypeMappingKind } from './map/document-types.js';
export { documentDateOf, toDocumentDate, toInstant } from './map/dates.js';
export { minorUnitExponent, normaliseCurrency, parseMonetary, toMajorUnits } from './map/money.js';
export type { ParsedMoney } from './map/money.js';
export { DATA_TYPE_MAP, planCustomField, planValue } from './map/custom-fields.js';
export type { CustomFieldPlan, PlannedValue, ValueContext, ValuePlan } from './map/custom-fields.js';
export {
  AMOUNT_FIELD_SLUGS,
  DEFAULT_MISSING_CORRESPONDENT,
  DUE_DATE_FIELD_SLUGS,
  PERIOD_END_FIELD_SLUGS,
  PERIOD_START_FIELD_SLUGS,
  REFERENCE_NUMBER_FIELD_SLUGS,
  chooseFacetSources,
  mapOffice,
} from './map/office.js';
export type {
  FacetSourceDecision,
  FacetSourceNominations,
  FacetSources,
  MappedOffice,
  OfficeContext,
} from './map/office.js';

/* Rediscovering the correspondence, by query ------------------------------------------------------- */
export {
  documentSourceRef,
  findItemByPaperlessId,
  importedDocumentIds,
  importedItemIds,
  reconcileDocuments,
} from './reconcile.js';
export type { AttachmentCorrespondence } from './reconcile.js';

/* The verification report ---------------------------------------------------------------------------- */
export { REPORT_SCHEMA } from './report/types.js';
export type {
  AsnDeferral,
  AsnLoss,
  AsnReconciliation,
  CheckComparison,
  CorrespondentReconciliation,
  CustomFieldReconciliation,
  DocumentCounts,
  DocumentTypeParity,
  DocumentTypeReconciliation,
  NotCarriedField,
  NoteReconciliation,
  OriginalCoverage,
  OriginalReportEntry,
  OriginalStatus,
  PaperlessImportReport,
  ReportCheck,
  ReportRun,
  ReportSource,
  ReviewEntry,
  SkippedRecord,
  TagReconciliation,
  UnrepresentableValue,
} from './report/types.js';
export { buildReport, readImportLog } from './report/build.js';
export type { BuildReportInput, ImportLog } from './report/build.js';
export { renderReportMarkdown } from './report/markdown.js';
export { writeReport } from './report/write.js';
export type { ReportPaths } from './report/write.js';
