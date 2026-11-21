/**
 * The plugin API types, generated from the TypeScript blocks of `spec/hooks.md` by
 * `scripts/generate-types.mjs`. The specification is the source: change it and regenerate, never
 * edit this file by hand. `pnpm test` fails when the two disagree.
 */
/* eslint-disable */
import type { HostApiTypes } from './host-apis.js';
type SettingsHandle = HostApiTypes['SettingsHandle'];
type Logger = HostApiTypes['Logger'];
type LibraryApi = HostApiTypes['LibraryApi'];
type GraphApi = HostApiTypes['GraphApi'];
type SearchApi = HostApiTypes['SearchApi'];
type SystematicReviewApi = HostApiTypes['SystematicReviewApi'];
type StorageApi = HostApiTypes['StorageApi'];
type JobsApi = HostApiTypes['JobsApi'];
type HttpApi = HostApiTypes['HttpApi'];
type EventsApi = HostApiTypes['EventsApi'];
type CacheApi = HostApiTypes['CacheApi'];
type ScratchApi = HostApiTypes['ScratchApi'];

/** RFC 3339 timestamp in UTC, e.g. "2026-08-22T09:14:00Z". */
export type Timestamp = string;
/** ULID, lexicographically sortable, used for every host-issued id. */
export type Ulid = string;
/** 64 lower-case hex characters. */
export type Sha256 = string;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };
/** A JSON Schema document, draft 2020-12. */
export type JsonSchema = JsonObject;

/** Provenance travels with every derived fact (P4). Nothing enters the library without one. */
export interface Provenance {
  /** Resolver source name, hook id or `manual`. */
  source: string;
  /** Upstream record id, where the source has one. */
  sourceRecordId?: string;
  fetchedAt: Timestamp;
  /** 0..1. A source that cannot estimate confidence reports its configured default, never 1. */
  confidence: number;
}

export interface Actor {
  type: 'user' | 'token' | 'system' | 'plugin' | 'job' | 'mcp';
  userId?: string;
  tokenId?: string;
  pluginName?: string;
  jobId?: string;
}

/** Every paged host call uses this shape. An absent cursor means the page is the last one. */
export interface Page<T> {
  records: T[];
  cursor?: string;
  /** Present only when the source can count without paying for it. */
  total?: number;
}

export type IdentifierScheme =
  | 'doi' | 'pmid' | 'pmcid' | 'arxiv' | 'isbn' | 'issn' | 'issn_l'
  | 'openalex' | 'semantic_scholar' | 'datacite' | 'orcid' | 'ror' | 'url' | 'zotero_key';

export interface Identifier {
  scheme: IdentifierScheme;
  /** Normalised: DOIs lower-cased and bare, ISBNs hyphen-free, arXiv ids without the `arXiv:` prefix. */
  value: string;
}

/** A work that is not (yet) an Item: a reference-list entry, a deep-dive hit, a search result. */
export interface WorkStub {
  identifiers: Identifier[];
  title?: string;
  containerTitle?: string;
  issuedYear?: number;
  authors?: { family?: string; given?: string; literal?: string; orcid?: string }[];
  raw?: JsonValue;
}

/** Reported next to every map and every enrichment run, because a map without it misleads (P4). */
export interface CoverageReport {
  /** Subjects the provider was asked about. */
  requested: number;
  /** Subjects for which it returned anything. */
  covered: number;
  /** Per upstream source: how many records came from where, and when they were fetched. */
  bySource: { source: string; records: number; fetchedAt: Timestamp }[];
  notes?: string[];
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'unavailable';
  message?: string;
  checkedAt: Timestamp;
  detail?: JsonObject;
}

export interface PluginContext {
  readonly plugin: { name: string; version: string; pluginApi: string };
  readonly settings: SettingsHandle;
  readonly log: Logger;

  /** Namespaces are present only when the matching permission is declared. */
  readonly library?: LibraryApi;       // items, documents, attachments, notes, collections, tags
  readonly graph?: GraphApi;           // nodes, edges, shadow works
  readonly search?: SearchApi;
  readonly sr?: SystematicReviewApi;
  readonly storage?: StorageApi;
  readonly jobs?: JobsApi;
  readonly http?: HttpApi;             // permission `network:outbound`
  readonly events?: EventsApi;

