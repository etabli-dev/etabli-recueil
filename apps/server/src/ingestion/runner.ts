/**
 * The pipeline, as the server holds it: one factory, one registry of runs in flight, one bridge.
 *
 * **The factory.** `@recueil/ingest` takes its sidecars behind interfaces, and this server has
 * none of them by default: no GROBID and no resolver, because neither is reachable without a
 * container runtime, and no OCR unless an operator names one. `RECUEIL_OCR_ENGINE=ocrmypdf` builds
 * the adapter in `@recueil/ingest` against a binary on `PATH`; anything else leaves stage 5 switched
 * off rather than failing per document — the job's stage trace then shows `ocr` absent rather than
 * run-and-failed, and `README.md` says so where an operator will read it. Nothing in this
 * repository's tests runs the real adapter: see `packages/ingest/src/ocr/ocrmypdf.ts` for what that
 * does and does not prove. What the pipeline *is* given is the stored rule set, through
 * `StoredRuleEvaluator`, so `/api/v1/rules` is wired to the thing that files documents rather than
 * to a form.
 *
 * **The registry.** A run started through the API keeps running after the response has been sent,
 * because a folder with four hundred scans is not a request-response operation. The registry is
 * what makes `POST /queue/{id}/cancel` mean anything: it holds the `AbortController` for every run
 * this process started, and cancelling aborts the pipeline's own signal — which the pipeline checks
 * between candidates and inside its retry loop.
 *
 * **The bridge.** `@recueil/ingest` has an event vocabulary of its own (`document.ingested`,
 * `ingest.review_queued`, `ingest.run_finished`, …). `spec/hooks.md` §7 has twelve lifecycle events
 * and no ingestion-specific ones, so the bridge maps rather than invents: a pipeline
 * `document.ingested` or `document.duplicate` becomes the lifecycle `document.ingested` with §7.3's
 * payload filled from the `documents` row, and a run becomes `job.started` / `job.finished` /
 * `job.failed`. Nothing is emitted that the catalogue does not name.
 *
 * The mapping is *deferred to the end of the run*, and that is not a detail. The pipeline emits its
 * own `document.ingested` at stage 2; §7.3's payload carries `reviewQueueEntryId`, which the gate
 * does not raise until stage 9. Publishing on arrival would report `undefined` for exactly the
 * documents a person has to look at.
 */
import { ConflictError, newId, nowTimestamp, schema } from '@recueil/core';
import type { Actor, Recueil } from '@recueil/core';
import {
  IngestCancelledError,
  IngestPipeline,
  OcrMyPdfEngine,
  OfficeHeuristicExtractor,
  UnavailableOcrEngine,
} from '@recueil/ingest';
import type { OcrEngine } from '@recueil/ingest';
import type { IngestCandidate, IngestOutcome, IngestRef, IngestRunReport } from '@recueil/ingest';
import { SourceRunner } from '@recueil/ingest-sources';
import type { SourceRunReport } from '@recueil/ingest-sources';
import { eq } from 'drizzle-orm';

import type { ServerConfig } from '../config.js';
import type { EventBus } from '../events.js';
import { publishDocumentIngestedFromPipeline, publishJobFailed, publishJobFinished, publishJobStarted } from '../publish.js';
import { RuleStore, StoredRuleEvaluator } from './rules-store.js';
import { IngestionSourceService } from './sources.js';

export interface IngestionRunnerDeps {
  readonly recueil: Recueil;
  readonly config: ServerConfig;
  readonly events: EventBus;
  readonly rules: RuleStore;
  readonly sources: IngestionSourceService;
  readonly log: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
}

/** The `jobs.job_type` of one poll of one configured source. */
export const SOURCE_JOB_TYPE = 'ingest.source';

/** The `jobs.job_type` the pipeline gives its own run rows. */
export const PIPELINE_JOB_TYPE = 'ingest.run';

/** Every job type this surface owns, for the queue's default filter. */
export const INGESTION_JOB_TYPES: readonly string[] = [SOURCE_JOB_TYPE, PIPELINE_JOB_TYPE];

