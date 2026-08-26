/**
 * `@recueil/ingest` — the ingestion pipeline of CONCEPT §5.3.
 *
 * Everything that puts a file into the library goes through here: the watched folder, the WebDAV
 * feed, the mailbox, the scanner, the connector, the API upload and the bulk importers all produce
 * `IngestCandidate`s, and the pipeline does the same ten stages to every one of them.
 *
 * ```ts
 * import { createRecueil } from '@recueil/core';
 * import { IngestPipeline, folderCandidates } from '@recueil/ingest';
 *
 * const recueil = createRecueil({ databaseUrl: 'library.sqlite', storagePath: 'store' });
 * const pipeline = new IngestPipeline({ recueil });
 *
 * const { candidates } = await folderCandidates('/srv/consume');
 * const report = await pipeline.run(candidates, { runLabel: 'nightly-2026-08-22' });
 *
 * if (!report.verification.pass) console.error(report.verification.checks);
 * ```
 *
 * The sidecars — OCRmyPDF and GROBID — are behind `OcrEngine` and `MetadataExtractor`. Neither is
 * exercised by this package's tests, and neither is required to run: see `README.md` for how to
 * enable them and for what is and is not proven about the two adapters.
 */

/* The pipeline ------------------------------------------------------------------------------- */
export { IngestPipeline } from './pipeline.js';
export type {
  CandidateOutcome,
  IngestPipelineOptions,
  IngestRunReport,
  IngestVerification,
  RuleEvaluator,
  RunCounts,
  RunOptions,
} from './pipeline.js';

export { DEFAULT_INGEST_CONFIG, resolveConfig } from './config.js';
export type { IngestConfig } from './config.js';

export {
  DETECTED_TYPES,
  PIPELINE_ANCHORS,
  IDENTIFIER_SCHEMES,
  emptyProposal,
  stageLabel,
} from './types.js';
export type {
  DetectedType,
  DocumentSourceKind,
  ExtractedReference,
  HealthReport,
  Identifier,
  IdentifierScheme,
  IngestCandidate,
  IngestOutcome,
  IngestRef,
  ItemProposal,
  JsonObject,
  JsonValue,
  PipelineAnchor,
  ProposalPatch,
  ProposedCreator,
  ProposedField,
  Provenance,
  Sha256,
  Timestamp,
} from './types.js';

export {
  AdapterUnavailableError,
  ArchiveFormatError,
  ArchiveLimitError,
  IngestCancelledError,
  IngestError,
  UnsafeArchivePathError,
} from './errors.js';

/* Sources ------------------------------------------------------------------------------------ */
export { bufferCandidate, fileCandidate, folderCandidates } from './sources/local.js';
export type {
  BufferCandidateOptions,
  FileCandidateOptions,
  FolderScan,
  FolderScanOptions,
} from './sources/local.js';

/* The review queue (P3) ----------------------------------------------------------------------- */
export { ReviewQueueService, reviewDedupeKey } from './db/review-queue.js';
export type { ListReviewOptions, RaiseReviewInput } from './db/review-queue.js';
export { ensureIngestSchema } from './db/install.js';
export {
  INGEST_REASON_CODES,
  REVIEW_ACTIONS,
  REVIEW_SEVERITIES,
  REVIEW_STATUSES,
  REVIEW_SUBJECT_TYPES,
  ingestCheckpoints,
  reviewQueue,
} from './db/schema.js';
export type {
  IngestCheckpointRow,
  ReviewAction,
  ReviewQueueRow,
  ReviewSeverity,
  ReviewStatus,
  ReviewSubjectType,
} from './db/schema.js';

/* The run record: idempotency and resumability (P9) --------------------------------------------- */
export {
  CandidateJournal,
  INGEST_JOB_TYPE,
  candidateKey,
  fileIdempotencyKey,
  findRun,
  runIdempotencyKey,
} from './db/journal.js';
export type { RunHandle } from './db/journal.js';

/* The `ingestStage` hook (spec/hooks.md §6.5) ----------------------------------------------------- */
export { IngestStageRegistry, compareStages, hookContext } from './hooks.js';
export type {
  HookContextSeed,
  IngestHookContext,
  IngestStage,
  IngestStageInput,
  IngestStageResult,
  StagePosition,
} from './hooks.js';

/* Events -------------------------------------------------------------------------------------- */
export { EventBus } from './events.js';
export type { IngestEvent, IngestEventSink, IngestEventType } from './events.js';