  readonly bytes: BytesApi;            // §4
  readonly cache: CacheApi;            // namespaced, TTL'd, cleared on version change
  readonly scratch: ScratchApi;        // per-invocation temporary space, always cleaned up
  readonly now: () => Timestamp;       // injectable so tests are deterministic
  /** Aborted when the plugin is deactivated. Long-running work must honour it. */
  readonly signal: AbortSignal;
}

/** Handed to every hook call. Adds what is true of this invocation and nothing else. */
export interface HookContext extends PluginContext {
  readonly invocationId: Ulid;
  readonly hookId: string;
  /** Aborted at the deadline as well as at deactivation. */
  readonly signal: AbortSignal;
  readonly deadline: Timestamp;
  /** 1 on the first attempt. Retries reuse the same idempotency key. */
  readonly attempt: number;
  readonly jobId?: string;
  readonly idempotencyKey?: string;
  /** Who asked. Recorded in the audit log against anything the call causes. */
  readonly actor: Actor;
  /** True when the host is producing a report rather than applying changes. Behaviour must be identical. */
  readonly dryRun: boolean;
}

export interface ReadHandle { readonly id: Ulid; readonly byteSize?: number; readonly sha256?: Sha256 }
export interface WriteHandle { readonly id: Ulid }

export interface BytesApi {
  read(handle: ReadHandle, offset: number, length: number): Promise<Uint8Array>;
  /** Sequential convenience over `read`. Default chunk 4 MiB. */
  chunks(handle: ReadHandle, chunkBytes?: number): Promise<{ next(): Promise<Uint8Array | null> }>;
  openWrite(hint?: { byteSize?: number; mediaType?: string }): Promise<WriteHandle>;
  write(handle: WriteHandle, chunk: Uint8Array): Promise<void>;
  /** Returns the SHA-256 the host computed while the bytes went past. */
  closeWrite(handle: WriteHandle): Promise<{ sha256: Sha256; byteSize: number }>;
  abortWrite(handle: WriteHandle): Promise<void>;
  release(handle: ReadHandle): Promise<void>;
}

export interface Resolver {
  readonly id: string;
  /** Source name written into `Provenance.source` and `field_provenance.source`. */
  readonly source: string;

  readonly supports: {
    lookup: readonly IdentifierScheme[];
    search: boolean;
    references: boolean;
    citations: boolean;
    /** Metric names this source can observe, e.g. `cited_by_count`, `fwci`. */
    metrics: readonly string[];
  };

  /** Advisory ceiling. The host's adaptive limiter starts here and backs off; it never exceeds it. */
  readonly rateLimit?: { requestsPerSecond: number; burst?: number; concurrency?: number };

  lookup(req: ResolverLookupRequest, ctx: HookContext): Promise<ResolverRecord[]>;
  search?(req: ResolverSearchRequest, ctx: HookContext): Promise<ResolverRecord[]>;
  references?(req: ResolverEdgeRequest, ctx: HookContext): Promise<Page<WorkStub>>;
  citations?(req: ResolverEdgeRequest, ctx: HookContext): Promise<Page<WorkStub>>;
  metrics?(req: ResolverMetricRequest, ctx: HookContext): Promise<MetricObservation[]>;
  health?(ctx: HookContext): Promise<HealthReport>;
}

export interface ResolverLookupRequest {
  /** One or more identifiers for the same work. Resolving any of them is a success. */
  identifiers: Identifier[];
  /** Field paths the caller wants. A resolver may return more; it must not return less than it has. */
  fields?: string[];
}

export interface ResolverSearchRequest {
  query: {
    title?: string;
    authors?: string[];
    containerTitle?: string;
    issuedYear?: number;
    /** Free text, when the caller has nothing structured. */
    text?: string;
  };
  limit: number;
}

export interface ResolverEdgeRequest {
  identifier: Identifier;
  cursor?: string;
  limit: number;
}

export interface ResolverMetricRequest {
  identifiers: Identifier[];
  metrics: string[];
}