/** A run was asked for on a source that is switched off. A 409 through `problem.ts`. */
export class SourceDisabledError extends ConflictError {
  readonly code = 'source_disabled';

  constructor(message: string) {
    super(message, { reason: 'source_disabled' });
    this.name = 'SourceDisabledError';
  }
}

/** The same source and label is already running. Carries the job so the caller can point at it. */
export class RunInProgressError extends ConflictError {
  readonly code = 'run_in_progress';

  constructor(
    message: string,
    readonly jobId: string,
  ) {
    super(message, { reason: 'run_in_progress', jobId });
    this.name = 'RunInProgressError';
  }
}

/** A run this process started and has not yet finished. */
interface ActiveRun {
  readonly jobId: string;
  readonly controller: AbortController;
  readonly startedAt: string;
  /** Set once the `SourceRunner` exists: aborting its signal is what reaches a run mid-document. */
  stop: (() => void) | null;
}

export class IngestionRunner {
  private readonly active = new Map<string, ActiveRun>();

  /** Resolved when every run in flight has settled. What `onClose` waits on. */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly deps: IngestionRunnerDeps) {}

  /**
   * Build a pipeline.
   *
   * One per run rather than one per process: the rule set is read at construction, so a pipeline
   * built per run gives every document in that run the same rules, and a rule edited mid-scan takes
   * effect on the next run rather than halfway through this one.
   */
  createPipeline(options: { actor: Actor; runId?: () => string | null } = { actor: this.deps.recueil.actor }): {
    pipeline: IngestPipeline;
    ruleCount: number;
    /**
     * Publish the run's `document.ingested` events, once the run has finished.
     *
     * Deferred rather than bridged as they arrive, and the reason is §7.3: the payload carries
     * `reviewQueueEntryId`, and the pipeline emits its own `document.ingested` at stage 2 — seven
     * stages before the gate that raises the entry. Publishing on arrival would mean querying the
     * queue before there was anything in it and reporting `undefined` for every document a person
     * has to look at, which is precisely the field a subscriber most needs.
     */
    flushDocumentEvents: (runId: string) => void;
  } {
    const currentRunId = options.runId ?? (() => null);
    const ocr = this.ocrEngine();
    const evaluator = new StoredRuleEvaluator({
      recueil: this.deps.recueil,
      store: this.deps.rules,
      actor: options.actor,
      onWarning: (message) => {
        const runId = currentRunId();
        if (runId === null) {
          this.deps.log('warn', message);
          return;
        }
        this.writeJobLog(runId, 'warn', message);
      },
    });

    const pending: { documentId: string; duplicate: boolean; ref: IngestRef }[] = [];

    const pipeline = new IngestPipeline({
      recueil: this.deps.recueil,
      actor: options.actor,
      config: {
        confidenceThreshold: this.deps.config.ingestConfidenceThreshold,
        // With no adapter configured, stage 5 is off rather than failing per document:
        // `ocr_status` becomes `skipped`, which is the truth.
        ocrEnabled: ocr !== null,
        ...(this.deps.config.ingestScratchPath === undefined
          ? {}
          : { scratchRoot: this.deps.config.ingestScratchPath }),
      },
      ocr: ocr ?? new UnavailableOcrEngine(),
      extractors: [new OfficeHeuristicExtractor()],
      resolvers: [],
      ruleEngine: evaluator,
      events: {
        emit: (event) => {
          if (event.type !== 'document.ingested' && event.type !== 'document.duplicate') return;
          pending.push({
            documentId: event.documentId,
            duplicate: event.type === 'document.duplicate',
            ref: event.ref,
          });
        },
      },
    });

    const flushDocumentEvents = (runId: string): void => {
      for (const entry of pending.splice(0)) {
        publishDocumentIngestedFromPipeline(this.deps.events, this.deps.recueil, {
          actor: options.actor,
          documentId: entry.documentId,
          duplicate: entry.duplicate,
          pipelineRunId: runId,
          ref: entry.ref,
        });
      }
    };

    return { pipeline, ruleCount: evaluator.size, flushDocumentEvents };
  }

  /**
   * The stage-5 adapter this server was configured with, or null for "do not OCR".
   *
   * Built per pipeline rather than once, because the adapter holds no state worth sharing and
   * because a configuration read at boot is a configuration a reader can find: there is exactly one
   * place that turns `RECUEIL_OCR_ENGINE` into an engine.
   */
  private ocrEngine(): OcrEngine | null {
    if (this.deps.config.ocrEngine !== 'ocrmypdf') return null;
    return new OcrMyPdfEngine({
      ...(this.deps.config.ocrBinary === undefined ? {} : { binary: this.deps.config.ocrBinary }),
      ...(this.deps.config.ocrLanguages.length === 0
        ? {}
        : { languages: this.deps.config.ocrLanguages }),
      ...(this.deps.config.ingestScratchPath === undefined
        ? {}
        : { scratchRoot: this.deps.config.ingestScratchPath }),
    });
  }

  /* ---- one upload ----------------------------------------------------------------------------- */

  /**
   * Run one candidate to completion and answer with what happened.
   *
   * Awaited rather than backgrounded, because the caller is a person who has just shared a file
   * from a phone and is looking at a spinner: the useful answer is "filed as this item" or "queued
   * for review because of this", and both are known by the time the pipeline returns.
   */
  async ingestOne(
    candidate: IngestCandidate,
    options: { actor: Actor; runLabel?: string },
  ): Promise<{ runId: string; outcome: IngestOutcome; report: IngestRunReport }> {
    let runId: string | null = null;
    const { pipeline, flushDocumentEvents } = this.createPipeline({
      actor: options.actor,
      runId: () => runId,
    });

    const startedAt = nowTimestamp();
    const report = await pipeline.run([candidate], {
      runLabel: options.runLabel ?? `upload-${newId()}`,
      sourceId: candidate.ref.sourceId,
      params: { via: 'api-upload', externalId: candidate.ref.externalId },
    });
    runId = report.runId;

    publishJobStarted(this.deps.events, options.actor, {
      jobId: report.runId,
      jobType: PIPELINE_JOB_TYPE,
      params: { via: 'api-upload' },
      attempt: 1,
      priority: 0,
      startedAt,
    });
    // In §7.1's `sequence` order: the job started, then what it did, then that it finished.
    flushDocumentEvents(report.runId);
    this.publishRunFinished(report, options.actor);

    const outcome = report.outcomes[0]?.outcome ?? {
      status: 'failed' as const,
      code: 'no_outcome',
      message: 'the run produced no outcome',
    };
    return { runId: report.runId, outcome, report };
  }

  /* ---- a source run --------------------------------------------------------------------------- */

  /**
   * Poll one configured source and run everything it offers, in the background.
   *
   * Two job rows, not one, and the distinction matters. This method owns an `ingest.source` row:
   * one poll of one source, which is the unit an operator asked for and the unit they can cancel.
   * The pipeline mints its own `ingest.run` row when the poll actually offers something, and that
   * row is recorded as this one's child through `parent_job_id` (§6.3). Collapsing the two would
   * mean a poll that offered nothing had no job at all, which is exactly the run an operator most
   * wants to see the reason for.
   */
  async startSourceRun(
    sourceId: string,
    options: { actor: Actor; runLabel?: string; limit?: number },
  ): Promise<{ jobId: string; runLabel: string; startedAt: string }> {
    const row = this.deps.sources.get(sourceId);
    if (!row.enabled) {
      throw new SourceDisabledError(`Source '${row.name}' is disabled. Enable it before running it.`);
    }

    const runLabel = options.runLabel ?? `api-${nowTimestamp()}`;
    const startedAt = nowTimestamp();
    const controller = new AbortController();
    // IK1's shape: the key is built from the work, not from when it was asked for, so two identical
    // requests collide rather than enqueuing two polls of the same source under the same label.
    const idempotencyKey = `ingest.source:${row.id}:${runLabel}`;

    const existing = this.deps.recueil.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.idempotencyKey, idempotencyKey))
      .get();
    if (existing !== undefined && (existing.state === 'queued' || existing.state === 'running')) {
      throw new RunInProgressError(
        `A run of '${row.name}' labelled '${runLabel}' is already ${existing.state}.`,
        existing.id,
      );
    }

    const jobId = existing?.id ?? newId();
    const attempt = (existing?.attempts ?? 0) + 1;

    if (existing === undefined) {
      this.deps.recueil.db
        .insert(schema.jobs)
        .values({
          id: jobId,
          jobType: SOURCE_JOB_TYPE,
          idempotencyKey,
          params: JSON.stringify({ sourceId: row.id, sourceName: row.name, runLabel }),
          state: 'running',
          priority: 0,
          runAfter: startedAt,
          startedAt,
          heartbeatAt: startedAt,
          attempts: attempt,
          maxAttempts: 100,
          progressDone: 0,
          createdByUserId: this.deps.recueil.user.id,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .run();
    } else {
      this.deps.recueil.db
        .update(schema.jobs)
        .set({
          state: 'running',
          startedAt,
          finishedAt: null,
          heartbeatAt: startedAt,
          attempts: attempt,
          maxAttempts: Math.max(existing.maxAttempts, attempt),
          errorCode: null,
          errorMessage: null,
          updatedAt: startedAt,
        })
        .where(eq(schema.jobs.id, jobId))
        .run();
    }

    this.active.set(jobId, { jobId, controller, startedAt, stop: null });
    publishJobStarted(this.deps.events, options.actor, {
      jobId,
      jobType: SOURCE_JOB_TYPE,
      idempotencyKey,
      params: { sourceId: row.id, runLabel },
      attempt,
      priority: 0,
      startedAt,
    });

    const promise = this.execute(row.id, jobId, startedAt, options)
      .catch((error: unknown) => {
        this.deps.log('error', 'an ingestion run threw outside the pipeline', {
          jobId,
          message: describe(error),
        });
        this.failJob(jobId, 'source_run_failed', describe(error), options.actor);
      })
      .finally(() => {
        this.active.delete(jobId);
      });

    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));

    return { jobId, runLabel, startedAt };
  }

  private async execute(
    sourceId: string,
    jobId: string,
    startedAt: string,
    options: { actor: Actor; limit?: number },
  ): Promise<void> {
    const row = this.deps.sources.get(sourceId);
    const { pipeline, ruleCount, flushDocumentEvents } = this.createPipeline({
      actor: options.actor,
      runId: () => jobId,
    });
    this.writeJobLog(jobId, 'info', `polling '${row.name}' with ${String(ruleCount)} ingestion rule(s)`);

    let source;
    try {
      source = this.deps.sources.buildSource(row);
    } catch (error) {
      this.failJob(jobId, 'source_unavailable', describe(error), options.actor);
      this.deps.sources.recordRun(sourceId, { jobId, at: nowTimestamp(), error: describe(error) });
      return;
    }

    const runner = new SourceRunner({
      source,
      pipeline,
      recueil: this.deps.recueil,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      onLog: (entry) => {
        this.writeJobLog(jobId, entry.level, entry.message, entry.data, entry.externalId);
      },
    });

    // `SourceRunner.stop()` aborts the signal it hands the pipeline, so this is what makes a cancel
    // reach a run that is already inside stage 5 of its fortieth document.
    const active = this.active.get(jobId);
    if (active !== undefined) active.stop = () => void runner.stop().catch(() => undefined);

    let report: SourceRunReport;
    try {
      await runner.start();
      report = await runner.runOnce();
    } catch (error) {
      if (error instanceof IngestCancelledError || active?.controller.signal.aborted === true) {
        this.cancelJob(jobId, options.actor);
        this.deps.sources.recordRun(sourceId, { jobId, at: nowTimestamp(), error: 'cancelled' });
        return;
      }
      this.failJob(jobId, 'source_run_failed', describe(error), options.actor);
      this.deps.sources.recordRun(sourceId, { jobId, at: nowTimestamp(), error: describe(error) });
      return;
    } finally {
      await runner.stop().catch(() => undefined);
    }

    this.deps.sources.recordRun(sourceId, {
      jobId,
      at: nowTimestamp(),
      ...(report.error === undefined ? {} : { error: report.error.message }),
    });

    // The pipeline's own run row becomes this job's child, so the queue shows the tree §6.3
    // describes rather than two unrelated rows.
    if (report.pipeline !== null) {
      this.deps.recueil.db
        .update(schema.jobs)
        .set({ parentJobId: jobId, rootJobId: jobId, updatedAt: nowTimestamp() })
        .where(eq(schema.jobs.id, report.pipeline.runId))
        .run();
      flushDocumentEvents(report.pipeline.runId);
      this.publishRunFinished(report.pipeline, options.actor);
    }

    this.finishSourceJob(jobId, startedAt, report, options.actor);
  }

  /* ---- cancellation and retry -------------------------------------------------------------------- */

  /**
   * Deliver a cancellation to a run this process is executing.
   *
   * Returns false when the job is not one of ours — a row left `running` by a process that died,
   * for instance. The route turns that into a different answer rather than pretending the abort
   * landed, because "cancelled" and "we could not reach it" are different things to be told.
   */
  cancel(jobId: string, actor: Actor): boolean {
    const run = this.active.get(jobId);
    if (run === undefined) return false;
    run.controller.abort();
    run.stop?.();
    this.deps.recueil.audit.record({
      actor,
      action: 'job.cancel_requested',
      entityType: 'job',
      entityId: jobId,
      reason: 'an operator cancelled the run through the API',
    });
    return true;
  }

  /** Whether this process is currently running the job — which is what makes a cancel deliverable. */
  isActive(jobId: string): boolean {
    return this.active.has(jobId);
  }

  /** Wait for every run this process started. Called from the application's `onClose`. */
  async drain(): Promise<void> {
    for (const run of this.active.values()) {
      run.controller.abort();
      run.stop?.();
    }
    await Promise.allSettled([...this.inFlight]);
  }

  /* ---- job bookkeeping ---------------------------------------------------------------------------- */

  private failJob(jobId: string, code: string, message: string, actor: Actor): void {
    const now = nowTimestamp();
    this.deps.recueil.db
      .update(schema.jobs)
      .set({ state: 'failed', finishedAt: now, errorCode: code, errorMessage: message, updatedAt: now })
      .where(eq(schema.jobs.id, jobId))
      .run();
    this.writeJobLog(jobId, 'error', message);
    publishJobFailed(this.deps.events, actor, {
      jobId,
      jobType: SOURCE_JOB_TYPE,
      state: 'failed',
      attempt: this.attemptsOf(jobId),
      willRetry: false,
      error: { code, message, retryable: true },
      failedAt: now,
    });
  }

  private cancelJob(jobId: string, actor: Actor): void {
    const now = nowTimestamp();
    this.deps.recueil.db
      .update(schema.jobs)
      .set({ state: 'cancelled', finishedAt: now, updatedAt: now })
      .where(eq(schema.jobs.id, jobId))
      .run();
    this.writeJobLog(jobId, 'warn', 'the run was cancelled; nothing already committed was undone');
    publishJobFinished(this.deps.events, actor, {
      jobId,
      jobType: SOURCE_JOB_TYPE,
      state: 'cancelled',
      attempt: this.attemptsOf(jobId),
      durationMs: 0,
      result: {},
      finishedAt: now,
    });
  }

  /**
   * Close the source job with what the poll actually did.
   *
   * `ok` comes from the runner, which computes it from the pipeline's own verification and from
   * whether every acknowledgement completed — not from a count this method kept. A run whose
   * acknowledgements were refused is `failed` here even though every document was ingested, which
   * is the honest reading: the far side still holds originals that were supposed to have moved.
   */
  private finishSourceJob(
    jobId: string,
    startedAt: string,
    report: SourceRunReport,
    actor: Actor,
  ): void {
    const now = nowTimestamp();
    const durationMs = Math.max(0, Date.parse(report.finishedAt) - Date.parse(startedAt));
    const refused = report.acknowledgements.filter(
      (record) => record.action === 'refused' || record.error !== undefined,
    );
    const result = {
      offered: report.offered,
      skipped: report.skipped.length,
      recovered: report.recovered.length,
      refusedAcknowledgements: refused.length,
      ...(report.pipeline === null
        ? { counts: null }
        : {
            pipelineJobId: report.pipeline.runId,
            counts: report.pipeline.counts,
            verificationPassed: report.pipeline.verification.pass,
          }),
    };

    const failed = report.error !== undefined || !report.ok;
    const review = report.pipeline !== null && report.pipeline.counts.review > 0;

    this.deps.recueil.db
      .update(schema.jobs)
      .set({
        // IK6: `waiting_review` is not a failure — it means a person owes the run a decision.
        state: failed ? 'failed' : review ? 'waiting_review' : 'succeeded',
        startedAt,
        finishedAt: now,
        progressDone: report.offered,
        progressTotal: report.offered,
        result: JSON.stringify(result),
        ...(failed
          ? {
              errorCode: report.error?.code ?? 'acknowledgement_refused',
              errorMessage:
                report.error?.message ??
                `${String(refused.length)} acknowledgement(s) were refused; the originals were left in place`,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(schema.jobs.id, jobId))
      .run();

    this.writeJobLog(
      jobId,
      failed ? 'error' : 'info',
      failed
        ? `the run did not finish cleanly: ${
            report.error?.message ?? `${String(refused.length)} acknowledgement(s) refused`
          }`
        : `offered ${String(report.offered)} candidate(s); ${String(report.skipped.length)} skipped`,
      result,
    );

    if (failed) {
      publishJobFailed(this.deps.events, actor, {
        jobId,
        jobType: SOURCE_JOB_TYPE,
        state: 'failed',
        attempt: this.attemptsOf(jobId),
        willRetry: false,
        error: {
          code: report.error?.code ?? 'acknowledgement_refused',
          message: report.error?.message ?? 'an acknowledgement was refused',
          retryable: true,
        },
        failedAt: now,
      });
      return;
    }

    publishJobFinished(this.deps.events, actor, {
      jobId,
      jobType: SOURCE_JOB_TYPE,
      state: 'succeeded',
      attempt: this.attemptsOf(jobId),
      durationMs,
      result,
      finishedAt: now,
    });
  }

  private publishRunFinished(report: IngestRunReport, actor: Actor): void {
    const durationMs = Math.max(0, Date.parse(report.finishedAt) - Date.parse(report.startedAt));
    if (report.counts.failed > 0) {
      publishJobFailed(this.deps.events, actor, {
        jobId: report.runId,
        jobType: PIPELINE_JOB_TYPE,
        state: 'failed',
        attempt: this.attemptsOf(report.runId),
        willRetry: false,
        error: {
          code: 'ingest_candidate_failed',
          message: `${String(report.counts.failed)} candidate(s) failed`,
          retryable: true,
        },
        failedAt: report.finishedAt,
      });
      return;
    }
    publishJobFinished(this.deps.events, actor, {
      jobId: report.runId,
      jobType: PIPELINE_JOB_TYPE,
      // `waiting_review` is not one of the two states §7.3 allows on `job.finished`, and the run
      // has in fact finished; the counts say how many entries a person now owes a decision on.
      state: 'succeeded',
      attempt: this.attemptsOf(report.runId),
      durationMs,
      result: { ...report.counts, verificationPassed: report.verification.pass },
      finishedAt: report.finishedAt,
    });
  }

  private attemptsOf(jobId: string): number {
    const row = this.deps.recueil.db
      .select({ attempts: schema.jobs.attempts })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .get();
    return row?.attempts ?? 1;
  }

  /** One line in `job_logs` (§6.4). Indexed by subject, so "what happened to this file" is one query. */
  writeJobLog(
    jobId: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
    subjectId?: string,
  ): void {
    this.deps.recueil.db
      .insert(schema.jobLogs)
      .values({
        id: newId(),
        jobId,
        loggedAt: nowTimestamp(),
        level,
        message,
        data: data === undefined ? null : JSON.stringify(data),
        subjectType: subjectId === undefined ? null : 'ingest_candidate',
        subjectId: subjectId ?? null,
      })
      .run();
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
