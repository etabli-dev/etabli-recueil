/**
 * The ten stages of CONCEPT §5.3, as one composable pipeline.
 *
 * ```
 *  1 hash, size, MIME               → sha256 + sniffed media type, from the bytes alone
 *  2 exact duplicate check          → link to the existing document, log, stop
 *  3 archive extraction (zip, eml)  → members to scratch, each re-entering at stage 1
 *  4 type detection                 → scholarly PDF | scan | office document | image
 *  5 OCR when there is no text layer→ OcrEngine, behind an interface
 *  6 metadata extraction            → MetadataExtractor: GROBID, or the office heuristics
 *  7 identifier resolution          → identifiers found and, where a resolver exists, checked
 *  8 rule engine                    → item type, collection, tags, custom fields
 *  9 confidence gate                → auto-accept, or a review entry with the reason (P3)
 * 10 single-transaction commit      → item, attachment, facets, index; then events
 * ```
 *
 * Every anchor is a hook point, `before` and `after` (`spec/hooks.md` §6.5), so a plugin can insert
 * a stage without this file knowing about it.
 *
 * The four properties §5.3 demands, and where each is:
 *
 * **Idempotent by `(hash, source, path)`.** The hash comes from stage 1, the source and path from
 * `IngestRef`, and the three together are `candidateKey` plus the digest. A second ingest of the
 * same bytes finds the document at stage 2, records the new *arrival* in `document_provenance` —
 * because a second arrival is a new fact (P4) — and stops without a second document and without a
 * second item.
 *
 * **Resumable.** Every stage writes a checkpoint. An interrupted run picks up at the first stage
 * that never finished, which is what keeps a twenty-minute OCR pass from being paid for twice.
 *
 * **Configurable concurrency, conservative default.** Two, from `DEFAULT_INGEST_CONFIG`, over a
 * worker pool that keeps exactly that many candidates in flight.
 *
 * **Scratch cleaned after hashing, even on failure.** `ScratchManager.with` disposes in a
 * `finally`, and the run report states whether the root ended up empty rather than assuming it.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { nowTimestamp, schema, sniffMimeType } from '@recueil/core';
import type { Actor, Recueil } from '@recueil/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { archiveKind, emailMetadata, extractArchive } from './archive/extract.js';
import type { ExtractedMember } from './archive/extract.js';
import { DocumentAlreadyFiledError, commitProposal } from './commit.js';
import type { CommitResult } from './commit.js';
import { CONFIDENCE_WEIGHTS, ConfidenceLedger } from './confidence.js';
import { resolveConfig } from './config.js';
import type { IngestConfig } from './config.js';
import { ensureIngestSchema } from './db/install.js';
import {
  CandidateJournal,
  candidateKey,
  claimRun,
  finishRun,
  logRun,
  runIdempotencyKey,
  setProgress,
} from './db/journal.js';
import { ReviewQueueService } from './db/review-queue.js';
import { INGEST_REASON_CODES, reviewQueue as reviewQueueTable } from './db/schema.js';
import type { ReviewQueueRow, ReviewSubjectType } from './db/schema.js';
import { detectType } from './detect/type.js';
import { recordDocumentFacts } from './document-facts.js';
import { EventBus } from './events.js';
import type { IngestEvent, IngestEventSink } from './events.js';
import { IngestError, IngestCancelledError } from './errors.js';
import { IngestStageRegistry, hookContext } from './hooks.js';
import type { IngestStage, IngestStageInput, StagePosition } from './hooks.js';
import { OfficeHeuristicExtractor } from './metadata/office.js';
import type { ExtractedMetadata, MetadataExtractor } from './metadata/extractor.js';
import { UnavailableOcrEngine } from './ocr/engine.js';
import type { OcrEngine } from './ocr/engine.js';
import { extractIdentifiers } from './resolve/identifiers.js';
import type { IdentifierResolver, ResolutionRecord } from './resolve/resolver.js';
import { RuleEngine } from './rules/engine.js';
import type { RuleEvaluation, RuleSubject } from './rules/engine.js';
import type { IngestRule } from './rules/types.js';
import { ScratchManager } from './scratch.js';
import { extractPdfText } from './text/pdf-text.js';
import { simhash } from './text/simhash.js';
import {
  emptyProposal,
  stageLabel,
} from './types.js';
import type {
  DetectedType,
  Identifier,
  IngestCandidate,
  IngestOutcome,
  IngestRef,
  ItemProposal,
  JsonObject,
  PipelineAnchor,
  ProposalPatch,
  Sha256,
} from './types.js';

/* ------------------------------------------------------------------------------------------ */
/* Options and reports                                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface IngestPipelineOptions {
  recueil: Recueil;
  config?: Partial<IngestConfig>;
  /** Behind an interface on purpose (CONCEPT §5.1). Defaults to "no OCR is configured". */
  ocr?: OcrEngine;
  /** GROBID, the office heuristics, a plugin. The office heuristics are included by default. */
  extractors?: readonly MetadataExtractor[];
  /** Stage 7. None by default: Phase 2 finds identifiers, Phase 3 resolves them. */
  resolvers?: readonly IdentifierResolver[];
  rules?: readonly IngestRule[];
  /**
   * Evaluate stage 8 with something other than the built-in engine.
   *
   * The seam exists because `@recueil/rules` is being built alongside this package as the fuller,
   * versioned, traced rule engine of CONCEPT §5.6, and the pipeline should be able to adopt it as
   * a constructor argument rather than a rewrite. Anything that turns a `RuleSubject` into a
   * `RuleEvaluation` will do; `rules` is ignored when this is given.
   */
  ruleEngine?: RuleEvaluator;
  /** Plugin stages, per `spec/hooks.md` §6.5. */
  stages?: IngestStageRegistry;
  events?: IngestEventSink;
  actor?: Actor;
  /**
   * Keep the container document of an archive.
   *
   * A `.eml` is content — the message is the thing, and its body becomes a Note — so it is stored.
   * A `.zip` is a lorry: keeping it means keeping every member's bytes twice, once compressed and
   * once not, for a file nobody will ever open. It is therefore *not* stored by default, and the
   * members instead carry `sourceDetail.archive` so the provenance survives. Turn it on for a
   * deployment that would rather pay the disk than lose the envelope; when it is on, members also
   * get `documents.parent_document_id`.
   *
   * An archive the pipeline could not read is always kept, whatever this says — losing the one copy
   * of a file because the reader did not understand it would be the worst possible trade.
   */
  storeArchiveContainers?: { zip?: boolean; eml?: boolean };
  /**
   * How long a candidate may wait for another candidate with the same digest to finish.
   *
   * The gate that makes stage 2 and stage 10 one critical section is held for the whole of a
   * candidate's pipeline, so a second copy of a two-hundred-page scan legitimately waits out the
   * first one's OCR. The default is therefore generous — thirty minutes — and exists only so that
   * the one shape that could deadlock cannot hang the run: two archives that each contain the
   * other's bytes, where each holds the lease the other is waiting for. Under ADR-0022 exceeding
   * the budget is a review outcome, not a crash: the wait throws, the candidate retries, and after
   * `maxAttemptsPerCandidate` it reaches the review queue naming this limit.
   */
  digestLockTimeoutMs?: number;
}

/** The shape stage 8 needs from a rule engine, and nothing more. */
export interface RuleEvaluator {
  evaluate(subject: RuleSubject): RuleEvaluation;
}

export interface RunOptions {
  /** Names the run. The same label resumes; a new label re-scans from the beginning. */
  runLabel: string;
  /** Defaults to the first candidate's `ref.sourceId`. */
  sourceId?: string;
  /** How many candidates there are, when the caller knows. Drives `jobs.progress_total`. */
  total?: number;
  signal?: AbortSignal;
  /** Recorded on the job row, so a re-run can see what it was asked to do. */
  params?: Record<string, unknown>;
}

export interface CandidateOutcome {
  ref: IngestRef;
  outcome: IngestOutcome;
}

export interface RunCounts {
  ingested: number;
  duplicates: number;
  review: number;
  containers: number;
  stopped: number;
  failed: number;
}

/**
 * What the run actually did, checked against the database rather than narrated from the run's own
 * bookkeeping.
 *
 * The Phase 1 review found three "blocking" checks in the Zotero importer that counted the
 * importer's own log entries and therefore could not fail. The lesson is written into the shape of
 * this type: every number in `queried` comes from a `SELECT` over the library, every number in
 * `claimed` comes from the run's in-memory tally, and each check compares one against the other. A
 * check that reads only one side is not a check.
 */
export interface IngestVerification {
  claimed: RunCounts;
  queried: {
    /** `documents` rows whose first arrival was recorded by this run. */
    documentsCreated: number;
    /**
     * Distinct `(document_id, source_ref)` arrivals carrying this run's job id.
     *
     * Distinct, not raw rows: a candidate that threw after stage 2 and was retried writes a second
     * `document_provenance` row for the same document and the same source reference, and counting
     * those as separate arrivals would make the comparison below untrue for a reason that is not a
     * defect.
     */
    arrivalsRecorded: number;
    /** Live items holding an attachment to a document this run touched. */
    itemsWithAttachment: number;
    /**
     * Live attachments to documents this run touched, whoever made them.
     *
     * Context, deliberately not a check. The Phase 2 review noted this number was "computed and
     * then never compared with anything", which is true and stays true: the only equality one
     * could assert over it — one attachment per touched document — is exactly the state ADR-0004
     * exists to permit, because a document a *previous* run filed may since have been attached to
     * a second item by a person. The comparison that does catch this run over-filing is
     * `documents_filed_once`, which is scoped to the items this run created and can therefore
     * distinguish the two. A number a person reads is not the same thing as a check, and calling
     * this one a check would be the decoration ADR-0021 §5 tells us to delete.
     */
    attachments: number;
    /** Documents this run touched that `document_provenance` records an arrival for, this job. */
    documentsWithArrivals: number;
    /** Open `review_queue` rows raised by this run, whatever raised them. */
    openReviewEntries: number;
    /** Of those, the ones a person must clear before the run can be called finished. */
    blockerReviewEntries: number;
    /**
     * Documents this run touched that carry no live attachment.
     *
     * **Counted, never derived.** The Phase 2 review found this number computed as
     * `documents.length - itemsWithAttachment`, which goes *negative* the moment one document
     * acquires two items — and a negative count sailed through the `<=` below. ADR-0021: a count
     * that can go negative is a bug, not a diagnostic.
     */
    documentsWithoutAttachment: number;
    /** `documents` rows still present for the ids this run touched. */
    documentsPresent: number;
    /** Live items the run says it created that the library actually holds. */
    itemsCreatedPresent: number;
    /** Live attachments belonging to the items this run created. */
    attachmentsCreated: number;
    /** Distinct documents underneath those attachments. Equal to `attachmentsCreated` or we duped. */
    documentsFiledByRun: number;
    /** Open `review_queue` rows the run can name, out of the entries it says it raised. */
    namedReviewEntriesOpen: number;
  };
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  /** True when every check passed. */
  pass: boolean;
}