export interface ResolverRecord {
  /** Which of the requested identifiers this record answers, plus any the source added. */
  matched: Identifier[];
  itemType?: string;
  /**
   * Dotted field paths into the bibliographic or office facet, each with its own provenance.
   * A resolver never returns a bare value: the merge policy needs to know where it came from.
   */
  fields: Record<string, { value: JsonValue; provenance: Provenance }>;
  creators?: {
    role: string;
    family?: string;
    given?: string;
    literal?: string;
    orcid?: string;
    sequence: number;
    provenance: Provenance;
  }[];
  terms?: { scheme: string; code?: string; label: string; provenance: Provenance }[];
  /** 0..1, the resolver's own belief that this record is the requested work. */
  score: number;
  /** Upstream payload, kept for the provenance trail. Trimmed by the host above 256 KiB. */
  raw?: JsonValue;
}

export interface MetricObservation {
  identifier: Identifier;
  metric: string;
  value: number;
  observedAt: Timestamp;
  provenance: Provenance;
}

export type CheckSubjectType = 'item' | 'document' | 'attachment' | 'creator' | 'reference' | 'library';

export type CheckSubject =
  | { type: 'item'; itemId: string; snapshot: JsonObject }
  | { type: 'document'; documentId: string; sha256: Sha256; snapshot: JsonObject }
  | { type: 'attachment'; attachmentId: string; itemId: string; snapshot: JsonObject }
  | { type: 'creator'; creatorId: string; snapshot: JsonObject }
  /** Bibliography audit mode: parsed but not in the library, so there is no id. */
  | { type: 'reference'; localRef: string; stub: WorkStub; rawString?: string }
  /** Library-wide checks such as citation-key collision. */
  | { type: 'library'; scope: { collectionId?: string; savedSearchId?: string } };

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly severity: 'info' | 'warning' | 'error';
  /** One paragraph in plain British English, shown verbatim in the report next to every failure. */
  readonly explanation: string;
  readonly subjectTypes: readonly CheckSubjectType[];
  readonly autoFixable: boolean;
  /** Declared so the host can skip the check when offline or when the text layer is missing. */
  readonly requires?: {
    network?: boolean;
    fullText?: boolean;
    resolvers?: readonly string[];
  };

  run(subject: CheckSubject, ctx: HookContext): Promise<CheckResult[]>;
  autoFix?(result: CheckResult, ctx: HookContext): Promise<FixProposal>;
}

export interface CheckResult {
  checkId: string;
  subjectType: CheckSubjectType;
  /** Item, document or attachment id; `localRef` in audit mode. */
  subjectId: string;
  itemId?: string;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  severity: 'info' | 'warning' | 'error';
  /** One sentence naming the specific problem, not the check. "DOI 10.x/y returns 404", not "DOI check failed". */
  message: string;
  detail?: JsonObject;
  autoFixable: boolean;
  /** What the verdict rests on. A check that consulted an upstream source must say which and when. */
  evidence?: Provenance[];
}

export interface FixProposal {
  explanation: string;
  changes: {
    entityType: 'item_bibliographic' | 'item_office' | 'creators' | 'attachments' | 'terms';
    entityId: string;
    fieldPath: string;
    before: JsonValue;
    after: JsonValue;
    provenance: Provenance;
  }[];
  /** True when the fix should go to the review queue rather than be applied (P3). */
  requiresReview: boolean;
  confidence: number;
}

export type DedupSubject =
  | { layer: 'file'; documentId: string; sha256: Sha256; byteSize: number; mediaType: string;
      simhash?: string; textHandle?: ReadHandle; annotationCount: number }
  | { layer: 'record'; itemId: string; itemType: string; snapshot: JsonObject;
      identifiers: Identifier[]; normalisedTitle: string; issuedYear?: number };

export interface DedupRule {
  readonly id: string;
  readonly layer: 'file' | 'record';
  readonly title: string;

  /**
   * Cheap, deterministic candidate keys. Two subjects are compared only if they share a key,
   * so this is what makes dedup tractable on a large library. Called once per subject per run.
   */
  blockingKeys(subject: DedupSubject, ctx: HookContext): Promise<string[]>;

  /** Called only on pairs sharing a blocking key. Must be symmetric. */
  compare(a: DedupSubject, b: DedupSubject, ctx: HookContext): Promise<DedupVerdict>;

  /** Optional opinion on which side should survive a merge. The configured winner rule still decides. */
  mergePreference?(a: DedupSubject, b: DedupSubject, ctx: HookContext): Promise<'a' | 'b' | 'undecided'>;
}

