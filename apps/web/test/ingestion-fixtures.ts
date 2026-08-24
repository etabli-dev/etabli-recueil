/**
 * Fixtures for the ingestion surfaces.
 *
 * Typed as the contract types in `src/api/ingestion.ts`, which mirror the server's own
 * `schemas-ingestion.ts`, so a change to the wire shape breaks these files at compile time rather
 * than producing tests that pass against something the server no longer sends. The traces are typed
 * as `EvaluationTrace` from `@recueil/rules` — the engine's own type — for the same reason: the
 * dry-run report renders the trace the engine produces, not an approximation of it.
 */
import type { Document, Page } from '@recueil/schemas';
import type { EvaluationTrace, IngestionOutcome } from '@recueil/rules';

import type {
  IngestionJob,
  IngestionJobDetail,
  IngestionSource,
  ReviewAcceptResult,
  ReviewEntry,
  Rule,
  RuleDryRunResponse,
  TestConnectionResult,
} from '../src/api/ingestion.js';

const NOW = '2026-08-22T09:15:00.000Z';

export const page = <TValue>(data: TValue[], hasMore = false, limit = 50): Page<TValue> => ({
  data,
  page: { nextCursor: null, hasMore, limit },
});

/* Documents ------------------------------------------------------------------------------------ */

export const DOCUMENT_ID = '01J8F3Z9K4DOC000000000001A';