export interface IngestRunReport {
  runId: string;
  idempotencyKey: string;
  resumed: boolean;
  startedAt: string;
  finishedAt: string;
  counts: RunCounts;
  outcomes: CandidateOutcome[];
  verification: IngestVerification;
  /** True when the run's scratch root was empty when the run ended. Checked, not assumed. */
  scratchClean: boolean;
}

/* ------------------------------------------------------------------------------------------ */
/* The digest gate                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * Thirty minutes. Long enough that a second copy of a two-hundred-page scan waits out the first
 * one's OCR rather than being refused; short enough that a run cannot hang for ever.
 */
const DEFAULT_DIGEST_LOCK_TIMEOUT_MS = 30 * 60_000;

export interface DigestLease {
  release(): void;
}

/** The wait exceeded `digestLockTimeoutMs` (ADR-0022: a budget, and a review outcome when spent). */
export class DigestLockTimeoutError extends IngestError {
  constructor(sha256: string, timeoutMs: number) {
    super(
      `Another candidate carrying the same bytes (${sha256.slice(0, 12)}…) held the ingestion ` +
        `lease for longer than ${String(timeoutMs)} ms, so this one refused to proceed rather ` +
        'than risk filing the same document twice.',
      'digest_lock_timeout',
      { sha256, timeoutMs },
    );
  }
}

/**
 * A mutual-exclusion gate keyed by digest.
 *
 * The pipeline's idempotence claim — "a second ingest of the same bytes finds the document at
 * stage 2 and stops" — is only true if the finding and the filing cannot interleave. Nothing in
 * SQL enforces it: `attachments` deliberately has no unique index on `document_id`, because
 * ADR-0004's whole point is that one stored file may hang off several items, and a constraint that
 * forbade it would forbid the feature. So the exclusion lives here instead, and the commit carries
 * a second, transactional check for the case this one cannot see (another process).
 *
 * Waiters are served in arrival order: each registers a promise of its own on the key's tail and
 * waits for the tail it displaced. The key is dropped once no holder or waiter is left, so the map
 * does not grow with the corpus.
 */
class DigestGate {
  private readonly tail = new Map<string, Promise<void>>();
  private readonly holders = new Map<string, number>();