export interface DedupVerdict {
  ruleId: string;
  /** 0..1. Compared against the engine's auto-merge and review thresholds. */
  score: number;
  action: 'duplicate' | 'related' | 'distinct' | 'undecided';
  /** Shown in the dry-run report and in the review queue. Must name the evidence, not the rule. */
  reason: string;
  evidence?: JsonObject;
}

export interface IngestRef {
  sourceId: string;
  /** Stable within the source. Mailbox UID, WebDAV path plus etag, absolute file path. */
  externalId: string;
  /** Bump when the same externalId has new content, e.g. a rewritten file. */
  revision?: string;
}

export interface IngestCandidate {
  ref: IngestRef;
  suggestedFilename?: string;
  mediaType?: string;
  byteSize?: number;
  observedAt: Timestamp;
  /** Sender, subject, folder path, scanner id — whatever the rule engine may match on at stage 8. */
  sourceMetadata?: JsonObject;
}

export type IngestOutcome =
  | { status: 'ingested'; documentId: string; itemId?: string }
  | { status: 'duplicate'; documentId: string }
  | { status: 'review'; reviewQueueEntryId: string }
  | { status: 'failed'; code: string; message: string };

export interface IngestSource {
  readonly id: string;
  /** `poll` is scheduled; `watch` pushes via ctx.events; `push` receives an inbound webhook. */
  readonly kind: 'poll' | 'watch' | 'push';

  start(ctx: PluginContext): Promise<void>;
  poll?(req: { cursor?: string; limit: number }, ctx: HookContext): Promise<Page<IngestCandidate>>;
  fetch(ref: IngestRef, ctx: HookContext): Promise<{ handle: ReadHandle; mediaType?: string }>;
  /** Called exactly once per candidate once the pipeline is done with it, and possibly again after a crash. */
  acknowledge(ref: IngestRef, outcome: IngestOutcome, ctx: HookContext): Promise<void>;
  stop(ctx: PluginContext): Promise<void>;
  health?(ctx: HookContext): Promise<HealthReport>;
}

export type PipelineAnchor =
  | 'hash' | 'duplicate_check' | 'archive_extraction' | 'type_detection' | 'ocr'
  | 'metadata_extraction' | 'resolution' | 'rules' | 'confidence_gate' | 'commit';

export interface IngestStageInput {
  readonly documentId: string;
  readonly sha256: Sha256;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly bytes: ReadHandle;
  /** Extracted text, once a stage has produced it. Inline below 256 KiB, otherwise a handle. */
  readonly text?: string | ReadHandle;
  /** The item the pipeline intends to create or update. Read-only; patch it via the result. */
  readonly proposal: {
    itemType?: string;
    fields: Record<string, { value: JsonValue; provenance: Provenance }>;
    creators: JsonObject[];
    collectionIds: string[];
    tags: string[];
    customFields: Record<string, JsonValue>;
    confidence: number;
  };
  readonly source: { kind: string; ref: IngestRef; metadata?: JsonObject };
  readonly previousStages: readonly string[];
}

export type IngestStageResult =
  | {
      action: 'continue';
      patch?: {
        itemType?: string;
        fields?: Record<string, { value: JsonValue; provenance: Provenance }>;
        creators?: JsonObject[];
        addCollectionIds?: string[];
        addTags?: string[];
        customFields?: Record<string, JsonValue>;
      };
      /** Added to the running confidence used by the stage-9 gate. Range -1..1. */
      confidenceDelta?: number;
      /** Written to the job log, visible in the ingestion detail view. */
      notes?: string[];
    }
  | { action: 'review'; reasonCode: string; explanation: string; proposedAction?: string }
  | { action: 'stop'; reasonCode: string; explanation: string };

export interface IngestStage {
  readonly id: string;
  readonly anchor: PipelineAnchor;
  readonly position: 'before' | 'after';
  run(input: IngestStageInput, ctx: HookContext): Promise<IngestStageResult>;
}

export interface ObjectHead {
  key: string;
  byteSize: number;
  /** The backend's own checksum, when it has one. Never trusted in place of a Recueil verify. */
  etag?: string;
  lastModified?: Timestamp;
  mediaType?: string;
}

export interface StorageBackend {
  readonly id: string;
  readonly scheme: string;
  readonly capabilities: {
    ranges: boolean;
    presignedUrls: boolean;
    serverSideCopy: boolean;
    /** A backend that cannot list cannot be verified or backed up by `recueil backup`. */
    listing: boolean;
  };

