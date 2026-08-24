/**
 * The ingestion half of the REST contract, as the client sees it.
 *
 * Every type here mirrors one in `apps/server/src/schemas-ingestion.ts`, field for field, and is
 * declared rather than imported for the reason the Phase 1 client restates `API_BASE_PATH`: the
 * server's schema module is Zod, and pulling it into a browser bundle that never validates anything
 * would ship a validator to run nothing. `test/ingestion-contract.test.ts` is what keeps the two
 * from drifting — it drives every method and asserts the exact request.
 *
 * The names are the server's. Where this client once guessed at a shape it now follows the served
 * one, including the parts that are less convenient than a guess would have been:
 *
 *   - a review entry carries `subjectType` and `subjectId` and **no expanded subject**, so the
 *     workspace fetches the document itself;
 *   - accepting takes `edits` — a patch over the proposal — rather than a replacement payload;
 *   - there is **no reopen**: `ReviewService.accept` refuses anything that is not `open`, so a
 *     resolved entry stays resolved. That single fact is why undo in the review workspace is a
 *     grace period before the request is sent rather than a request that takes one back;
 *   - rules are rows, not a document. `spec/data-model.md` O2 recommended a table and the server
 *     built one, so the editor edits rows and renders YAML as a view over them.
 *
 * One property is deliberate and worth stating, because it is the client-side half of a finding
 * from the Phase 1 review: **nothing here reports a number the client itself counted.** Every count
 * the sources screen and the queue show is one the server derived by querying the library, the job
 * rows or the source state table.
 */
import type { Document, Item } from '@recueil/schemas';
import type { DOCUMENT_SOURCE_KINDS } from '@recueil/schemas';
import type {
  ActionTrace,
  ConditionTrace,
  EvaluationTrace,
  IngestionAction,
  IngestionCondition,
  RuleKind,
  RuleLimits,
  RuleMode,
  RuleStatistics,
  RuleTrace,
} from '@recueil/rules';

/** `documents.source_kind`, derived from the vocabulary constant the schemas package exports. */
export type DocumentSourceKind = (typeof DOCUMENT_SOURCE_KINDS)[number];

/* -------------------------------------------------------------------------------------------- */
/* Sources — /api/v1/ingestion/sources                                                            */
/* -------------------------------------------------------------------------------------------- */

/** The three places CONCEPT.md §5.3 names that are places rather than protocols. */
export type IngestionSourceKind = 'folder' | 'webdav' | 'imap';

/**
 * What happens to the original once the pipeline has committed it.
 *
 * `move` and `delete` destroy or relocate the only copy on the far side, and
 * `@recueil/ingest-sources` refuses either until the bytes have been re-read out of the content
 * store and re-hashed. The form says so, because an operator choosing `delete` should know what it
 * rests on.
 */
export interface ConsumePolicy {
  mode: 'leave' | 'move' | 'delete';
  /** Required by `move`. Relative to the source root, and never allowed to escape it. */
  to?: string;
}

export interface FolderSourceConfig {
  kind: 'folder';
  root: string;
  recursive?: boolean;
  skipHidden?: boolean;
  exclude?: string[];
  /** How long a file must be unchanged before it is offered. Guards against half-written scans. */
  minimumAgeMillis?: number;
  watch?: boolean;
}

export interface WebDavSourceConfig {
  kind: 'webdav';
  url: string;
  username?: string;
  authKind?: 'basic' | 'bearer' | 'none';
  recursive?: boolean;
  maxDepth?: number;
  timeoutMillis?: number;
}

export interface ImapSourceConfig {
  kind: 'imap';
  host: string;
  port?: number;
  secure?: boolean;
  username: string;
  mailbox?: string;
  /** The `UID SEARCH` criteria. `UNSEEN` by default. */
  search?: string;
  markSeen?: boolean;
  batchSize?: number;
  timeoutMillis?: number;
}

export type IngestionSourceConfig = FolderSourceConfig | WebDavSourceConfig | ImapSourceConfig;

/** Write-only. Stored encrypted; never returned. */
export interface IngestionSecret {
  password?: string;
  token?: string;
}