  async acquire(key: string, timeoutMs: number): Promise<DigestLease> {
    const previous = this.tail.get(key);
    let finish!: () => void;
    const mine = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.tail.set(key, previous === undefined ? mine : previous.then(() => mine));
    this.holders.set(key, (this.holders.get(key) ?? 0) + 1);

    let released = false;
    const lease: DigestLease = {
      release: () => {
        if (released) return;
        released = true;
        // Resolving first, so a waiter behind this one is unblocked even if the bookkeeping below
        // is the last thing this key ever needs.
        finish();
        const left = (this.holders.get(key) ?? 1) - 1;
        if (left <= 0) {
          this.holders.delete(key);
          this.tail.delete(key);
        } else {
          this.holders.set(key, left);
        }
      },
    };

    if (previous !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const outcome = await Promise.race([previous.then((): 'acquired' => 'acquired'), expiry]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === 'timeout') {
        // Release rather than abandon: an unreleased lease would stall every candidate queued
        // behind this one for the life of the process.
        lease.release();
        throw new DigestLockTimeoutError(key, timeoutMs);
      }
    }

    return lease;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The pipeline                                                                                 */
/* ------------------------------------------------------------------------------------------ */

interface CandidateContext {
  runId: string;
  journal: CandidateJournal;
  scratch: ScratchManager;
  signal: AbortSignal;
  attempt: number;
  depth: number;
  /** The archive this candidate came out of, when it came out of one. */
  parent: { documentId: string | null; sha256: Sha256; entryName: string } | null;
  touchedDocumentIds: Set<string>;
  /**
   * Digests this candidate's own ancestry is holding the gate on, shared by reference down the
   * archive chain. A member whose bytes are its container's would otherwise wait on a lease its own
   * caller holds and never get it; this makes the gate re-entrant along one line of descent and
   * nowhere else.
   */
  heldDigests: Set<string>;
}

/** What stage 1 knows before the gate closes. */
interface HashedCandidate {
  sha256: Sha256;
  byteSize: number;
  mediaType: string;
  archive: 'zip' | 'eml' | null;
}

interface Stage2Checkpoint {
  documentId: string;
  sha256: Sha256;
  byteSize: number;
  mediaType: string;
  created: boolean;
  /** What was true when the checkpoint was written. Informational: the pipeline re-queries it. */
  alreadyFiled: boolean;
}

export class IngestPipeline {
  readonly config: IngestConfig;
  readonly reviewQueue: ReviewQueueService;
  readonly rules: RuleEvaluator;
  readonly stages: IngestStageRegistry;
  readonly events: IngestEventSink;

  private readonly recueil: Recueil;
  private readonly ocr: OcrEngine;
  private readonly extractors: readonly MetadataExtractor[];
  private readonly resolvers: readonly IdentifierResolver[];
  private readonly actor: Actor;
  private readonly storeContainers: { zip: boolean; eml: boolean };
  private readonly digestLockTimeoutMs: number;
  /**
   * The in-flight set of CONCEPT §5.3's idempotence promise, keyed by sha256.
   *
   * One per pipeline instance rather than per run, so two runs sharing an instance serialise too.
   * It is in-process only; `commitProposal`'s `refuseIfDocumentFiled` is the half that holds across
   * processes.
   */
  private readonly digestGate = new DigestGate();

  constructor(options: IngestPipelineOptions) {
    this.recueil = options.recueil;
    this.config = resolveConfig(options.config);
    this.ocr = options.ocr ?? new UnavailableOcrEngine();
    this.extractors = options.extractors ?? [new OfficeHeuristicExtractor()];
    this.resolvers = options.resolvers ?? [];
    this.rules = options.ruleEngine ?? new RuleEngine(options.rules ?? []);
    this.stages = options.stages ?? new IngestStageRegistry();
    this.events = options.events ?? new EventBus();
    this.actor = options.actor ?? this.recueil.actor;
    this.storeContainers = {
      zip: options.storeArchiveContainers?.zip ?? false,
      eml: options.storeArchiveContainers?.eml ?? true,
    };
    this.digestLockTimeoutMs = options.digestLockTimeoutMs ?? DEFAULT_DIGEST_LOCK_TIMEOUT_MS;

    // The queue's table is not in core's migration series yet; see `db/install.ts`.
    ensureIngestSchema(this.recueil.connection);
    this.reviewQueue = new ReviewQueueService(this.recueil.db, this.recueil.audit);
  }

  /**
   * Run a batch.
   *
   * Idempotent and resumable through `runLabel`: the same label takes over an unfinished run and
   * skips the candidates it already committed; a label whose run succeeded starts over, which is
   * cheap because stage 2 answers most of it.
   */
  async run(
    candidates: Iterable<IngestCandidate> | AsyncIterable<IngestCandidate>,
    options: RunOptions,
  ): Promise<IngestRunReport> {
    const list = await collect(candidates);
    const sourceId = options.sourceId ?? list[0]?.ref.sourceId ?? 'unknown';
    const idempotencyKey = runIdempotencyKey(sourceId, options.runLabel);

    const handle = claimRun(this.recueil, {
      idempotencyKey,
      params: options.params ?? { sourceId, runLabel: options.runLabel, candidates: list.length },
      total: options.total ?? list.length,
    });

    const startedAt = nowTimestamp();
    const scratch = new ScratchManager(this.config.scratchRoot);
    const controller = new AbortController();
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    const outcomes: CandidateOutcome[] = [];
    const touchedDocumentIds = new Set<string>();
    let done = 0;

    logRun(this.recueil, handle.id, {
      level: 'info',
      message: handle.resumed
        ? `resuming run '${options.runLabel}' with ${String(handle.completed.size)} candidate(s) already committed`
        : `starting run '${options.runLabel}' over ${String(list.length)} candidate(s)`,
      data: { sourceId, concurrency: this.config.concurrency },
    });

    try {
      await this.pool(list, async (candidate) => {
        const key = candidateKey(candidate.ref);
        const already = handle.completed.get(key);
        if (already !== undefined) {
          outcomes.push({ ref: candidate.ref, outcome: already });
          collectDocumentIds(already, touchedDocumentIds);
          done += 1;
          setProgress(this.recueil, handle.id, done);
          logRun(this.recueil, handle.id, {
            level: 'debug',
            message: 'skipped: this candidate committed in an earlier attempt of this run',
            subjectType: 'ingest_candidate',
            subjectId: candidate.ref.externalId,
          });
          return;
        }

        const outcome = await this.ingestWithRetries(candidate, {
          runId: handle.id,
          journal: new CandidateJournal(this.recueil, handle.id, key),
          scratch,
          signal: controller.signal,
          attempt: 1,
          depth: 0,
          parent: null,
          touchedDocumentIds,
          // Fresh per top-level candidate: the set records this line of descent's own leases, and
          // two candidates must never see each other's.
          heldDigests: new Set<string>(),
        });

        outcomes.push({ ref: candidate.ref, outcome });
        done += 1;
        setProgress(this.recueil, handle.id, done);
      });
    } finally {
      await scratch.dispose();
    }

    const counts = tally(outcomes.map((entry) => entry.outcome));
    const scratchClean = await scratch.isEmpty();
    const verification = this.verifyRun(
      handle.id,
      counts,
      touchedDocumentIds,
      outcomes.map((entry) => entry.outcome),
    );
    const finishedAt = nowTimestamp();

    // `waiting_review` rather than `succeeded` when something was queued: IK6 says a job in that
    // state "has produced review_queue entries and will not proceed until they are resolved", and
    // reporting a run that filed nothing as a success is how a review queue gets ignored.
    //
    // Derived from `review_queue` and not from `counts.review`, which is the number of *candidates*
    // whose outcome was `review`. Those are not the only entries a run raises: `commitProposal`
    // raises one inside the commit transaction when a rule asked for something the library could
    // not do, `ingestWithRetries` raises a blocker after the last attempt, stage 5 raises one when
    // OCR throws, and stage 3 raises one for an archive it could not open. None of those changes a
    // candidate's outcome, so a run counting outcomes reported itself `succeeded` while holding
    // open rows against its own job id — the exact failure the paragraph above says it prevents.
    const openEntries = verification.queried.openReviewEntries;
    const blockers = verification.queried.blockerReviewEntries;
    finishRun(
      this.recueil,
      handle.id,
      counts.failed > 0
        ? {
            state: 'failed',
            errorCode: 'ingest_candidate_failed',
            errorMessage:
              `${String(counts.failed)} candidate(s) failed after ${String(
                this.config.maxAttemptsPerCandidate,
              )} attempts each` +
              (openEntries === 0
                ? ''
                : `; ${String(openEntries)} review_queue entry(ies) are open against this run, ` +
                  `${String(blockers)} of them blocker(s)`),
          }
        : openEntries > 0
          ? { state: 'waiting_review', result: { counts, verification } }
          : { state: 'succeeded', result: { counts, verification } },
    );

    this.events.emit({
      type: 'ingest.run_finished',
      runId: handle.id,
      ingested: counts.ingested,
      duplicates: counts.duplicates,
      review: counts.review,
      failed: counts.failed,
      occurredAt: finishedAt,
    });

    return {
      runId: handle.id,
      idempotencyKey,
      resumed: handle.resumed,
      startedAt,
      finishedAt,
      counts,
      outcomes,
      verification,
      scratchClean,
    };
  }

  /** One candidate, outside any run. The shape the connector and a single upload want. */
  async ingestOne(candidate: IngestCandidate, options: { runLabel?: string } = {}): Promise<IngestOutcome> {
    const report = await this.run([candidate], {
      runLabel: options.runLabel ?? `single-${candidateKey(candidate.ref)}`,
      sourceId: candidate.ref.sourceId,
    });
    return report.outcomes[0]?.outcome ?? { status: 'failed', code: 'no_outcome', message: 'the run produced no outcome' };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Retries                                                                                    */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * `spec/hooks.md` §6.5: "Three consecutive throws for the same document route it to the review
   * queue with the error as the reason rather than retrying for ever."
   */
  private async ingestWithRetries(
    candidate: IngestCandidate,
    context: CandidateContext,
  ): Promise<IngestOutcome> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.config.maxAttemptsPerCandidate; attempt += 1) {
      if (context.signal.aborted) throw new IngestCancelledError();
      try {
        return await this.ingestCandidate(candidate, { ...context, attempt });
      } catch (error) {
        if (error instanceof IngestCancelledError) throw error;
        lastError = error;
        logRun(this.recueil, context.runId, {
          level: attempt === this.config.maxAttemptsPerCandidate ? 'error' : 'warn',
          message: `attempt ${attempt} failed: ${message(error)}`,
          subjectType: 'ingest_candidate',
          subjectId: candidate.ref.externalId,
        });
      }
    }

    const code = lastError instanceof IngestError ? lastError.code : 'ingest_failed';
    const checkpoint = context.journal.read<Stage2Checkpoint>('duplicate_check');
    const subject: { type: ReviewSubjectType; id: string } =
      checkpoint === null
        ? { type: 'ingest_batch', id: context.journal.key }
        : { type: 'document', id: checkpoint.documentId };

    const entry = this.reviewQueue.raise({
      subjectType: subject.type,
      subjectId: subject.id,
      reasonCode: code === 'ingest_failed' ? INGEST_REASON_CODES.stageFailed : code,
      explanation:
        `Ingestion of '${candidate.ref.externalId}' failed ${this.config.maxAttemptsPerCandidate} ` +
        `times in a row. The last error was: ${message(lastError)}`,
      proposedAction: 'retry',
      proposedPayload: { ref: candidate.ref as unknown as JsonObject } as never,
      severity: 'blocker',
      sourceStage: 'ingest',
      jobId: context.runId,
      actor: this.actor,
    });

    logRun(this.recueil, context.runId, {
      level: 'error',
      message: `gave up and queued for review as ${entry.id}`,
      data: { reasonCode: entry.reasonCode },
      subjectType: subject.type,
      subjectId: subject.id,
    });

    this.events.emit({
      type: 'ingest.candidate_failed',
      ref: candidate.ref,
      code,
      message: message(lastError),
      attempt: this.config.maxAttemptsPerCandidate,
      occurredAt: nowTimestamp(),
    });

    const outcome: IngestOutcome = { status: 'failed', code, message: message(lastError) };
    // Recorded under `failed` and deliberately **not** under `commit`: a terminal checkpoint is what
    // makes a resumed run skip a candidate, and a candidate that failed is exactly the one a resumed
    // run has to try again. The stage checkpoints it did reach are left in place, so the retry
    // starts from the first stage that never finished rather than from the beginning.
    context.journal.write('failed', outcome, checkpoint?.sha256 ?? null);
    return outcome;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* The ten stages                                                                             */
  /* ---------------------------------------------------------------------------------------- */

  private async ingestCandidate(
    candidate: IngestCandidate,
    context: CandidateContext,
  ): Promise<IngestOutcome> {
    const { journal } = context;

    // A candidate with a terminal checkpoint finished in an earlier attempt of this run. Returning
    // its outcome rather than replaying it is what makes an archive's members resumable too: the
    // run's `completed` map only covers the top level, and a member is reached through its parent.
    const alreadyCommitted = journal.read<IngestOutcome>('commit');
    if (alreadyCommitted !== null) return alreadyCommitted;

    let bytes: Buffer | null = null;
    const readBytes = async (): Promise<Buffer> => {
      bytes ??= await candidate.read();
      return bytes;
    };

    /* ---- Stage 1: hash, size, MIME ------------------------------------------------------- */

    const hashed = await this.hashCandidate(candidate, context, readBytes);

    /* ---- The digest gate ------------------------------------------------------------------ */

    // Stage 2 asks whether these bytes are already filed and stage 10 files them, and between the
    // two lies every awaited stage in the pipeline — OCR, GROBID, a resolver, a plugin. Without
    // this lease, N concurrent arrivals of the same bytes each read "not filed" and each commit,
    // and one document acquires N items and N live attachments. The lease is taken here, the
    // moment the digest is known, and released when the candidate reaches a terminal outcome, so
    // the check and the commit are inside one critical section.
    //
    // Serialising costs nothing that is not already wasted: candidates that contend carry
    // *identical bytes*, so the one that waits is going to be told it is a duplicate and stop.
    const lease = context.heldDigests.has(hashed.sha256)
      ? null
      : await this.leaseDigest(hashed.sha256, context);
    try {
      return await this.ingestHashedCandidate(candidate, context, hashed, readBytes);
    } finally {
      lease?.release();
    }
  }

  /** Stage 1, and the checkpoint that lets a resumed run skip it. */
  private async hashCandidate(
    candidate: IngestCandidate,
    context: CandidateContext,
    readBytes: () => Promise<Buffer>,
  ): Promise<HashedCandidate> {
    const checkpoint = context.journal.read<HashedCandidate>('hash');
    if (checkpoint !== null) return checkpoint;

    const buffer = await readBytes();
    // Hash only. Storing happens at stage 2, through `DocumentService.ingestBuffer`, because a
    // blob written here for an archive whose container the deployment does not keep would be an
    // orphan that nothing ever references and nothing ever collects.
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const byteSize = buffer.length;
    const mediaType = sniffMimeType(buffer, {
      declared: candidate.mediaType ?? null,
      filename: candidate.suggestedFilename ?? null,
    }).mimeType;
    const hashed: HashedCandidate = {
      sha256,
      byteSize,
      mediaType,
      archive: archiveKind(mediaType, buffer),
    };
    context.journal.write('hash', hashed, sha256);
    return hashed;
  }

  /** Take the gate on a digest, recording it on this line of descent so nesting cannot self-block. */
  private async leaseDigest(sha256: Sha256, context: CandidateContext): Promise<DigestLease> {
    const lease = await this.digestGate.acquire(sha256, this.digestLockTimeoutMs);
    context.heldDigests.add(sha256);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        context.heldDigests.delete(sha256);
        lease.release();
      },
    };
  }