  head(key: string, ctx: HookContext): Promise<ObjectHead | null>;
  openRead(key: string, range: { offset: number; length?: number } | undefined, ctx: HookContext): Promise<ReadHandle>;
  openWrite(key: string, hint: { byteSize?: number; mediaType?: string }, ctx: HookContext): Promise<WriteHandle>;
  commitWrite(handle: WriteHandle, ctx: HookContext): Promise<ObjectHead>;
  abortWrite(handle: WriteHandle, ctx: HookContext): Promise<void>;
  /** Only ever called by trash expiry or an explicit operator action. Never by the pipeline (P5). */
  remove(key: string, ctx: HookContext): Promise<void>;
  list(prefix: string, cursor: string | undefined, ctx: HookContext): Promise<Page<ObjectHead>>;
  verify(key: string, expectedSha256: Sha256, ctx: HookContext): Promise<{ ok: boolean; actualSha256?: Sha256; message?: string }>;
  presign?(key: string, opts: { method: 'GET' | 'PUT'; expiresInSeconds: number }, ctx: HookContext): Promise<{ url: string; headers?: Record<string, string> }>;
  health?(ctx: HookContext): Promise<HealthReport>;
}

export type ExportTarget = 'items' | 'collection' | 'saved_search' | 'review' | 'graph' | 'curated_network' | 'annotations';

export interface ExportRequest {
  target: ExportTarget;
  selection: {
    itemIds?: string[];
    collectionId?: string;
    savedSearchId?: string;
    reviewId?: string;
    networkId?: string;
    query?: JsonObject;
  };
  /** Validated by the host against `optionsSchema` before the call. */
  options: JsonObject;
  cursor?: string;
}

export interface ExportSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Sets the Content-Disposition filename. Call before the first write. */
  setFilename(name: string): void;
}

export interface ExportSummary {
  recordCount: number;
  byteCount: number;
  /** Every lossy mapping goes here. An export that silently drops data violates P10. */
  warnings: string[];
  cursor?: string;
  coverage?: CoverageReport;
}

export interface Exporter {
  readonly id: string;
  readonly label: string;
  readonly mediaType: string;
  readonly fileExtension: string;
  readonly targets: readonly ExportTarget[];
  readonly optionsSchema?: JsonSchema;
  /** True when the exporter can resume from a cursor, which lets the host stream very large selections. */
  readonly resumable: boolean;

  export(req: ExportRequest, sink: ExportSink, ctx: HookContext): Promise<ExportSummary>;
}

export interface DetectSample {
  /** First 64 KiB. Do not ask for more; open the whole document in `parse`. */
  head: Uint8Array;
  filename?: string;
  mediaType?: string;
  byteSize: number;
}

export interface DetectVerdict {
  /** 0..1. Highest wins; ties are broken by manifest priority, then plugin name. */
  confidence: number;
  /** Format variant this importer would use, echoed back in the parse request. */
  format?: string;
  reason: string;
}

export interface ImportRequest {
  documentId: string;
  bytes: ReadHandle;
  format?: string;
  /** Field mapping and per-importer options, validated against `optionsSchema`. */
  options: JsonObject;
  cursor?: string;
  batchSize: number;
}

export interface ImportRecord {
  /** Stable id in the source system. Written to `items.source_id` and makes re-import idempotent (P9). */
  externalId?: string;
  itemType: string;
  fields: Record<string, { value: JsonValue; provenance: Provenance }>;
  creators?: JsonObject[];
  terms?: { scheme: string; code?: string; label: string }[];
  collectionPaths?: string[][];
  tags?: string[];
  notes?: { markdown: string }[];
  annotations?: JsonObject[];
  attachments?: {
    /** One of: a hash already in the library, a path inside the imported bundle, or a URL to fetch. */
    ref: { sha256: Sha256 } | { pathInBundle: string } | { url: string };
    role: 'primary' | 'supplement' | 'snapshot' | 'scan';
    filename?: string;
  }[];
  raw?: JsonValue;
  /** Anything the importer could not map. Aggregated into the verification report. */
  warnings?: string[];
}