export interface IngestionSource {
  id: string;
  name: string;
  kind: IngestionSourceKind;
  enabled: boolean;
  /** The `documents.source_kind` recorded for everything this source produces. */
  sourceKind: string;
  config: IngestionSourceConfig;
  consume: ConsumePolicy;
  /** Which credentials are held, by name. The values are never returned. */
  secretNames: string[];
  lastRunJobId: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface IngestionSourceCreate {
  name: string;
  config: IngestionSourceConfig;
  enabled?: boolean;
  sourceKind?: string;
  consume?: ConsumePolicy;
  secret?: IngestionSecret;
}

export type IngestionSourceUpdate = Partial<IngestionSourceCreate>;

/** One thing the connection test actually tried. */
export interface ConnectionCheck {
  /** `resolve`, `directory`, `options`, `list`, `login`, `select`. */
  check: string;
  ok: boolean;
  detail: string;
}

/**
 * What the test came back with.
 *
 * `ok` is the conjunction of the rows rather than a separate opinion, so a green result names the
 * evidence behind it. The screen renders the rows for that reason.
 */
export interface TestConnectionResult {
  sourceId: string;
  kind: IngestionSourceKind;
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  checks: ConnectionCheck[];
  detail: string;
}

export interface SourceRunRequest {
  /** The same label resumes an unfinished run; a new one re-scans from the beginning (P9). */
  runLabel?: string;
  limit?: number;
}

export interface SourceRunAccepted {
  sourceId: string;
  jobId: string;
  runLabel: string;
  startedAt: string;
}

/* -------------------------------------------------------------------------------------------- */
/* The work queue — /api/v1/ingestion/queue                                                        */
/* -------------------------------------------------------------------------------------------- */

export type JobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** Not a failure: IK6 — the run raised review entries and will not proceed until they are resolved. */
  | 'waiting_review'
  | 'dead';

export interface IngestionJob {
  id: string;
  jobType: string;
  state: JobState;
  idempotencyKey: string | null;
  params: Record<string, unknown>;
  priority: number;
  attempts: number;
  maxAttempts: number;
  progress: { done: number; total: number | null };
  runAfter: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobLogEntry {
  id: string;
  loggedAt: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data: Record<string, unknown> | null;
  subjectType: string | null;
  subjectId: string | null;
}

/**
 * One stage of one candidate, as the run recorded it.
 *
 * This is the resume point as well as the record: `stages` comes from `ingest_checkpoints`, which is
 * what a resumed run reads, so the trace and the resume point cannot disagree. It is also the
 * closest thing the system stores to "why did this entry appear" — the `rules` row carries the
 * matched rule ids and the conflicts the engine found.
 */
export interface StageTraceEntry {
  candidateKey: string;
  /** One of the ten anchors of CONCEPT.md §5.3, or `commit`/`failed` for a terminal row. */
  stage: string;
  sha256: string | null;
  payload: unknown;
  createdAt: string;
}

export interface IngestionJobDetail {
  job: IngestionJob;
  stages: StageTraceEntry[];
  log: JobLogEntry[];
  /** Open review entries this run raised. Queried, not counted from the run's own tally. */
  reviewEntryIds: string[];
}

/**
 * The pipeline job a source run spawned, or `null` if it spawned none.
 *
 * A source run is two jobs, not one, and this is the join between them. `POST
 * /ingestion/sources/{id}/run` starts an `ingest.source` job — that is the id it returns and the id
 * the source stores as `lastRunJobId` — and that job then starts one `ingest.run` job to put the
 * candidates it offered through the pipeline. **Review entries are stamped with the `ingest.run`
 * id, never the `ingest.source` id**, so filtering the review queue by `lastRunJobId` matches
 * nothing at all: not "no backlog", but a query against the wrong key, which answers zero however
 * large the backlog is.
 *
 * The run's `result` is an untyped bag on the wire (`z.record(z.string(), z.unknown())`), so the id
 * is read defensively rather than asserted. `null` is a real answer with two causes worth keeping
 * apart from an error: the run offered nothing, so no pipeline job exists; or it has not got that
 * far yet.
 *
 * Note what this does and does not take from the run. It takes the *key* — a foreign key the
 * review queue is then asked about — and never the *answer*. The same object carries
 * `result.counts.review` and `reviewEntryIds`, either of which would be a backlog figure computed
 * from the importer's own tally of what it thinks it did; such a figure cannot disagree with the
 * importer and so can never reveal that the importer is wrong.
 */
export const pipelineJobIdOf = (detail: IngestionJobDetail | undefined): string | null => {
  const value = detail?.job.result?.['pipelineJobId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/* -------------------------------------------------------------------------------------------- */
/* The review queue — /api/v1/ingestion/review, spec/data-model.md §6.1                            */
/* -------------------------------------------------------------------------------------------- */

export type ReviewStatus = 'open' | 'accepted' | 'rejected' | 'deferred' | 'superseded';

export type ReviewSubjectType =
  | 'document'
  | 'item'
  | 'attachment'
  | 'creator'
  | 'shadow_work'
  | 'merge_candidate'
  | 'ingest_batch'
  | 'check_result'
  | 'enrichment'
  | 'job';

export type ReviewProposedAction =
  | 'merge'
  | 'link'
  | 'create_item'
  | 'set_fields'
  | 'discard'
  | 'retry'
  | 'none';

export type ReviewSeverity = 'info' | 'warning' | 'blocker';

/** Which proposed actions this build of the server can execute. Anything else is a 409 on accept. */
export const EXECUTABLE_ACTIONS: readonly ReviewProposedAction[] = ['create_item', 'discard', 'none'];

export interface ReviewEntry {
  id: string;
  subjectType: ReviewSubjectType;
  subjectId: string;
  secondarySubjectType: string | null;
  secondarySubjectId: string | null;
  reasonCode: string;
  /** Stored when the entry was raised, not generated at render time (§6.1). */
  explanation: string;
  proposedAction: ReviewProposedAction | null;
  /** Exactly what accepting will execute (RQ1). Null when there is nothing to propose. */
  proposedPayload: unknown;
  confidence: number | null;
  severity: ReviewSeverity;
  status: ReviewStatus;
  sourceStage: string | null;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  /** What was actually executed, which §6.1 allows to differ from the proposal. */
  resolutionPayload: unknown;
}

/** The flat proposal a `create_item` entry carries. Field paths are dotted and facet-qualified. */
export interface ProposedItemPayload {
  itemType?: string;
  fields?: Record<string, string | number | boolean | null>;
  tags?: string[];
  collectionIds?: string[];
  customFields?: Record<string, string | number | boolean | null>;
  notes?: string[];
  confidence?: number;
}

/**
 * The corrections a reviewer may make while accepting.
 *
 * `fields` and `customFields` are patches over the proposal's own maps — a `null` removes the key —
 * and everything else replaces wholesale. That asymmetry is the server's and is the right one: an
 * editor that had to resend forty extracted fields to correct one correspondent is an editor
 * nobody uses.
 */
export interface ReviewEdits {
  itemType?: string;
  fields?: Record<string, string | number | boolean | null>;
  tags?: string[];
  collectionIds?: string[];
  customFields?: Record<string, string | number | boolean | null>;
  notes?: string[];
}

export interface ReviewAcceptRequest {
  /** Recorded as `resolution_note` and in the audit log. */
  note?: string;
  edits?: ReviewEdits;
}

export interface ReviewRejectRequest {
  note?: string;
}

export interface ReviewAcceptResult {
  entry: ReviewEntry;
  /** Set when accepting created an item. Null for `discard` and `none`. */
  itemId: string | null;
  attachmentId: string | null;
  warnings: string[];
}

export interface ReviewListQuery {
  status?: ReviewStatus;
  reasonCode?: string;
  subjectType?: ReviewSubjectType;
  subjectId?: string;
  jobId?: string;
  severity?: ReviewSeverity;
  limit?: number;
  order?: 'asc' | 'desc';
}

/* -------------------------------------------------------------------------------------------- */
/* Rules — /api/v1/rules                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * One stored rule.
 *
 * `ruleId` is the author's stable handle — what a trace names and what `item_tags.rule_ref` points
 * at — and `id` is the ULID of the row, so renaming the handle is a deliberate act with a visible
 * consequence rather than a side effect of an edit.
 */
export interface Rule {
  id: string;
  ruleId: string;
  kind: RuleKind;
  description: string | null;
  enabled: boolean;
  priority: number;
  when: unknown;
  then: unknown[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuleCreate {
  ruleId: string;
  kind: RuleKind;
  when: IngestionCondition | unknown;
  then: (IngestionAction | unknown)[];
  description?: string;
  enabled?: boolean;
  priority?: number;
}

export interface RuleUpdate {
  description?: string | null;
  enabled?: boolean;
  priority?: number;
  when?: unknown;
  then?: unknown[];
}

/** The subject a dry run evaluates a rule set against. Mirrors `IngestionRuleSubject`. */
export interface RuleDryRunSubject {
  id: string;
  source?: string;
  sender?: string;
  recipients?: string[];
  subject?: string;
  path?: string;
  filename?: string;
  mime?: string;
  text?: string;
  itemType?: string;
  tags?: string[];
  resolvers?: { resolver: string; outcome: string; identifier?: string; confidence?: number }[];
}

export interface RuleDryRunRequest {
  kind?: RuleKind;
  mode?: RuleMode;
  limits?: RuleLimits;
  /** Rules to evaluate instead of the stored set — the whole point of a dry run before saving. */
  rules?: RuleCreate[];
  includeDisabled?: boolean;
  subjects: RuleDryRunSubject[];
  maxTraces?: number;
}

export interface RuleDryRunEntry {
  subjectId: string;
  /** The engine's `IngestionOutcome`: the item type, tags, collections and fields it would set. */
  outcome: unknown;
  trace?: EvaluationTrace;
}

export interface RuleDryRunResponse {
  ruleSet: string;
  kind: string;
  mode: string;
  subjectCount: number;
  entries: RuleDryRunEntry[];
  /** One row per rule whatever its outcome. A rule that never fires is news. */
  rules: RuleStatistics[];
  unmatchedSubjectIds: string[];
  erroredSubjectIds: string[];
  warnings: string[];
}

/**
 * The outcome shape `ingestionFacet` produces, as much of it as the report renders.
 *
 * Typed loosely on the wire (`z.unknown()`), so it is narrowed here rather than asserted: a report
 * that assumed a field and found none would render an empty row and call it "no change".
 */
export interface IngestionDryRunOutcome {
  itemType?: string | null;
  addTags?: string[];
  addCollections?: string[];
  setFields?: Record<string, unknown>;
  setCustomFields?: Record<string, unknown>;
  correspondent?: string | null;
  confidence?: number | null;
  review?: { reasonCode: string; explanation: string; severity?: string } | null;
  stopped?: boolean;
}

/* -------------------------------------------------------------------------------------------- */
/* The share-target upload — /api/v1/ingestion/upload                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * One upload, one answer.
 *
 * The endpoint runs the whole pipeline, so it can say which of the six outcomes happened and hand
 * back either the item the gate accepted or the review entry that says why there is not one. A
 * share-target client renders one or the other and never polls to find out which.
 */
export interface IngestUploadResult {
  outcome: 'ingested' | 'duplicate' | 'review' | 'container' | 'stopped' | 'failed';
  jobId: string;
  document: Document | null;
  item: Item | null;
  reviewEntry: ReviewEntry | null;
  reasonCode: string | null;
  detail: string;
}

export interface IngestUploadFields {
  filename: string;
  sourceKind?: string;
  sourceId?: string;
  title?: string;
  sender?: string;
  subject?: string;
  runLabel?: string;
}

/** Re-exported so a component can name the engine's own types without a second import. */
export type {
  ActionTrace,
  ConditionTrace,
  EvaluationTrace,
  IngestionAction,
  IngestionCondition,
  RuleKind,
  RuleLimits,
  RuleMode,
  RuleStatistics,
  RuleTrace,
};