export const scanDocument = (overrides: Partial<Document> = {}): Document =>
  ({
    id: DOCUMENT_ID,
    sha256: 'a'.repeat(64),
    byteSize: 184_320,
    mimeType: 'application/pdf',
    storageBackend: 'local',
    storageKey: `aa/bb/${'a'.repeat(64)}`,
    storageOk: true,
    hasTextLayer: false,
    originalFilename: 'scan-0042.pdf',
    sourceKind: 'scanner',
    sourceRef: '/srv/consume/scans/Acme GmbH/scan-0042.pdf',
    libraryState: 'normal',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as Document;

/* The review queue ------------------------------------------------------------------------------ */

export const REVIEW_ENTRY_ID = '01J8F3Z9K4REVIEW0000000001';
export const SECOND_ENTRY_ID = '01J8F3Z9K4REVIEW0000000002';
export const CREATED_ITEM_ID = '01J8F3Z9K4ITEM0000000000A1';
/**
 * The `ingest.source` job — the source run.
 *
 * This is what `POST /ingestion/sources/{id}/run` returns and what the source stores as
 * `lastRunJobId`. It is **not** the id a review entry carries; see `PIPELINE_JOB_ID`.
 */
export const JOB_ID = '01J8F3Z9K4JOB00000000000A1';

/**
 * The `ingest.run` job the source run spawned — and the id review entries are stamped with.
 *
 * These two are deliberately different values, because on a real server they are different values,
 * and a fixture that reused one id for both would let the screen filter the review queue by the
 * wrong key and still pass. That is not hypothetical: it is the defect this pair was introduced to
 * catch, found by the end-to-end suite against a real server after the component tests had gone
 * green against a fixture where the two ids were the same.
 *
 * The shape below — `result.pipelineJobId` alongside `counts` and `offered` — is transcribed from
 * what `GET /api/v1/ingestion/queue/{id}` actually returned for a folder run.
 */
export const PIPELINE_JOB_ID = '01J8F3Z9K4PIPELINEJOB00001';

export const reviewEntry = (overrides: Partial<ReviewEntry> = {}): ReviewEntry => ({
  id: REVIEW_ENTRY_ID,
  subjectType: 'document',
  subjectId: DOCUMENT_ID,
  secondarySubjectType: null,
  secondarySubjectId: null,
  reasonCode: 'low_confidence_metadata',
  explanation:
    'The correspondent was read from the directory name and no document date was found, so the confidence gate refused it at 0.60.',
  proposedAction: 'create_item',
  proposedPayload: {
    itemType: 'invoice',
    fields: { 'office.correspondent': 'Acme GmbH', 'office.asn': 1042 },
    tags: ['scanned'],
    collectionIds: [],
    customFields: {},
    notes: [],
    confidence: 0.6,
  },
  confidence: 0.6,
  severity: 'warning',
  status: 'open',
  sourceStage: 'ingest.9',
  // The pipeline job, not the source run: this is the column the server writes and the one the
  // review queue's `jobId` filter matches against.
  jobId: PIPELINE_JOB_ID,
  createdAt: NOW,
  updatedAt: NOW,
  resolvedAt: null,
  resolutionNote: null,
  resolutionPayload: null,
  ...overrides,
});

export const secondEntry = (): ReviewEntry =>
  reviewEntry({
    id: SECOND_ENTRY_ID,
    reasonCode: 'near_duplicate_file',
    severity: 'info',
    explanation: 'These bytes differ from an existing scan only in their annotations.',
    proposedAction: 'link',
    proposedPayload: null,
    confidence: 0.91,
    jobId: null,
  });

export const acceptResult = (overrides: Partial<ReviewAcceptResult> = {}): ReviewAcceptResult => ({
  entry: reviewEntry({ status: 'accepted', resolvedAt: NOW }),
  itemId: CREATED_ITEM_ID,
  attachmentId: '01J8F3Z9K4ATT000000000001A',
  warnings: [],
  ...overrides,
});

/* The run that raised it -------------------------------------------------------------------------- */

export const ingestionJob = (overrides: Partial<IngestionJob> = {}): IngestionJob => ({
  id: JOB_ID,
  jobType: 'ingest.source',
  state: 'waiting_review',
  idempotencyKey: 'ingest.source:01J8F3Z9K4SOURCE000000001A:api-2026-08-22T09:15:00.000Z',
  params: { sourceId: '01J8F3Z9K4SOURCE000000001A', sourceName: 'Scanner drop', runLabel: 'api-2026-08-22T09:15:00.000Z' },
  priority: 0,
  attempts: 1,
  maxAttempts: 3,
  progress: { done: 7, total: 7 },
  runAfter: NOW,
  startedAt: NOW,
  finishedAt: '2026-08-22T09:16:04.000Z',
  heartbeatAt: null,
  // The run's own report. `pipelineJobId` is the only part of it this client reads — it is the
  // foreign key the review queue is then asked about. `counts.review` is deliberately left
  // disagreeing with the queue in some tests, because a backlog taken from here rather than from
  // the queue is exactly the mistake worth failing on.
  result: {
    offered: 7,
    skipped: 0,
    recovered: 0,
    refusedAcknowledgements: 0,
    pipelineJobId: PIPELINE_JOB_ID,
    counts: { ingested: 6, duplicates: 0, review: 1, containers: 0, stopped: 0, failed: 0 },
    verificationPassed: true,
  },
  error: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

export const jobDetail = (overrides: Partial<IngestionJobDetail> = {}): IngestionJobDetail => ({
  job: ingestionJob(),
  stages: [
    {
      candidateKey: 'cand-1',
      stage: 'type_detection',
      sha256: 'a'.repeat(64),
      payload: { detected: 'scan' },
      createdAt: NOW,
    },
    {
      candidateKey: 'cand-1',
      stage: 'rules',
      sha256: 'a'.repeat(64),
      payload: {
        matched: ['scanner-by-folder'],
        conflicts: [
          { path: 'office.correspondent', ruleId: 'scanner-by-folder', previousRuleId: 'default-correspondent' },
        ],
      },
      createdAt: NOW,
    },
  ],
  log: [
    {
      id: 'log-1',
      loggedAt: NOW,
      level: 'info',
      message: 'rules matched: scanner-by-folder',
      data: null,
      subjectType: 'document',
      subjectId: DOCUMENT_ID,
    },
  ],
  reviewEntryIds: [REVIEW_ENTRY_ID],
  ...overrides,
});

/* Sources ------------------------------------------------------------------------------------------ */

export const SOURCE_ID = '01J8F3Z9K4SOURCE000000001A';

export const folderSource = (overrides: Partial<IngestionSource> = {}): IngestionSource => ({
  id: SOURCE_ID,
  name: 'Scanner drop',
  kind: 'folder',
  enabled: true,
  sourceKind: 'scanner',
  config: { kind: 'folder', root: '/srv/consume', recursive: true, skipHidden: true, watch: true },
  consume: { mode: 'move', to: '.processed' },
  secretNames: [],
  lastRunJobId: JOB_ID,
  lastRunAt: NOW,
  lastError: null,
  version: 2,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

export const testResult = (overrides: Partial<TestConnectionResult> = {}): TestConnectionResult => ({
  sourceId: SOURCE_ID,
  kind: 'folder',
  ok: true,
  checkedAt: '2026-08-22T09:20:00.000Z',
  durationMs: 12,
  checks: [
    { check: 'resolve', ok: true, detail: '/srv/consume resolves inside the allowed roots' },
    { check: 'directory', ok: true, detail: 'it is a directory and is readable' },
  ],
  detail: '2 check(s) passed',
  ...overrides,
});

/* Rules ---------------------------------------------------------------------------------------------- */

export const RULE_ROW_ID = '01J8F3Z9K4RULE00000000001A';
export const NESTED_RULE_ROW_ID = '01J8F3Z9K4RULE00000000002A';

export const scannerRule = (overrides: Partial<Rule> = {}): Rule => ({
  id: RULE_ROW_ID,
  ruleId: 'scanner-by-folder',
  kind: 'ingestion',
  description: "Trust the scanner's own filing convention.",
  enabled: true,
  priority: 100,
  when: { type: 'source', match: { equals: 'scanner' } },
  then: [
    { type: 'set-item-type', itemType: 'invoice' },
    { type: 'add-to-collection', collection: 'Office/Scans' },
  ],
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

/** A rule the form declines to edit, so the read-only path is exercised. */
export const nestedRule = (): Rule =>
  scannerRule({
    id: NESTED_RULE_ROW_ID,
    ruleId: 'nested-rule',
    description: 'Anything not already filed.',
    priority: 0,
    when: { not: { type: 'tag', match: { equals: 'filed' } } },
    then: [{ type: 'add-tags', tags: ['unfiled'] }],
  });

const outcome: IngestionOutcome = {
  itemType: { value: 'invoice', ruleId: 'scanner-by-folder' },
  collections: [{ value: 'Office/Scans', ruleId: 'scanner-by-folder', create: true }],
  tags: [],
  customFields: [],
  review: [],
  stopped: false,
  conflicts: [],
  untouched: false,
};

export const ingestionTrace = (overrides: Partial<EvaluationTrace> = {}): EvaluationTrace => ({
  kind: 'ingestion',
  ruleSet: 'inline',
  mode: 'all-match',
  subjectId: DOCUMENT_ID,
  matchedRuleIds: ['scanner-by-folder'],
  warnings: ['the extracted text was truncated at 100000 characters'],
  rules: [
    {
      ruleId: 'scanner-by-folder',
      description: "Trust the scanner's own filing convention.",
      order: 0,
      priority: 100,
      outcome: 'matched',
      condition: { type: 'source', matched: true, detail: 'source equals scanner', evidence: 'scanner' },
      actions: [{ type: 'set-item-type', outcome: 'applied', detail: 'item type set to invoice' }],
      captures: { correspondent: 'Acme GmbH' },
    },
    {
      ruleId: 'nested-rule',
      order: 1,
      priority: 0,
      outcome: 'not-matched',
      condition: { type: 'not', matched: false, detail: 'the member matched' },
      actions: [],
    },
  ],
  ...overrides,
});

export const dryRunResponse = (overrides: Partial<RuleDryRunResponse> = {}): RuleDryRunResponse => ({
  ruleSet: 'inline',
  kind: 'ingestion',
  mode: 'all-match',
  subjectCount: 3,
  entries: [
    { subjectId: DOCUMENT_ID, outcome, trace: ingestionTrace() },
    {
      subjectId: 'doc-2',
      outcome: { collections: [], tags: [], customFields: [], review: [], stopped: false, conflicts: [], untouched: true },
    },
  ],
  rules: [
    { ruleId: 'scanner-by-folder', order: 0, priority: 100, matched: 1, notMatched: 2, notReached: 0, disabled: 0, errors: 0 },
    { ruleId: 'nested-rule', order: 1, priority: 0, matched: 0, notMatched: 3, notReached: 0, disabled: 0, errors: 0 },
  ],
  unmatchedSubjectIds: ['doc-3'],
  erroredSubjectIds: [],
  warnings: [],
  ...overrides,
});

/**
 * The stored rules as one document.
 *
 * Written out rather than produced by `rulesToText`, so a test that asserts the round trip is
 * comparing against a fixture rather than against the function under test.
 */
export const RULE_SET_TEXT = `version: 1
kind: ingestion
rules:
  - id: scanner-by-folder
    description: Trust the scanner's own filing convention.
    priority: 100
    when:
      type: source
      match:
        equals: scanner
    then:
      - type: set-item-type
        itemType: invoice
      - type: add-to-collection
        collection: Office/Scans
  - id: nested-rule
    description: Anything not already filed.
    when:
      not:
        type: tag
        match:
          equals: filed
    then:
      - type: add-tags
        tags:
          - unfiled
`;