export interface ImportBatch {
  sourceSystem: string;
  records: ImportRecord[];
  cursor?: string;
  total?: number;
  /** Counted even when no record is produced, so the verification report can reconcile. */
  skipped?: { count: number; reasons: Record<string, number> };
}

export interface Importer {
  readonly id: string;
  readonly label: string;
  readonly accepts: { mediaTypes: readonly string[]; fileExtensions: readonly string[] };
  readonly optionsSchema?: JsonSchema;

  detect(sample: DetectSample, ctx: HookContext): Promise<DetectVerdict>;
  parse(req: ImportRequest, ctx: HookContext): Promise<ImportBatch>;
}

export type GraphNodeType = 'item' | 'shadow_work' | 'creator' | 'venue' | 'term' | 'institution';
export type GraphEdgeType = 'cites' | 'co_cited' | 'coupled' | 'co_occurs' | 'co_author' | 'same_as' | 'version_of';

export type NodeRef =
  | { kind: 'node'; nodeId: string }
  | { kind: 'item'; itemId: string }
  | { kind: 'shadow_work'; shadowWorkId: string }
  | { kind: 'external'; scheme: string; id: string }
  | { kind: 'stub'; stub: WorkStub };

export interface EdgeProposal {
  edgeType: GraphEdgeType;
  source: NodeRef;
  target: NodeRef;
  directed: boolean;
  weight?: number;
  /** Mandatory. A batch containing an edge without provenance is rejected whole (P4). */
  provenance: Provenance;
  evidence?: {
    kind: 'citation_context' | 'reference_string' | 'api_record';
    documentId?: string;
    pageIndex?: number;
    textExcerpt?: string;
    intent?: 'background' | 'method' | 'result';
    intentConfidence?: number;
    model?: string;
  }[];
}

export interface EdgeRequest {
  seeds: NodeRef[];
  edgeTypes: readonly GraphEdgeType[];
  direction: 'forward' | 'backward' | 'both';
  /** Hard caps. Exceeding any of them invalidates the batch. */
  budget: { maxNodes: number; maxEdges: number; maxUpstreamRequests: number; depth: number };
  cursor?: string;
}

export interface EdgeBatch {
  edges: EdgeProposal[];
  /** Targets not yet in the library become ShadowWorks, never Items (CONCEPT.md §5.8). */
  shadowWorks: WorkStub[];
  cursor?: string;
  budgetSpent: { nodes: number; edges: number; upstreamRequests: number; depthReached: number };
  /** Mandatory. Every map in the UI displays this next to itself. */
  coverage: CoverageReport;
}

export interface GraphEdgeProvider {
  readonly id: string;
  readonly edgeTypes: readonly GraphEdgeType[];
  readonly nodeTypes: readonly GraphNodeType[];
  readonly direction: 'forward' | 'backward' | 'both';

  provide(req: EdgeRequest, ctx: HookContext): Promise<EdgeBatch>;
  coverage?(req: EdgeRequest, ctx: HookContext): Promise<CoverageReport>;
}

export interface AnalyticsColumn {
  name: string;
  type: 'string' | 'int32' | 'int64' | 'float64' | 'bool' | 'date' | 'timestamp' | 'json' | 'list<string>';
  nullable: boolean;
  /** Becomes the column comment in the Parquet schema and the row in the data dictionary. */
  description: string;
}

export interface AnalyticsTableSpec {
  /** Must be prefixed with the plugin's short name, e.g. `scicite_intents`. Core names are reserved. */
  name: string;
  description: string;
  columns: AnalyticsColumn[];
  primaryKey?: string[];
  partitionBy?: string[];
}

export interface AnalyticsRequest {
  table: string;
  /** Opaque snapshot id. Every batch of every table in one bundle shares it. */
  snapshotId: string;
  filter?: { collectionId?: string; savedSearchId?: string; reviewId?: string; since?: Timestamp };
  cursor?: string;
  batchRows: number;
}

export interface AnalyticsBatch {
  table: string;
  /** Exactly the spec's column names, in the spec's order. */
  columns: string[];
  rows: JsonValue[][];
  cursor?: string;
  rowCount: number;
}

export interface AnalyticsExport {
  readonly id: string;
  readonly tables: readonly AnalyticsTableSpec[];
  produce(req: AnalyticsRequest, ctx: HookContext): Promise<AnalyticsBatch>;
}