  /** Stages 2 to 10, with the digest gate held for the whole of them. */
  private async ingestHashedCandidate(
    candidate: IngestCandidate,
    context: CandidateContext,
    hashed: HashedCandidate,
    readBytes: () => Promise<Buffer>,
  ): Promise<IngestOutcome> {
    const { journal } = context;

    const previousStages: string[] = [];
    const notes: string[] = [];
    const ledger = new ConfidenceLedger(this.config.baseConfidence);
    const proposal = emptyProposal();
    const sourceMetadata: JsonObject = { ...(candidate.sourceMetadata ?? {}) };

    let sha256: Sha256 = hashed.sha256;
    let byteSize: number = hashed.byteSize;
    let mediaType: string = hashed.mediaType;
    const kind: 'zip' | 'eml' | null = hashed.archive;

    previousStages.push('hash');

    await this.runHooks('hash', 'after', {
      candidate,
      context,
      documentId: '',
      sha256,
      mediaType,
      byteSize,
      readBytes,
      text: null,
      proposal,
      previousStages,
      ledger,
      notes,
    });

    /* ---- Stage 2: exact duplicate check --------------------------------------------------- */

    const archive: 'zip' | 'eml' | null =
      kind !== null && context.depth < this.config.maxArchiveDepth ? kind : null;

    // An archive whose container the deployment does not keep never gets a `documents` row, so
    // stage 2 is a question about its members rather than about it. Everything else goes through
    // the check now, because the answer decides whether the rest of the pipeline runs at all.
    let stage2 = journal.read<Stage2Checkpoint>('duplicate_check');
    if (stage2 === null && !(archive !== null && !this.containerStored(archive))) {
      const buffer = await readBytes();
      const ingested = await this.recueil.documents.ingestBuffer(buffer, {
        sourceKind: candidate.sourceKind,
        sourceRef: candidate.ref.externalId,
        sourceDetail: this.sourceDetail(candidate, context),
        originalFilename: candidate.suggestedFilename ?? null,
        declaredMimeType: candidate.mediaType ?? null,
        observedAt: candidate.observedAt ?? nowTimestamp(),
        jobId: context.runId,
        actor: this.actor,
      });

      const filed = this.hasLiveAttachment(ingested.document.id);
      stage2 = {
        documentId: ingested.document.id,
        sha256: ingested.document.sha256,
        byteSize: ingested.document.byteSize,
        mediaType: ingested.document.mimeType,
        created: ingested.created,
        alreadyFiled: filed,
      };
      journal.write('duplicate_check', stage2, stage2.sha256);

      if (context.parent?.documentId != null) {
        recordDocumentFacts(
          this.recueil,
          stage2.documentId,
          { parentDocumentId: context.parent.documentId },
          this.actor,
        );
      }

      if (ingested.created) {
        this.events.emit({
          type: 'document.ingested',
          documentId: stage2.documentId,
          sha256: stage2.sha256,
          mediaType: stage2.mediaType,
          byteSize: stage2.byteSize,
          detectedType: 'unknown',
          parentDocumentId: context.parent?.documentId ?? null,
          ref: candidate.ref,
          occurredAt: nowTimestamp(),
        });
      } else {
        this.events.emit({
          type: 'document.duplicate',
          documentId: stage2.documentId,
          sha256: stage2.sha256,
          ref: candidate.ref,
          arrivals: this.recueil.documents.provenanceFor(stage2.documentId).length,
          occurredAt: nowTimestamp(),
        });
      }
    }

    if (stage2 !== null) {
      context.touchedDocumentIds.add(stage2.documentId);
      mediaType = stage2.mediaType;
      byteSize = stage2.byteSize;
      sha256 = stage2.sha256;
    }
    previousStages.push('duplicate_check');

    // "Link to existing, log, stop." The bytes are known and already filed: the arrival has been
    // recorded and there is nothing further to decide.
    //
    // `alreadyFiled` is re-queried rather than read from the checkpoint, deliberately. A run that
    // committed the item and then died before writing its terminal checkpoint would otherwise
    // resume from a stale `false` and file the same document a second time — which is exactly the
    // shape of bug the checkpoint exists to prevent.
    const alreadyFiled = stage2 === null ? false : this.hasLiveAttachment(stage2.documentId);
    if (stage2 !== null && alreadyFiled) {
      logRun(this.recueil, context.runId, {
        level: 'info',
        message: 'these bytes were already in the library and already filed; linked and stopped',
        subjectType: 'document',
        subjectId: stage2.documentId,
      });
      const outcome: IngestOutcome = {
        status: 'duplicate',
        documentId: stage2.documentId,
        sha256: stage2.sha256,
        ...(this.itemIdFor(stage2.documentId) === null
          ? {}
          : { itemId: this.itemIdFor(stage2.documentId) as string }),
      };
      journal.write('commit', outcome, sha256);
      journal.compact();
      return outcome;
    }

    /* ---- Stage 3: archive extraction ------------------------------------------------------ */

    const memberOutcomes: IngestOutcome[] = [];
    let containerBody: string | null = null;

    if (archive !== null) {
      const expansion = journal.has('archive_extraction')
        ? journal.read<{ members: IngestOutcome[]; bodyText: string | null }>('archive_extraction')
        : null;

      if (expansion !== null) {
        memberOutcomes.push(...expansion.members);
        containerBody = expansion.bodyText;
        if (containerBody !== null && containerBody.trim().length > 0) proposal.notes.push(containerBody);
      } else {
        const result = await this.expandArchive(candidate, context, {
          kind: archive,
          sha256,
          byteSize,
          mediaType,
          readBytes,
          containerDocumentId: stage2?.documentId ?? null,
          previousStages,
          ledger,
          proposal,
          sourceMetadata,
          notes,
        });
        if (result.kind === 'stop') return result.outcome;
        memberOutcomes.push(...result.members);
        containerBody = result.bodyText;
        // Checkpointed only when every member reached a terminal state. A checkpointed expansion
        // is never re-expanded, so recording one that contains a failed member would make that
        // member unreachable on resume.
        if (!result.members.some((member) => member.status === 'failed')) {
          journal.write(
            'archive_extraction',
            { members: result.members, bodyText: result.bodyText, envelope: sourceMetadata },
            sha256,
          );
        }
      }
    }
    previousStages.push('archive_extraction');

    if (stage2 === null) {
      // Only reachable when an archive's container is not stored and the expansion returned null,
      // which it never does. Defensive, and honest about being so.
      throw new IngestError(
        'the pipeline reached stage 4 with no document row, which should be impossible',
        'invariant_violated',
      );
    }
    const documentId = stage2.documentId;

    /* ---- Stage 4: type detection ---------------------------------------------------------- */

    let text: string | null = journal.read<{ text: string | null }>('ocr')?.text ?? null;
    const stage4 =
      journal.read<{
        type: DetectedType;
        confidence: number;
        signals: string[];
        hasTextLayer: boolean | null;
        pageCount: number | null;
        text: string | null;
      }>('type_detection');

    let detected: DetectedType;
    let hasTextLayer: boolean | null;
    let pageCount: number | null;

    if (stage4 !== null) {
      detected = stage4.type;
      hasTextLayer = stage4.hasTextLayer;
      pageCount = stage4.pageCount;
      text ??= stage4.text;
      ledger.add({
        stage: 'type_detection',
        source: 'detector',
        delta: (stage4.confidence - 0.5) * CONFIDENCE_WEIGHTS.detection,
        reason: `it looks like a ${stage4.type.replace(/_/gu, ' ')}`,
      });
    } else {
      const buffer = await readBytes();
      let probeText: string | null = null;
      hasTextLayer = null;
      pageCount = null;

      if (mediaType === 'application/pdf') {
        const probe = extractPdfText(buffer);
        probeText = probe.text.length === 0 ? null : probe.text;
        hasTextLayer = probe.text.length >= this.config.textLayerMinChars;
        pageCount = probe.pageCount;
      } else if (mediaType.startsWith('text/')) {
        probeText = buffer.toString('utf8');
        hasTextLayer = probeText.trim().length >= this.config.textLayerMinChars;
      }

      if (probeText === null && containerBody !== null) {
        // A message's text is its body: that is what the office heuristics read and what a person
        // searches for.
        probeText = containerBody;
        hasTextLayer = containerBody.trim().length >= this.config.textLayerMinChars;
      }

      const result = detectType({
        mediaType,
        byteSize,
        text: probeText,
        hasTextLayer,
        pageCount,
        archive,
        fromArchive: context.parent !== null,
      });
      detected = result.type;
      text = probeText;
      journal.write(
        'type_detection',
        { type: detected, confidence: result.confidence, signals: result.signals, hasTextLayer, pageCount, text },
        sha256,
      );
      notes.push(...result.signals);
      ledger.add({
        stage: 'type_detection',
        source: 'detector',
        delta: (result.confidence - 0.5) * CONFIDENCE_WEIGHTS.detection,
        reason: `it looks like a ${result.type.replace(/_/gu, ' ')}`,
      });
    }
    previousStages.push('type_detection');

    const afterDetection = await this.runHooks('type_detection', 'after', {
      candidate,
      context,
      documentId,
      sha256,
      mediaType,
      byteSize,
      readBytes,
      text,
      proposal,
      previousStages,
      ledger,
      notes,
    });
    if (afterDetection !== null) return this.finishEarly(afterDetection, documentId, sha256, context, ledger);

    /* ---- Stage 5: OCR --------------------------------------------------------------------- */

    let ocrStatus: (typeof schema.OCR_STATUSES)[number] = 'not_applicable';
    const stage5 = journal.read<{ text: string | null; status: typeof ocrStatus; confidence: number }>('ocr');

    if (stage5 !== null) {
      ocrStatus = stage5.status;
      if (stage5.text !== null && stage5.text.length > 0) text = stage5.text;
      if (stage5.confidence > 0) {
        ledger.add({
          stage: 'ocr',
          source: this.ocr.id,
          delta: stage5.confidence * CONFIDENCE_WEIGHTS.ocr,
          reason: 'OCR recovered text from a page with no text layer',
        });
      }
    } else if (this.needsOcr(detected, hasTextLayer, text)) {
      if (!this.config.ocrEnabled || !this.ocr.supports(mediaType)) {
        ocrStatus = 'skipped';
        notes.push(
          this.config.ocrEnabled
            ? `no OCR engine handles ${mediaType}`
            : 'OCR is disabled in this deployment',
        );
        journal.write('ocr', { text: null, status: ocrStatus, confidence: 0 }, sha256);
      } else {
        try {
          const result = await this.ocr.recognise({
            bytes: await readBytes(),
            mediaType,
            sha256,
            pageCount,
            signal: context.signal,
          });
          if (result.text.trim().length === 0) {
            ocrStatus = 'failed';
            notes.push('OCR ran and recognised nothing');
          } else {
            ocrStatus = 'done';
            text = result.text;
            ledger.add({
              stage: 'ocr',
              source: result.engine,
              delta: result.confidence * CONFIDENCE_WEIGHTS.ocr,
              reason: 'OCR recovered text from a page with no text layer',
            });
          }
          notes.push(...(result.warnings ?? []));
          journal.write(
            'ocr',
            { text: ocrStatus === 'done' ? text : null, status: ocrStatus, confidence: result.confidence },
            sha256,
          );
        } catch (error) {
          ocrStatus = 'failed';
          notes.push(`OCR failed: ${message(error)}`);
          journal.write('ocr', { text: null, status: ocrStatus, confidence: 0 }, sha256);
          this.reviewQueue.raise({
            subjectType: 'document',
            subjectId: documentId,
            reasonCode: INGEST_REASON_CODES.ocrFailed,
            explanation: `The OCR engine '${this.ocr.id}' failed on this document: ${message(error)}`,
            proposedAction: 'retry',
            confidence: null,
            severity: 'warning',
            sourceStage: stageLabel('ocr'),
            jobId: context.runId,
            actor: this.actor,
          });
        }
      }
    } else if (hasTextLayer === true) {
      ocrStatus = 'not_needed';
    }
    previousStages.push('ocr');

    // The text belongs to the document whether or not an item is ever created from it, so it is
    // indexed here rather than at the commit: a scan that lands in the review queue must still be
    // findable, or the queue becomes a place documents go to disappear.
    if (text !== null && text.length > 0) {
      this.recueil.search.indexDocumentText(documentId, text);
    }

    recordDocumentFacts(
      this.recueil,
      documentId,
      {
        ...(hasTextLayer === null ? {} : { hasTextLayer }),
        ...(text === null ? {} : { textCharCount: text.length, textExtracted: true }),
        ...(pageCount === null ? {} : { pageCount }),
        ocrStatus,
        simhash: text === null ? null : simhash(text),
      },
      this.actor,
    );

    const afterOcr = await this.runHooks('ocr', 'after', {
      candidate,
      context,
      documentId,
      sha256,
      mediaType,
      byteSize,
      readBytes,
      text,
      proposal,
      previousStages,
      ledger,
      notes,
    });
    if (afterOcr !== null) return this.finishEarly(afterOcr, documentId, sha256, context, ledger);

    /* ---- Stage 6: metadata extraction ----------------------------------------------------- */

    const stage6 = journal.read<{ results: ExtractedMetadata[] }>('metadata_extraction');
    let extracted: ExtractedMetadata[];

    if (stage6 !== null) {
      extracted = stage6.results;
    } else {
      extracted = [];
      for (const extractor of this.extractors) {
        if (!extractor.supports(detected, mediaType)) continue;
        const result = await extractor.extract({
          bytes: await readBytes(),
          mediaType,
          sha256,
          detectedType: detected,
          text,
          filename: candidate.suggestedFilename ?? null,
          sourceMetadata,
          signal: context.signal,
        });
        extracted.push(result);
        notes.push(...(result.warnings ?? []));
      }
      journal.write('metadata_extraction', { results: extracted }, sha256);
    }

    for (const result of extracted) {
      applyMetadata(proposal, result);
      ledger.add({
        stage: 'metadata_extraction',
        source: result.extractor,
        delta: result.confidence * CONFIDENCE_WEIGHTS.metadata,
        reason:
          result.confidence === 0
            ? `${result.extractor} found nothing`
            : `${result.extractor} read ${String(Object.keys(result.fields).length)} field(s)`,
      });
    }
    previousStages.push('metadata_extraction');

    const afterMetadata = await this.runHooks('metadata_extraction', 'after', {
      candidate,
      context,
      documentId,
      sha256,
      mediaType,
      byteSize,
      readBytes,
      text,
      proposal,
      previousStages,
      ledger,
      notes,
    });
    if (afterMetadata !== null) return this.finishEarly(afterMetadata, documentId, sha256, context, ledger);

    /* ---- Stage 7: identifier resolution --------------------------------------------------- */

    const stage7 = journal.read<{ identifiers: Identifier[]; records: ResolutionRecord[] }>('resolution');
    let identifiers: Identifier[];
    let records: ResolutionRecord[];

    if (stage7 !== null) {
      identifiers = stage7.identifiers;
      records = stage7.records;
    } else {
      identifiers = dedupeIdentifiers([
        ...extracted.flatMap((result) => result.identifiers),
        // The document's own identifiers live on its first page; a reference list is full of other
        // people's, so the scan is bounded rather than run over the whole text.
        ...(text === null ? [] : extractIdentifiers(text, { limit: 4_000 })),
      ]);
      records = [];
      if (identifiers.length > 0) {
        for (const resolver of this.resolvers) {
          const usable = identifiers.filter((identifier) => resolver.supports.includes(identifier.scheme));
          if (usable.length === 0) continue;
          records.push(...(await resolver.lookup({ identifiers: usable, signal: context.signal })));
        }
      }
      journal.write('resolution', { identifiers, records }, sha256);
    }

    for (const identifier of identifiers) {
      const path = biblioPathFor(identifier.scheme);
      if (path === null || proposal.fields[path] !== undefined) continue;
      proposal.fields[path] = {
        value: identifier.value,
        provenance: { source: 'ingest.identifiers', fetchedAt: nowTimestamp(), confidence: 0.5 },
      };
    }
    for (const record of records) {
      applyResolution(proposal, record);
      ledger.add({
        stage: 'resolution',
        source: record.source,
        delta: record.score * CONFIDENCE_WEIGHTS.resolution,
        reason: `${record.source} confirmed the record`,
      });
    }
    if (identifiers.length === 0 && detected === 'scholarly_pdf') {
      ledger.add({
        stage: 'resolution',
        source: 'ingest.identifiers',
        delta: -0.15,
        reason: 'it looks like a paper but carries no identifier',
      });
    }
    previousStages.push('resolution');

    const afterResolution = await this.runHooks('resolution', 'after', {
      candidate,
      context,
      documentId,
      sha256,
      mediaType,
      byteSize,
      readBytes,
      text,
      proposal,
      previousStages,
      ledger,
      notes,
    });
    if (afterResolution !== null) {
      return this.finishEarly(afterResolution, documentId, sha256, context, ledger);
    }

    /* ---- Stage 8: rule engine ------------------------------------------------------------- */

    const evaluation = this.rules.evaluate({
      sourceKind: candidate.sourceKind,
      sourceId: candidate.ref.sourceId,
      path: candidate.ref.externalId,
      filename: candidate.suggestedFilename ?? null,
      mediaType,
      detectedType: detected,
      text,
      identifiers,
      resolvedBy: records.map((record) => record.source),
      sourceMetadata,
      confidence: ledger.score,
    });

    if (evaluation.itemType !== null) proposal.itemType = evaluation.itemType;
    for (const tag of evaluation.addTags) if (!proposal.tags.includes(tag)) proposal.tags.push(tag);
    for (const collectionId of evaluation.addCollectionIds) {
      if (!proposal.collectionIds.includes(collectionId)) proposal.collectionIds.push(collectionId);
    }
    for (const [path, entry] of Object.entries(evaluation.setFields)) {
      proposal.fields[path] = {
        value: entry.value,
        provenance: { source: `rule:${entry.ruleId}`, fetchedAt: nowTimestamp(), confidence: 0.8 },
      };
    }
    for (const [key, entry] of Object.entries(evaluation.setCustomFields)) {
      proposal.customFields[key] = entry.value;
    }
    if (evaluation.confidenceDelta !== 0) {
      ledger.add({
        stage: 'rules',
        source: evaluation.matched.join(', '),
        delta: evaluation.confidenceDelta,
        reason: `rule(s) ${evaluation.matched.join(', ')} adjusted the score`,
      });
    }
    if (evaluation.matched.length > 0) notes.push(`rules matched: ${evaluation.matched.join(', ')}`);
    previousStages.push('rules');
    journal.write('rules', { matched: evaluation.matched, conflicts: evaluation.conflicts }, sha256);

    if (evaluation.stop !== null) {
      const outcome: IngestOutcome = {
        status: 'stopped',
        reasonCode: evaluation.stop.action.reasonCode,
        explanation: evaluation.stop.action.explanation,
        documentId,
        sha256,
      };
      journal.write('commit', outcome, sha256);
      journal.compact();
      return outcome;
    }

    const afterRules = await this.runHooks('rules', 'after', {
      candidate,
      context,
      documentId,
      sha256,
      mediaType,
      byteSize,
      readBytes,
      text,
      proposal,
      previousStages,
      ledger,
      notes,
    });
    if (afterRules !== null) return this.finishEarly(afterRules, documentId, sha256, context, ledger);

    /* ---- Stage 9: the confidence gate ----------------------------------------------------- */

    proposal.confidence = ledger.score;
    previousStages.push('confidence_gate');

    const forcedReview =
      evaluation.review !== null
        ? {
            reasonCode: evaluation.review.action.reasonCode,
            explanation: evaluation.review.action.explanation,
          }
        : evaluation.conflicts.length > 0
          ? {
              reasonCode: INGEST_REASON_CODES.ruleConflict,
              explanation:
                'Two or more rules disagreed about ' +
                evaluation.conflicts
                  .map(
                    (conflict) =>
                      `${conflict.field} (${conflict.candidates
                        .map((entry) => `${entry.ruleId} wants ${JSON.stringify(entry.value)}`)
                        .join(', ')})`,
                  )
                  .join('; ') +
                '. Nothing was applied unseen.',
            }
          : null;

    if (forcedReview !== null || ledger.score < this.config.confidenceThreshold) {
      const reason = forcedReview ?? {
        reasonCode:
          identifiers.length === 0 && detected === 'scholarly_pdf'
            ? INGEST_REASON_CODES.noIdentifierMatch
            : INGEST_REASON_CODES.lowConfidence,
        explanation:
          `The pipeline was not confident enough to file this document on its own: ` +
          `${ledger.explain()}. The threshold is ${this.config.confidenceThreshold.toFixed(2)}.`,
      };

      const entry = this.reviewQueue.raise({
        subjectType: 'document',
        subjectId: documentId,
        reasonCode: reason.reasonCode,
        explanation: reason.explanation,
        proposedAction: 'create_item',
        proposedPayload: proposalPayload(proposal),
        confidence: ledger.score,
        severity: 'warning',
        sourceStage: stageLabel('confidence_gate'),
        jobId: context.runId,
        actor: this.actor,
      });

      logRun(this.recueil, context.runId, {
        level: 'info',
        message: `routed to review: ${reason.reasonCode}`,
        data: { confidence: ledger.score, contributions: ledger.contributions as never },
        subjectType: 'document',
        subjectId: documentId,
      });

      this.events.emit({
        type: 'ingest.review_queued',
        reviewQueueEntryId: entry.id,
        documentId,
        reasonCode: reason.reasonCode,
        confidence: ledger.score,
        occurredAt: nowTimestamp(),
      });

      const outcome: IngestOutcome = {
        status: 'review',
        reviewQueueEntryId: entry.id,
        documentId,
        sha256,
        reasonCode: reason.reasonCode,
        ...(memberOutcomes.length === 0 ? {} : { members: memberOutcomes }),
      };
      journal.write('commit', outcome, sha256);
      journal.compact();
      return outcome;
    }

    /* ---- Stage 10: the commit ------------------------------------------------------------- */

    const beforeCommit = await this.runHooks('commit', 'before', {
      candidate,
      context,
      documentId,
      sha256,
      mediaType,
      byteSize,
      readBytes,
      text,
      proposal,
      previousStages,
      ledger,
      notes,
    });
    if (beforeCommit !== null) return this.finishEarly(beforeCommit, documentId, sha256, context, ledger);
    proposal.confidence = ledger.score;

    let committed: CommitResult;
    try {
      committed = commitProposal({
        recueil: this.recueil,
        reviewQueue: this.reviewQueue,
        actor: this.actor,
        documentId,
        sha256,
        proposal,
        attachmentRole: detected === 'scan' ? 'scan' : 'primary',
        provenanceSource: 'ingest',
        runId: context.runId,
        sourceStage: stageLabel('commit'),
        // The digest gate above cannot see another process. This can: the check is inside the
        // commit's own transaction, so the answer and the write are atomic.
        refuseIfDocumentFiled: true,
      });
    } catch (error) {
      if (!(error instanceof DocumentAlreadyFiledError)) throw error;
      // Somebody else filed these bytes between stage 2 and here — which, within one process, the
      // gate makes impossible, so this is the second-process path. The right answer is the one
      // stage 2 would have given a moment later, not a failure.
      logRun(this.recueil, context.runId, {
        level: 'info',
        message:
          'another writer filed these bytes while this candidate was in the pipeline; linked and ' +
          'stopped rather than filing them twice',
        subjectType: 'document',
        subjectId: documentId,
      });
      this.events.emit({
        type: 'document.duplicate',
        documentId,
        sha256,
        ref: candidate.ref,
        arrivals: this.recueil.documents.provenanceFor(documentId).length,
        occurredAt: nowTimestamp(),
      });
      const raced: IngestOutcome = {
        status: 'duplicate',
        documentId,
        sha256,
        itemId: error.itemId,
      };
      journal.write('commit', raced, sha256);
      journal.compact();
      return raced;
    }

    // Everything the run learned that made this document filable also answers any open question
    // about it from an earlier attempt (RQ2).
    this.supersedeOpenEntries(documentId, committed.itemId);

    logRun(this.recueil, context.runId, {
      level: 'info',
      message: `filed as ${committed.itemType} with confidence ${ledger.score.toFixed(2)}`,
      data: { itemId: committed.itemId, notes },
      subjectType: 'document',
      subjectId: documentId,
    });

    this.events.emit({
      type: 'item.created',
      itemId: committed.itemId,
      itemType: committed.itemType,
      documentId,
      attachmentId: committed.attachmentId,
      confidence: ledger.score,
      occurredAt: nowTimestamp(),
    });

    const outcome: IngestOutcome = {
      status: 'ingested',
      documentId,
      itemId: committed.itemId,
      sha256,
      confidence: ledger.score,
      ...(memberOutcomes.length === 0 ? {} : { members: memberOutcomes }),
    };
    journal.write('commit', outcome, sha256);
    journal.compact();
    return outcome;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Stage 3, in full                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  private async expandArchive(
    candidate: IngestCandidate,
    context: CandidateContext,
    input: {
      kind: 'zip' | 'eml';
      sha256: Sha256;
      byteSize: number;
      mediaType: string;
      readBytes: () => Promise<Buffer>;
      containerDocumentId: string | null;
      previousStages: string[];
      ledger: ConfidenceLedger;
      proposal: ItemProposal;
      sourceMetadata: JsonObject;
      notes: string[];
    },
  ): Promise<
    { kind: 'stop'; outcome: IngestOutcome } | { kind: 'continue'; members: IngestOutcome[]; bodyText: string | null }
  > {
    const { journal } = context;
    const archiveBytes = await input.readBytes();

    interface Expanded {
      members: ExtractedMember[];
      memberBuffers: Buffer[];
      envelope: JsonObject | null;
      bodyText: string | null;
    }
    let expanded: Expanded;

    try {
      expanded = await context.scratch.with(
        `archive-${input.sha256.slice(0, 12)}-`,
        async (space): Promise<Expanded> => {
          const extraction = await extractArchive({
            bytes: archiveBytes,
            kind: input.kind,
            scratch: space,
            config: this.config,
          });
          for (const entry of extraction.skipped) {
            input.notes.push(`archive member '${entry.entryName}' was skipped: ${entry.reason}`);
          }
          // The bytes are read inside the scratch scope, because the scratch directory is deleted
          // the moment this callback returns. CONCEPT §5.3: scratch is cleaned after hashing.
          return {
            members: extraction.members,
            memberBuffers: await Promise.all(
              extraction.members.map(async (member) => readFile(member.absolutePath)),
            ),
            envelope: extraction.email === null ? null : emailMetadata(extraction.email),
            bodyText:
              extraction.email === null
                ? null
                : (extraction.email.bodyText ?? extraction.email.bodyHtml),
          };
        },
      );
    } catch (error) {
      // An archive the reader could not open is kept whatever the container policy says, so that
      // the operator still has the file the review entry is about.
      const container = await this.ensureContainerDocument(candidate, context, input.readBytes);
      const reasonCode = error instanceof IngestError ? error.code : INGEST_REASON_CODES.archiveUnreadable;
      const entry = this.reviewQueue.raise({
        subjectType: 'document',
        subjectId: container.documentId,
        reasonCode,
        explanation:
          `This ${input.kind === 'zip' ? 'archive' : 'message'} could not be expanded: ` +
          `${message(error)} The file itself has been kept.`,
        proposedAction: 'retry',
        severity: 'warning',
        sourceStage: stageLabel('archive_extraction'),
        jobId: context.runId,
        actor: this.actor,
      });
      this.events.emit({
        type: 'ingest.review_queued',
        reviewQueueEntryId: entry.id,
        documentId: container.documentId,
        reasonCode,
        confidence: null,
        occurredAt: nowTimestamp(),
      });
      const outcome: IngestOutcome = {
        status: 'review',
        reviewQueueEntryId: entry.id,
        documentId: container.documentId,
        sha256: container.sha256,
        reasonCode,
        members: [],
      };
      journal.write('commit', outcome, container.sha256);
      journal.compact();
      return { kind: 'stop', outcome };
    }

    const containerDocumentId =
      input.containerDocumentId ??
      (this.containerStored(input.kind)
        ? (await this.ensureContainerDocument(candidate, context, input.readBytes)).documentId
        : null);

    const { members, memberBuffers, envelope, bodyText } = expanded;

    logRun(this.recueil, context.runId, {
      level: 'info',
      message: `expanded a ${input.kind} into ${String(members.length)} member(s)`,
      subjectType: containerDocumentId === null ? 'ingest_candidate' : 'document',
      subjectId: containerDocumentId ?? candidate.ref.externalId,
    });

    const memberOutcomes: IngestOutcome[] = [];
    for (const [index, member] of members.entries()) {
      if (context.signal.aborted) throw new IngestCancelledError();
      const buffer = memberBuffers[index] as Buffer;
      const innerRef: IngestRef = {
        sourceId: candidate.ref.sourceId,
        externalId: `${candidate.ref.externalId}!/${member.relativePath}`,
        ...(candidate.ref.revision === undefined ? {} : { revision: candidate.ref.revision }),
      };
      const innerCandidate: IngestCandidate = {
        ref: innerRef,
        sourceKind: candidate.sourceKind,
        suggestedFilename: member.entryName.split('/').pop() ?? member.entryName,
        ...(member.declaredMediaType === null ? {} : { mediaType: member.declaredMediaType }),
        ...(candidate.observedAt === undefined ? {} : { observedAt: candidate.observedAt }),
        sourceMetadata: {
          ...(candidate.sourceMetadata ?? {}),
          ...(envelope ?? {}),
          archive: {
            kind: input.kind,
            sha256: input.sha256,
            entry: member.entryName,
            filename: candidate.suggestedFilename ?? null,
          },
        },
        read: async () => buffer,
      };

      memberOutcomes.push(
        await this.ingestWithRetries(innerCandidate, {
          ...context,
          journal: new CandidateJournal(this.recueil, context.runId, candidateKey(innerRef)),
          attempt: 1,
          depth: context.depth + 1,
          parent: {
            documentId: containerDocumentId,
            sha256: input.sha256,
            entryName: member.entryName,
          },
        }),
      );
    }

    // A message is content in its own right: its body becomes a Note and its envelope the office
    // facet, so it goes on through stages 4 to 10 rather than stopping here as a container.
    if (input.kind === 'eml' && containerDocumentId !== null) {
      if (bodyText !== null && bodyText.trim().length > 0) input.proposal.notes.push(bodyText);
      Object.assign(input.sourceMetadata, envelope ?? {});
      input.notes.push(`the message carried ${String(members.length)} attachment(s)`);
      return { kind: 'continue', members: memberOutcomes, bodyText };
    }

    const outcome: IngestOutcome = {
      status: 'container',
      documentId: containerDocumentId ?? '',
      sha256: input.sha256,
      members: memberOutcomes,
    };
    // A container is only *finished* when all of its members are. Checkpointing one whose member
    // failed would make a resumed run skip the container, and with it the member that still needs
    // retrying — the archive would be silently half-imported for ever.
    if (!memberOutcomes.some((member) => member.status === 'failed')) {
      journal.write('commit', outcome, input.sha256);
      journal.compact();
    }
    return { kind: 'stop', outcome };
  }

  private containerStored(kind: 'zip' | 'eml'): boolean {
    return this.storeContainers[kind];
  }

  private async ensureContainerDocument(
    candidate: IngestCandidate,
    context: CandidateContext,
    readBytes: () => Promise<Buffer>,
  ): Promise<{ documentId: string; sha256: Sha256 }> {
    const existing = context.journal.read<Stage2Checkpoint>('duplicate_check');
    if (existing !== null) return { documentId: existing.documentId, sha256: existing.sha256 };

    const ingested = await this.recueil.documents.ingestBuffer(await readBytes(), {
      sourceKind: candidate.sourceKind,
      sourceRef: candidate.ref.externalId,
      sourceDetail: this.sourceDetail(candidate, context),
      originalFilename: candidate.suggestedFilename ?? null,
      declaredMimeType: candidate.mediaType ?? null,
      observedAt: candidate.observedAt ?? nowTimestamp(),
      jobId: context.runId,
      actor: this.actor,
    });
    context.touchedDocumentIds.add(ingested.document.id);
    const checkpoint: Stage2Checkpoint = {
      documentId: ingested.document.id,
      sha256: ingested.document.sha256,
      byteSize: ingested.document.byteSize,
      mediaType: ingested.document.mimeType,
      created: ingested.created,
      alreadyFiled: this.hasLiveAttachment(ingested.document.id),
    };
    context.journal.write('duplicate_check', checkpoint, checkpoint.sha256);
    return { documentId: checkpoint.documentId, sha256: checkpoint.sha256 };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Hooks                                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  private async runHooks(
    anchor: PipelineAnchor,
    position: StagePosition,
    input: {
      candidate: IngestCandidate;
      context: CandidateContext;
      documentId: string;
      sha256: Sha256;
      mediaType: string;
      byteSize: number;
      readBytes: () => Promise<Buffer>;
      text: string | null;
      proposal: ItemProposal;
      previousStages: string[];
      ledger: ConfidenceLedger;
      notes: string[];
    },
  ): Promise<{ action: 'review' | 'stop'; reasonCode: string; explanation: string } | null> {
    const stages = this.stages.at(anchor, position);
    if (stages.length === 0) return null;

    for (const stage of stages) {
      const hookInput: IngestStageInput = {
        documentId: input.documentId,
        sha256: input.sha256,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        bytes: input.readBytes,
        text: input.text,
        proposal: input.proposal,
        source: {
          kind: input.candidate.sourceKind,
          ref: input.candidate.ref,
          ...(input.candidate.sourceMetadata === undefined
            ? {}
            : { metadata: input.candidate.sourceMetadata }),
        },
        previousStages: [...input.previousStages],
      };

      const result = await stage.run(
        hookInput,
        hookContext(stage, {
          actor: this.actor,
          signal: input.context.signal,
          attempt: input.context.attempt,
          jobId: input.context.runId,
          dryRun: false,
          timeoutMs: 120_000,
          log: (level, text) =>
            logRun(this.recueil, input.context.runId, {
              level,
              message: `[${stage.id}] ${text}`,
              subjectType: 'document',
              subjectId: input.documentId,
            }),
        }),
      );

      if (result.action === 'continue') {
        if (result.patch !== undefined) applyPatch(input.proposal, result.patch);
        if (result.confidenceDelta !== undefined && result.confidenceDelta !== 0) {
          input.ledger.add({
            stage: 'plugin',
            source: stage.id,
            delta: Math.max(-1, Math.min(1, result.confidenceDelta)),
            reason: `the plugin stage '${stage.id}' adjusted the score`,
          });
        }
        input.notes.push(...(result.notes ?? []));
        continue;
      }
      return { action: result.action, reasonCode: result.reasonCode, explanation: result.explanation };
    }
    return null;
  }

  private finishEarly(
    decision: { action: 'review' | 'stop'; reasonCode: string; explanation: string },
    documentId: string,
    sha256: Sha256,
    context: CandidateContext,
    ledger: ConfidenceLedger,
  ): IngestOutcome {
    if (decision.action === 'stop') {
      const outcome: IngestOutcome = {
        status: 'stopped',
        reasonCode: decision.reasonCode,
        explanation: decision.explanation,
        documentId,
        sha256,
      };
      context.journal.write('commit', outcome, sha256);
      context.journal.compact();
      return outcome;
    }

    const entry = this.reviewQueue.raise({
      subjectType: 'document',
      subjectId: documentId,
      reasonCode: decision.reasonCode,
      explanation: decision.explanation,
      proposedAction: 'create_item',
      confidence: ledger.score,
      severity: 'warning',
      sourceStage: 'ingest.plugin',
      jobId: context.runId,
      actor: this.actor,
    });
    this.events.emit({
      type: 'ingest.review_queued',
      reviewQueueEntryId: entry.id,
      documentId,
      reasonCode: decision.reasonCode,
      confidence: ledger.score,
      occurredAt: nowTimestamp(),
    });
    const outcome: IngestOutcome = {
      status: 'review',
      reviewQueueEntryId: entry.id,
      documentId,
      sha256,
      reasonCode: decision.reasonCode,
    };
    context.journal.write('commit', outcome, sha256);
    context.journal.compact();
    return outcome;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Queries                                                                                    */
  /* ---------------------------------------------------------------------------------------- */

  private needsOcr(detected: DetectedType, hasTextLayer: boolean | null, text: string | null): boolean {
    if (detected === 'archive' || detected === 'email' || detected === 'text') return false;
    if (detected === 'image') return true;
    if (hasTextLayer === true) return false;
    return text === null || text.length < this.config.textLayerMinChars;
  }

  private hasLiveAttachment(documentId: string): boolean {
    const row = this.recueil.db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(and(eq(schema.attachments.documentId, documentId), isNull(schema.attachments.trashedAt)))
      .get();
    return row !== undefined;
  }

  private itemIdFor(documentId: string): string | null {
    const row = this.recueil.db
      .select({ itemId: schema.attachments.itemId })
      .from(schema.attachments)
      .where(and(eq(schema.attachments.documentId, documentId), isNull(schema.attachments.trashedAt)))
      .get();
    return row?.itemId ?? null;
  }

  private supersedeOpenEntries(documentId: string, itemId: string): void {
    const open = this.reviewQueue.openForSubject('document', documentId);
    if (open.length === 0) return;
    this.reviewQueue.supersede(
      open.map((entry) => entry.id),
      {
        actor: this.actor,
        note: `a later ingest filed this document as item ${itemId}, so the question is settled (RQ2)`,
      },
    );
  }

  /**
   * Check the run against the library (ADR-0021).
   *
   * Both sides are named in the type: every number in `queried` comes from a `SELECT` over the
   * library, every number in `claimed` comes from the run's in-memory tally, and each check
   * compares one against the other.
   *
   * The Phase 2 review found the previous version of this method satisfying that rule in form and
   * defeating it with comparison operators: all four checks were one-sided inequalities open in the
   * direction that permits duplication, so a run that gave one document four items reported
   * `pass: true` with `documentsWithoutAttachment: -3`. This version asserts equality wherever
   * equality is what is meant; the two checks that remain inequalities say below which direction is
   * the failure and why; and no number here is derived by subtraction, so none of them can be
   * negative.
   *
   * Public, and called by `run()` with its own numbers, because ADR-0021 §4 asks every blocking
   * check to ship with a test that makes it fail. A check whose only caller is the code it checks
   * cannot be handed a library that contradicts the run, and one that cannot be made to fail is
   * decoration. An operator re-deriving the verdict for a finished job wants the same seam.
   */
  verifyRun(
    runId: string,
    claimed: RunCounts,
    documentIds: ReadonlySet<string>,
    outcomes: readonly IngestOutcome[],
  ): IngestVerification {
    const ids = [...documentIds];

    // The run's own account of what it did, flattened through archive members. These are claims,
    // not evidence: each one is used to *address* a query, never as the answer to one.
    const claimedItemIds = new Set<string>();
    const claimedReviewEntryIds = new Set<string>();
    const walk = (outcome: IngestOutcome): void => {
      if (outcome.status === 'ingested') claimedItemIds.add(outcome.itemId);
      if (outcome.status === 'review') claimedReviewEntryIds.add(outcome.reviewQueueEntryId);
      if ('members' in outcome && outcome.members !== undefined) outcome.members.forEach(walk);
    };
    outcomes.forEach(walk);
    const itemIds = [...claimedItemIds];
    const reviewEntryIds = [...claimedReviewEntryIds];

    /* ---- The library side ----------------------------------------------------------------- */

    const arrivalsRecorded = count(
      this.recueil.db
        .select({
          n: sql<number>`count(distinct ${schema.documentProvenance.documentId} || char(31) || coalesce(${schema.documentProvenance.sourceRef}, ''))`,
        })
        .from(schema.documentProvenance)
        .where(eq(schema.documentProvenance.jobId, runId))
        .get(),
    );

    const documentsWithArrivals =
      ids.length === 0
        ? 0
        : count(
            this.recueil.db
              .select({ n: sql<number>`count(distinct ${schema.documentProvenance.documentId})` })
              .from(schema.documentProvenance)
              .where(
                and(
                  eq(schema.documentProvenance.jobId, runId),
                  inArray(schema.documentProvenance.documentId, ids),
                ),
              )
              .get(),
          );

    const documentsCreated = count(
      this.recueil.db
        .select({ n: sql<number>`count(distinct ${schema.documentProvenance.documentId})` })
        .from(schema.documentProvenance)
        .where(and(eq(schema.documentProvenance.jobId, runId), eq(schema.documentProvenance.isFirst, true)))
        .get(),
    );

    const documentsPresent =
      ids.length === 0
        ? 0
        : count(
            this.recueil.db
              .select({ n: sql<number>`count(*)` })
              .from(schema.documents)
              .where(inArray(schema.documents.id, ids))
              .get(),
          );

    const attachments =
      ids.length === 0
        ? 0
        : count(
            this.recueil.db
              .select({ n: sql<number>`count(*)` })
              .from(schema.attachments)
              .where(
                and(inArray(schema.attachments.documentId, ids), isNull(schema.attachments.trashedAt)),
              )
              .get(),
          );

    const itemsWithAttachment =
      ids.length === 0
        ? 0
        : count(
            this.recueil.db
              .select({ n: sql<number>`count(distinct ${schema.attachments.itemId})` })
              .from(schema.attachments)
              .innerJoin(schema.items, eq(schema.items.id, schema.attachments.itemId))
              .where(
                and(
                  inArray(schema.attachments.documentId, ids),
                  isNull(schema.attachments.trashedAt),
                  isNull(schema.items.trashedAt),
                ),
              )
              .get(),
          );

    // Counted, not subtracted. See the field's comment.
    const documentsWithoutAttachment =
      ids.length === 0
        ? 0
        : count(
            this.recueil.db
              .select({ n: sql<number>`count(*)` })
              .from(schema.documents)
              .where(
                and(
                  inArray(schema.documents.id, ids),
                  sql`not exists (select 1 from ${schema.attachments} where ${schema.attachments.documentId} = ${schema.documents.id} and ${schema.attachments.trashedAt} is null)`,
                ),
              )
              .get(),
          );

    const itemsCreatedPresent =
      itemIds.length === 0
        ? 0
        : count(
            this.recueil.db
              .select({ n: sql<number>`count(*)` })
              .from(schema.items)
              .where(and(inArray(schema.items.id, itemIds), isNull(schema.items.trashedAt)))
              .get(),
          );

    const filedRow =
      itemIds.length === 0
        ? undefined
        : this.recueil.db
            .select({
              rows: sql<number>`count(*)`,
              documents: sql<number>`count(distinct ${schema.attachments.documentId})`,
            })
            .from(schema.attachments)
            .where(
              and(inArray(schema.attachments.itemId, itemIds), isNull(schema.attachments.trashedAt)),
            )
            .get();
    const attachmentsCreated = filedRow?.rows ?? 0;
    const documentsFiledByRun = filedRow?.documents ?? 0;

    const openReviewEntries = count(
      this.recueil.db
        .select({ n: sql<number>`count(*)` })
        .from(reviewQueueTable)
        .where(and(eq(reviewQueueTable.jobId, runId), eq(reviewQueueTable.status, 'open')))
        .get(),
    );

    const blockerReviewEntries = count(
      this.recueil.db
        .select({ n: sql<number>`count(*)` })
        .from(reviewQueueTable)
        .where(
          and(
            eq(reviewQueueTable.jobId, runId),
            eq(reviewQueueTable.status, 'open'),
            eq(reviewQueueTable.severity, 'blocker'),
          ),
        )
        .get(),
    );

    const namedReviewEntriesOpen =
      reviewEntryIds.length === 0
        ? 0
        : count(
            this.recueil.db
              .select({ n: sql<number>`count(*)` })
              .from(reviewQueueTable)
              .where(
                and(inArray(reviewQueueTable.id, reviewEntryIds), eq(reviewQueueTable.status, 'open')),
              )
              .get(),
          );

    /* ---- The comparisons ------------------------------------------------------------------ */

    const unfiledAccountedFor =
      claimed.review + claimed.containers + claimed.stopped + claimed.failed;

    const checks: IngestVerification['checks'] = [
      {
        id: 'documents_present',
        ok: documentsPresent === ids.length,
        detail:
          `the run touched ${String(ids.length)} document(s); the library holds ` +
          `${String(documentsPresent)} of them`,
      },
      {
        // Every document this run touched was reached through `ingestBuffer`, which writes the
        // arrival in the same transaction as the `documents` row, so equality is what is meant: a
        // document the run names with no arrival against this job is the run claiming work
        // `document_provenance` has no record of. There is no other direction — the query is
        // restricted to the very ids the run named, so it cannot return more of them than exist.
        id: 'arrivals_recorded',
        ok: documentsWithArrivals === ids.length,
        detail:
          `the run touched ${String(ids.length)} document(s); document_provenance records an ` +
          `arrival against this job for ${String(documentsWithArrivals)} of them, over ` +
          `${String(arrivalsRecorded)} distinct arrival(s) in total`,
      },
      {
        id: 'items_created_exist',
        ok: itemsCreatedPresent === claimed.ingested && itemIds.length === claimed.ingested,
        detail:
          `the run says it filed ${String(claimed.ingested)} item(s) and named ` +
          `${String(itemIds.length)} of them; the library holds ${String(itemsCreatedPresent)} live ` +
          'item(s) with those ids',
      },
      {
        // The check the Phase 2 duplication defect could not fail. One document filed twice gives
        // the run two items and two live attachments over *one* document, so `attachmentsCreated`
        // and `documentsFiledByRun` come apart. Both are equalities against the run's own count of
        // what it filed, so the check fails in either direction.
        id: 'documents_filed_once',
        ok: attachmentsCreated === claimed.ingested && documentsFiledByRun === claimed.ingested,
        detail:
          `the run says it filed ${String(claimed.ingested)} document(s); the items it created ` +
          `carry ${String(attachmentsCreated)} live attachment(s) over ` +
          `${String(documentsFiledByRun)} distinct document(s)`,
      },
      {
        // Every entry the run says it raised must still be open in the queue: equality, and it
        // fails if one is missing or has been closed behind the run's back.
        //
        // Against `reviewEntryIds.size` rather than `claimed.review`, because the two are allowed
        // to differ: `review_queue` keeps at most one *open* row per dedupe key (§6.1, P9), so two
        // candidates carrying the same bytes and stopping at the same gate for the same reason
        // refresh one entry rather than opening two. Asserting one entry per review outcome would
        // report that idempotence as a defect.
        id: 'review_entries_raised',
        ok: namedReviewEntriesOpen === reviewEntryIds.length,
        detail:
          `the run says it queued ${String(claimed.review)} document(s) for review, naming ` +
          `${String(reviewEntryIds.length)} distinct entry(ies); ${String(namedReviewEntriesOpen)} ` +
          `of those are open, out of ${String(openReviewEntries)} open entry(ies) for this job`,
      },
      {
        // An inequality on purpose. The failure is *more* unfiled documents than the run admits to:
        // documents the run put in the library and then left attached to nothing without saying so.
        // The other direction — fewer — is reachable without a defect, because a document this run
        // routed to review can be accepted from the queue, or filed by another run, while this run
        // is still going; so it is not asserted. The count is a `count(*)`, so unlike the version
        // this replaces it cannot go negative and wave itself through.
        id: 'every_document_accounted_for',
        ok: documentsWithoutAttachment <= unfiledAccountedFor,
        detail:
          `${String(documentsWithoutAttachment)} document(s) this run touched carry no live ` +
          `attachment; the run accounts for ${String(claimed.review)} in review, ` +
          `${String(claimed.containers)} container(s), ${String(claimed.stopped)} stopped and ` +
          `${String(claimed.failed)} failed`,
      },
    ];

    return {
      claimed,
      queried: {
        documentsCreated,
        arrivalsRecorded,
        documentsWithArrivals,
        itemsWithAttachment,
        attachments,
        openReviewEntries,
        blockerReviewEntries,
        documentsWithoutAttachment,
        documentsPresent,
        itemsCreatedPresent,
        attachmentsCreated,
        documentsFiledByRun,
        namedReviewEntriesOpen,
      },
      checks,
      pass: checks.every((check) => check.ok),
    };
  }

  private sourceDetail(candidate: IngestCandidate, context: CandidateContext): Record<string, unknown> {
    return {
      ...(candidate.sourceMetadata ?? {}),
      sourceId: candidate.ref.sourceId,
      ...(candidate.ref.revision === undefined ? {} : { revision: candidate.ref.revision }),
      ...(context.parent === null
        ? {}
        : {
            archive: {
              sha256: context.parent.sha256,
              entry: context.parent.entryName,
              ...(context.parent.documentId === null ? {} : { documentId: context.parent.documentId }),
            },
          }),
    };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Concurrency                                                                                */
  /* ---------------------------------------------------------------------------------------- */

  /** A fixed-size worker pool. `concurrency` candidates in flight, never more. */
  private async pool(
    candidates: readonly IngestCandidate[],
    body: (candidate: IngestCandidate) => Promise<void>,
  ): Promise<void> {
    const width = Math.min(this.config.concurrency, Math.max(1, candidates.length));
    let next = 0;
    const workers = Array.from({ length: width }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= candidates.length) return;
        await body(candidates[index] as IngestCandidate);
      }
    });
    await Promise.all(workers);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const collect = async (
  candidates: Iterable<IngestCandidate> | AsyncIterable<IngestCandidate>,
): Promise<IngestCandidate[]> => {
  if (Symbol.asyncIterator in Object(candidates)) {
    const out: IngestCandidate[] = [];
    for await (const candidate of candidates as AsyncIterable<IngestCandidate>) out.push(candidate);
    return out;
  }
  return [...(candidates as Iterable<IngestCandidate>)];
};

const tally = (outcomes: readonly IngestOutcome[]): RunCounts => {
  const counts: RunCounts = { ingested: 0, duplicates: 0, review: 0, containers: 0, stopped: 0, failed: 0 };
  const walk = (outcome: IngestOutcome): void => {
    switch (outcome.status) {
      case 'ingested':
        counts.ingested += 1;
        break;
      case 'duplicate':
        counts.duplicates += 1;
        break;
      case 'review':
        counts.review += 1;
        break;
      case 'container':
        counts.containers += 1;
        break;
      case 'stopped':
        counts.stopped += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
    }
    if ('members' in outcome && outcome.members !== undefined) outcome.members.forEach(walk);
  };
  outcomes.forEach(walk);
  return counts;
};

const collectDocumentIds = (outcome: IngestOutcome, into: Set<string>): void => {
  if ('documentId' in outcome && typeof outcome.documentId === 'string' && outcome.documentId !== '') {
    into.add(outcome.documentId);
  }
  if ('members' in outcome && outcome.members !== undefined) {
    for (const member of outcome.members) collectDocumentIds(member, into);
  }
};

const applyMetadata = (proposal: ItemProposal, extracted: ExtractedMetadata): void => {
  if (proposal.itemType === undefined && extracted.itemType !== undefined) {
    proposal.itemType = extracted.itemType;
  }
  for (const [path, field] of Object.entries(extracted.fields)) {
    const existing = proposal.fields[path];
    // Higher confidence wins; equal confidence leaves the earlier extractor's value in place, so
    // the order of `extractors` is a documented preference rather than an accident.
    if (existing === undefined || field.provenance.confidence > existing.provenance.confidence) {
      proposal.fields[path] = field;
    }
  }
  if (proposal.creators.length === 0) proposal.creators.push(...extracted.creators);
};

const applyResolution = (proposal: ItemProposal, record: ResolutionRecord): void => {
  if (record.itemType !== undefined) proposal.itemType = record.itemType;
  for (const [path, field] of Object.entries(record.fields)) {
    // A resolver's answer comes from outside the document and outranks an extractor's reading of
    // it, which is the merge order §5.4 describes and the one Phase 3 will make configurable.
    proposal.fields[path] = field;
  }
  if (record.creators.length > 0) proposal.creators = record.creators;
};

const applyPatch = (proposal: ItemProposal, patch: ProposalPatch): void => {
  if (patch.itemType !== undefined) proposal.itemType = patch.itemType;
  for (const [path, field] of Object.entries(patch.fields ?? {})) proposal.fields[path] = field;
  if (patch.creators !== undefined) proposal.creators = patch.creators;
  for (const tag of patch.addTags ?? []) if (!proposal.tags.includes(tag)) proposal.tags.push(tag);
  for (const id of patch.addCollectionIds ?? []) {
    if (!proposal.collectionIds.includes(id)) proposal.collectionIds.push(id);
  }
  Object.assign(proposal.customFields, patch.customFields ?? {});
  proposal.notes.push(...(patch.addNotes ?? []));
};

const dedupeIdentifiers = (identifiers: readonly Identifier[]): Identifier[] => {
  const seen = new Set<string>();
  const out: Identifier[] = [];
  for (const identifier of identifiers) {
    const key = `${identifier.scheme}:${identifier.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(identifier);
  }
  return out;
};

const BIBLIO_PATH_BY_SCHEME: Partial<Record<Identifier['scheme'], string>> = {
  doi: 'bibliographic.doi',
  pmid: 'bibliographic.pmid',
  pmcid: 'bibliographic.pmcid',
  arxiv: 'bibliographic.arxivId',
  isbn: 'bibliographic.isbn',
  issn: 'bibliographic.issn',
  openalex: 'bibliographic.openalexId',
  semantic_scholar: 'bibliographic.semanticScholarId',
};

const biblioPathFor = (scheme: Identifier['scheme']): string | null =>
  BIBLIO_PATH_BY_SCHEME[scheme] ?? null;

/** Exactly the request body that accepting the review entry will execute (RQ1). */
const proposalPayload = (proposal: ItemProposal): never =>
  ({
    itemType: proposal.itemType ?? 'document',
    fields: Object.fromEntries(
      Object.entries(proposal.fields).map(([path, field]) => [path, field.value]),
    ),
    creators: proposal.creators.map((creator) => ({
      role: creator.role,
      family: creator.family ?? null,
      given: creator.given ?? null,
      literal: creator.literal ?? null,
      sequence: creator.sequence,
    })),
    tags: [...proposal.tags],
    collectionIds: [...proposal.collectionIds],
    customFields: { ...proposal.customFields },
    notes: [...proposal.notes],
    confidence: proposal.confidence,
  }) as never;

const count = (row: { n: number } | undefined): number => row?.n ?? 0;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type { ReviewQueueRow };