/* OCR (stage 5) --------------------------------------------------------------------------------- */
export { UnavailableOcrEngine } from './ocr/engine.js';
export type { OcrEngine, OcrRequest, OcrResult } from './ocr/engine.js';
export { OcrMyPdfEngine } from './ocr/ocrmypdf.js';
export type { OcrMyPdfOptions } from './ocr/ocrmypdf.js';
export { FakeOcrEngine } from './ocr/fake.js';
export type { FakeOcrOptions } from './ocr/fake.js';

/* Metadata extraction (stage 6) ------------------------------------------------------------------ */
export { noMetadata } from './metadata/extractor.js';
export type { ExtractedMetadata, MetadataExtractor, MetadataRequest } from './metadata/extractor.js';
export { GrobidExtractor, parseTeiHeader } from './metadata/grobid.js';
export type { GrobidOptions } from './metadata/grobid.js';
export {
  OfficeHeuristicExtractor,
  pickDocumentDate,
  readAmount,
  readDates,
  readDocumentType,
  readLetterhead,
  readReference,
  toMinorUnits,
} from './metadata/office.js';
export type { OfficeHeuristicOptions, ReadAmount, ReadDate } from './metadata/office.js';
export { FakeMetadataExtractor } from './metadata/fake.js';
export type { FakeMetadataOptions, FakeRecord } from './metadata/fake.js';

/* Identifier resolution (stage 7) ----------------------------------------------------------------- */
export {
  extractIdentifiers,
  normaliseDoi,
  normaliseIsbn,
  normaliseIssn,
} from './resolve/identifiers.js';
export { FixtureResolver, NullResolver } from './resolve/resolver.js';
export type { IdentifierResolver, ResolutionRecord, ResolutionRequest } from './resolve/resolver.js';

/* The rule engine (stage 8) ------------------------------------------------------------------------ */
export { RuleEngine } from './rules/engine.js';
export type { RuleConflict, RuleEvaluation, RuleSubject } from './rules/engine.js';
export { parseRules, parseRulesOrThrow } from './rules/parse.js';
export type { ParseRulesResult, RuleProblem } from './rules/parse.js';
export type { IngestRule, RuleActions, RuleMatch, RulePattern } from './rules/types.js';

/* The confidence gate (stage 9) --------------------------------------------------------------------- */
export { CONFIDENCE_WEIGHTS, ConfidenceLedger } from './confidence.js';
export type { ConfidenceEntry } from './confidence.js';

/* The commit (stage 10) ----------------------------------------------------------------------------- */
export { coerceFieldValue, commitProposal, facetValues } from './commit.js';
export type { CommitInput, CommitResult } from './commit.js';
export { recordDocumentFacts } from './document-facts.js';
export type { DocumentFacts } from './document-facts.js';

/* Archives (stage 3) -------------------------------------------------------------------------------- */
export { archiveKind, emailMetadata, extractArchive } from './archive/extract.js';
export type { ArchiveKind, ExtractedMember, ExtractionResult } from './archive/extract.js';
export {
  DEFAULT_MEMBER_OUTPUT_BYTES,
  crc32,
  looksLikeZip,
  readZipDirectory,
  readZipEntry,
} from './archive/zip.js';
export type { ZipEntry, ZipEntryLimits } from './archive/zip.js';
export { decodeWords, looksLikeEmail, parseEmail } from './archive/eml.js';
export type { EmailPart, ParsedEmail } from './archive/eml.js';
export { isInside, resolveMemberPath } from './archive/safe-path.js';
export type { SafeMemberPath } from './archive/safe-path.js';

/* Scratch ------------------------------------------------------------------------------------------- */
export { ScratchManager, ScratchSpace } from './scratch.js';

/* Type detection (stage 4) --------------------------------------------------------------------------- */
export { detectType } from './detect/type.js';
export type { DetectionInput, DetectionResult } from './detect/type.js';

/* Resource budgets on untrusted input (ADR-0022) -------------------------------------------------- */
export { BudgetLedger, DEFAULT_PDF_BUDGET, ResourceBudgetError } from './budgets.js';
export type { PdfBudget } from './budgets.js';

/* Text ---------------------------------------------------------------------------------------------- */
export { extractPdfText } from './text/pdf-text.js';
export type { PdfTextResult } from './text/pdf-text.js';
export { simhash, simhashDistance } from './text/simhash.js';