export interface InstrumentDefinition {
  id: string;
  version: string;
  title: string;
  /** The published instrument this implements, as a citation string. Frozen with the assessment. */
  citation?: string;
  /** The form or questionnaire itself. Rendered by the host; the plugin does not draw it. */
  schema: JsonSchema;
  /** Arms, outcomes, timepoints — the parts of an extraction form that repeat. */
  repeatableGroups?: { id: string; title: string; schema: JsonSchema; minItems?: number; maxItems?: number }[];
  /** For risk-of-bias instruments: the domains judgements are reported against. */
  domains?: { id: string; title: string; signallingQuestions: string[] }[];
  /** `deterministic` means `derive` implements the published algorithm; `none` means judgement is manual. */
  algorithm: 'none' | 'deterministic';
}

export interface DerivedJudgement {
  domainJudgements: Record<string, string>;
  overallJudgement?: string;
  /** Which rule produced which judgement. Recorded so a reader can check the tool's reasoning. */
  basis: { domainId: string; rule: string; answers: string[] }[];
  /** Present only when the algorithm is genuinely probabilistic. Deterministic instruments omit it. */
  confidence?: number;
}

export interface SrTemplate {
  readonly id: string;
  readonly kind: 'extraction_form' | 'rob_instrument' | 'search_strategy' | 'report';
  readonly title: string;
  readonly templateIds: readonly string[];

  instrument(req: { templateId: string; locale?: string }, ctx: HookContext): Promise<InstrumentDefinition>;
  derive?(req: { templateId: string; answers: JsonObject }, ctx: HookContext): Promise<DerivedJudgement>;
  migrate?(
    req: { from: InstrumentDefinition; to: InstrumentDefinition; values: JsonObject },
    ctx: HookContext,
  ): Promise<{ values: JsonObject; unmapped: string[]; requiresReview: boolean }>;
}

export interface EventEnvelope<T = JsonObject> {
  /** ULID. The idempotency key for handlers: the same envelope may arrive twice. */
  id: Ulid;
  type: LifecycleEventType;
  occurredAt: Timestamp;
  /** Monotonic within an install, persisted, continues across restarts. Use it to order, not `occurredAt`. */
  sequence: number;
  actor: Actor;
  /** Correlates every event caused by one API request. */
  requestId?: string;
  /** The envelope id of the event whose handler caused this one, when there is one. */
  causationId?: Ulid;
  payload: T;
}

export type LifecycleEventType =
  | 'item.created' | 'item.updated' | 'item.merged' | 'item.trashed' | 'item.restored'
  | 'document.ingested' | 'attachment.added' | 'annotation.created'
  | 'check.completed'
  | 'job.started' | 'job.finished' | 'job.failed';

export type EventHandler<T = JsonObject> = (envelope: EventEnvelope<T>, ctx: HookContext) => Promise<void>;

export interface ItemCreatedPayload {
  itemId: string;
  publicId: string;          // 8-char Zotero-compatible key
  itemType: string;
  title?: string;
  collectionIds: string[];
  tags: string[];
  identifiers: Identifier[];
  citationKey?: string;
  createdVia: 'ui' | 'api' | 'mcp' | 'cli' | 'connector' | 'ingest' | 'import' | 'plugin' | 'promotion';
  sourceSystem?: string;     // e.g. `zotero`, `paperless`, `bibtex`
  sourceId?: string;
  promotedFromShadowWorkId?: string;
  dateAdded: Timestamp;
}

export interface ItemUpdatedPayload {
  itemId: string;
  publicId: string;
  itemType: string;
  version: number;           // post-update
  changedFields: string[];   // dotted paths
  before: JsonObject;        // changed fields only
  after: JsonObject;         // changed fields only
  /** Fields the user has locked against overwriting; a plugin must not propose changes to these. */
  lockedFields: string[];
  provenance: Provenance[];  // one per changed field, when the change was derived
}

export interface ItemMergedPayload {
  winnerItemId: string;
  loserItemIds: string[];
  mergeRecordId: string;
  strategy: 'newest' | 'most_complete' | 'manual' | 'rule';
  ruleIds: string[];         // dedup rules that voted for the merge
  score?: number;
  movedAttachmentIds: string[];
  movedNoteIds: string[];
  unionedCollectionIds: string[];
  unionedTags: string[];
  reversible: true;
}

export interface ItemTrashedPayload {
  itemId: string;
  publicId: string;
  trashedAt: Timestamp;
  reason?: string;
  /** What went to the trash with it. Nothing is deleted (P5); expiry is a separate, later event on documents. */
  cascade: { attachmentIds: string[]; noteIds: string[]; annotationIds: string[] };
}

export interface ItemRestoredPayload {
  itemId: string;
  publicId: string;
  restoredAt: Timestamp;
  restoredFrom: 'trash' | 'merge';
  /** Present when the restore was an un-merge. */
  mergeRecordId?: string;
  cascade: { attachmentIds: string[]; noteIds: string[]; annotationIds: string[] };
}

export interface DocumentIngestedPayload {
  documentId: string;
  sha256: Sha256;
  mediaType: string;
  byteSize: number;
  storageBackend: string;
  storageKey: string;
  hasTextLayer: boolean;
  ocrApplied: boolean;
  source: { kind: string; ref?: IngestRef; path?: string; metadata?: JsonObject };
  /** Set when stage 2 matched an existing Document; no new bytes were written. */
  duplicateOfDocumentId?: string;
  itemIds: string[];         // items this document was attached to, may be empty
  pipelineRunId: string;
  stagesRun: string[];
  confidence: number;
  /** Set when the confidence gate at stage 9 routed it for review instead of auto-accepting (P3). */
  reviewQueueEntryId?: string;
}

export interface AttachmentAddedPayload {
  attachmentId: string;
  itemId: string;
  documentId?: string;       // absent for linked_url
  role: 'primary' | 'supplement' | 'snapshot' | 'scan';
  linkMode: 'stored' | 'linked_file' | 'linked_url';
  url?: string;
  filename?: string;
  position: number;
  addedVia: 'ui' | 'api' | 'mcp' | 'connector' | 'ingest' | 'import' | 'plugin';
}

export interface AnnotationCreatedPayload {
  annotationId: string;
  publicId: string;
  documentId: string;
  itemId?: string;
  annotationType: 'highlight' | 'note' | 'area' | 'ink';
  motivation: string;        // W3C motivation (ADR-0009, ADR-0017)
  pageIndex?: number;
  colour?: string;
  authorUserId?: string;
  /** True when extracted from embedded PDF annotations rather than made in the reader. */
  isExternal: boolean;
  hasQuotedText: boolean;
  hasBodyText: boolean;
  /** The selector set is not in the payload; fetch it if you need it. */
  selectorTypes: string[];
}

export interface CheckCompletedPayload {
  runId: string;
  /** Absent for a run of the whole check set. */
  checkIds?: string[];
  mode: 'on_import' | 'on_demand' | 'scheduled' | 'audit';
  scope: { itemIds?: string[]; collectionId?: string; savedSearchId?: string; auditDocumentId?: string };
  subjectCount: number;
  counts: { pass: number; fail: number; warn: number; skipped: number };
  worstSeverity: 'info' | 'warning' | 'error' | 'none';
  autoFixesApplied: number;
  reviewQueueEntriesRaised: number;
  durationMs: number;
  /** Set when the run produced a stored report document (CSV or Markdown). */
  reportDocumentId?: string;
}

export interface JobStartedPayload {
  jobId: string;
  jobType: string;
  idempotencyKey?: string;
  params: JsonObject;        // redacted
  attempt: number;
  priority: number;
  parentJobId?: string;
  pluginName?: string;       // set when a plugin scheduled it
  startedAt: Timestamp;
}

export interface JobFinishedPayload {
  jobId: string;
  jobType: string;
  state: 'succeeded' | 'cancelled';
  attempt: number;
  durationMs: number;
  /** Job-type-specific summary: records processed, edges written, bytes exported. Redacted. */
  result: JsonObject;
  parentJobId?: string;
  pluginName?: string;
  finishedAt: Timestamp;
}

export interface JobFailedPayload {
  jobId: string;
  jobType: string;
  /** `failed` means it will be retried; `dead` means it will not. */
  state: 'failed' | 'dead';
  attempt: number;
  willRetry: boolean;
  nextRunAfter?: Timestamp;
  error: { code: string; message: string; retryable: boolean; userMessage?: string };
  parentJobId?: string;
  pluginName?: string;
  failedAt: Timestamp;
}
