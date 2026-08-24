/**
 * What drives a source: poll, ingest, acknowledge, and pick up where the last attempt stopped.
 *
 * `spec/hooks.md` §6.4 describes the host's side of the source contract, and this is it, at the
 * size Phase 2 needs — the job runner of ADR-0010 will eventually own the scheduling, the leases
 * and the backoff, and this class is what it will call.
 *
 * The order of the four steps is the whole design, because each gap between them is a crash window:
 *
 * ```
 *   recover ──▶ poll ──▶ pipeline.run ──▶ record ──▶ acknowledge
 *      ▲                     │              │            │
 *      │                     │              │            └─ far side touched, row closed
 *      │                     │              └─ row written 'pending' *before* the far side
 *      │                     └─ resumable by run label; idempotent by (hash, source, path)
 *      └─ replays every row still 'pending' from a previous process
 * ```
 *
 * *Lost* is prevented by writing the state row before touching the far side, and by never
 * consuming an original that the store cannot be shown to hold. *Duplicated* is prevented twice
 * over: the pipeline is idempotent by `(sha256, sourceId, externalId)` and answers a second arrival
 * of the same bytes at stage 2, and the run label lets an interrupted run resume its own journal
 * rather than repeat the expensive stages.
 *
 * **The source's rules.** A source may contribute stage-8 rules — an `ImapSource` compiles its mail
 * rules into them. The pipeline takes its rules at construction, so the caller wires them up:
 *
 * ```ts
 * const source = new ImapSource({ …, mailRules });
 * const pipeline = new IngestPipeline({ recueil, rules: source.rules });
 * const runner = new SourceRunner({ source, pipeline, recueil });
 * ```
 */
import { nowTimestamp } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import type { IngestPipeline, IngestRunReport, IngestRule } from '@recueil/ingest';

import { sourceState } from './state.js';
import type { SourceStateStore } from './state.js';
import type {
  Acknowledgement,
  AcknowledgementAction,
  IngestOutcome,
  IngestRef,
  IngestSource,
  SkippedEntry,
  SourceContext,
  SourceLogEntry,
} from './types.js';

export interface SourceRunnerOptions {
  source: IngestSource;
  pipeline: IngestPipeline;
  recueil: Recueil;
  /** How many candidates to take in one poll. Default 50. */
  limit?: number;
  /** Everything the runner and the source log. Default: discarded. */
  onLog?: (entry: SourceLogEntry & { sourceId: string }) => void;
}

export interface AcknowledgementRecord {
  ref: IngestRef;
  status: IngestOutcome['status'];
  action: AcknowledgementAction;
  detail: string;
  /** Whether the store verification passed. False for `left` and for a refusal alike. */
  verified: boolean;
  /** Set when `acknowledge` threw. The row stays `pending` and the next run replays it. */
  error?: string;
}

export interface SourceRunReport {
  sourceId: string;
  startedAt: string;
  finishedAt: string;
  /** Rows from a previous process whose acknowledgement was replayed before this poll. */
  recovered: AcknowledgementRecord[];
  offered: number;
  skipped: SkippedEntry[];
  /** Null when the poll offered nothing, in which case the pipeline was not run at all. */
  pipeline: IngestRunReport | null;
  acknowledgements: AcknowledgementRecord[];
  /**
   * True when the pipeline's own verification passed and every acknowledgement — this run's and any
   * replayed from a previous one — completed without being refused.
   */
  ok: boolean;
  /** Set when the poll itself failed. The cursor is not advanced and nothing is lost. */
  error?: { code: string; message: string; consecutiveFailures: number };
}

export class SourceRunner {
  readonly source: IngestSource;
  private readonly pipeline: IngestPipeline;
  private readonly recueil: Recueil;
  private readonly state: SourceStateStore;
  private readonly limit: number;
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private queued = false;
  private stopped = false;

  constructor(private readonly options: SourceRunnerOptions) {
    this.source = options.source;
    this.pipeline = options.pipeline;
    this.recueil = options.recueil;
    this.state = sourceState(options.recueil);
    this.limit = options.limit ?? 50;
  }

  /** Every rule the given sources contribute, for the pipeline's constructor. */
  static rulesFor(...sources: readonly IngestSource[]): IngestRule[] {
    return sources.flatMap((source) => [...source.rules]);
  }

  async start(): Promise<void> {
    await this.source.start(this.context());
  }

  /**
   * Stop polling and let go of the source.
   *
   * One-shot: the abort signal a runner hands its source and its pipeline cannot be un-aborted, so
   * a restart is a new `SourceRunner` over the same source and library. The state table is what
   * carries anything the stopped one had not finished.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller.abort();
    await this.source.stop(this.context());
  }

  /**
   * Keep running: on the source's own notifications where it has them, and on an interval
   * regardless, because a missed filesystem event should cost a delay and never a document.
   */
  watch(options: { intervalMillis?: number } = {}): void {
    const interval = options.intervalMillis ?? 60_000;
    if (this.source.subscribe !== undefined) {
      this.unsubscribe = this.source.subscribe(() => void this.trigger());
    }
    if (interval > 0) {
      this.timer = setInterval(() => void this.trigger(), interval);
      this.timer.unref?.();
    }
  }

  /**
   * Run once, and never twice at the same time.
   *
   * A second call while a run is in flight sets a flag rather than starting a run: §6.4 says `poll`
   * is never called concurrently with itself for the same source, and a watched folder generates
   * events faster than an OCR pass finishes.
   */
  async trigger(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.queued = false;
        if (this.stopped) return;
        await this.runOnce();
      } while (this.queued);
    } catch (error) {
      this.log({
        level: 'error',
        message: `the run failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.running = false;
    }
  }

  /** One poll, one pipeline run, one acknowledgement per candidate. */
  async runOnce(): Promise<SourceRunReport> {
    const startedAt = nowTimestamp();
    const ctx = this.context();
    const sourceId = this.source.id;

    const recovered = await this.recover(ctx);

    let page;
    try {
      const cursor = this.state.cursor(sourceId).cursor;
      page = await this.source.poll(
        { ...(cursor === null ? {} : { cursor }), limit: this.limit },
        ctx,
      );
      this.state.recordPollSuccess(sourceId);
    } catch (error) {
      // §6.4: the cursor is not advanced, so nothing is lost, and three consecutive failures mark
      // the source degraded.
      const message = error instanceof Error ? error.message : String(error);
      const failures = this.state.recordPollFailure(sourceId, message);
      this.log({ level: 'error', message: `poll failed (${String(failures)} in a row): ${message}` });
      return {
        sourceId,
        startedAt,
        finishedAt: nowTimestamp(),
        recovered,
        offered: 0,
        skipped: [],
        pipeline: null,
        acknowledgements: [],
        ok: false,
        error: {
          code: (error as { code?: string }).code ?? 'poll_failed',
          message,
          consecutiveFailures: failures,
        },
      };
    }

    for (const entry of page.skipped) {
      this.log({ level: 'debug', message: entry.reason, externalId: entry.externalId });
    }

    if (page.candidates.length === 0) {
      if (page.cursor !== undefined) this.state.setCursor(sourceId, page.cursor);
      return {
        sourceId,
        startedAt,
        finishedAt: nowTimestamp(),
        recovered,
        offered: 0,
        skipped: page.skipped,
        pipeline: null,
        acknowledgements: [],
        ok: true,
      };
    }

    // An unfinished run is resumed under its own label so the pipeline's journal can skip the
    // stages it already paid for; a fresh one gets a new label.
    const open = this.state.cursor(sourceId).open_run_label;
    const label = open ?? `${sourceId}@${startedAt}`;
    this.state.setOpenRun(sourceId, label);

    const report = await this.pipeline.run(page.candidates, {
      runLabel: label,
      sourceId,
      total: page.candidates.length,
      signal: this.controller.signal,
      params: { sourceId, sourceKind: this.source.sourceKind, kind: this.source.kind },
    });
    this.state.setOpenRun(sourceId, null);

    const acknowledgements: AcknowledgementRecord[] = [];
    for (const entry of report.outcomes) {
      // The row lands before the far side is touched. Everything after this point is replayable.
      this.state.recordOutcome({ sourceId, ref: entry.ref, outcome: entry.outcome });
      acknowledgements.push(await this.acknowledge(ctx, entry.ref, entry.outcome));
    }

    if (page.cursor !== undefined) this.state.setCursor(sourceId, page.cursor);

    // A refusal is not an error — it is the verification doing its job — but it is emphatically not
    // a clean run either, and a report that called it one would be the kind of check the Phase 1
    // review found and condemned.
    const failedAcks = [...recovered, ...acknowledgements].filter(
      (record) => record.error !== undefined || record.action === 'refused',
    );
    return {
      sourceId,
      startedAt,
      finishedAt: nowTimestamp(),
      recovered,
      offered: page.candidates.length,
      skipped: page.skipped,
      pipeline: report,
      acknowledgements,
      ok: report.verification.pass && failedAcks.length === 0,
    };
  }

  /* ---------------------------------------------------------------------------------------- */

  /**
   * Replay every acknowledgement that never completed.
   *
   * This is the crash window made good. The pipeline has already committed these documents — the
   * row would not exist otherwise — so re-acknowledging must not re-ingest anything, and it does
   * not: `acknowledge` reads the outcome from the row and each source's implementation is safe to
   * repeat, answering `vanished` where the previous attempt had in fact finished.
   */
  private async recover(ctx: SourceContext): Promise<AcknowledgementRecord[]> {
    const rows = this.state.pending(this.source.id);
    const records: AcknowledgementRecord[] = [];
    for (const row of rows) {
      if (row.outcome === null) continue;
      const ref: IngestRef = {
        sourceId: row.sourceId,
        externalId: row.externalId,
        ...(row.revision === '' ? {} : { revision: row.revision }),
      };
      this.log({
        level: 'info',
        message: `replaying the acknowledgement interrupted after a '${row.status}' outcome`,
        externalId: row.externalId,
      });
      records.push(await this.acknowledge(ctx, ref, row.outcome));
    }
    return records;
  }

  private async acknowledge(
    ctx: SourceContext,
    ref: IngestRef,
    outcome: IngestOutcome,
  ): Promise<AcknowledgementRecord> {
    let result: Acknowledgement;
    try {
      result = await this.source.acknowledge(ref, outcome, ctx);
    } catch (error) {
      // §6.4: a throw from `acknowledge` is retried separately from ingestion, because the document
      // is already in the library and failing to move the mail must not cause a re-ingest. The row
      // stays `pending`, so the next run replays exactly this call and nothing else.
      const message = error instanceof Error ? error.message : String(error);
      this.log({ level: 'error', message: `acknowledge failed: ${message}`, externalId: ref.externalId });
      return {
        ref,
        status: outcome.status,
        action: 'refused',
        detail: message,
        verified: false,
        error: message,
      };
    }

    this.state.recordAcknowledgement({
      sourceId: this.source.id,
      externalId: ref.externalId,
      action: result.action,
      detail: result.detail,
      verified: result.verified,
    });
    this.log({
      level: result.action === 'refused' ? 'warn' : 'debug',
      message: `${result.action}: ${result.detail}`,
      externalId: ref.externalId,
    });
    return {
      ref,
      status: outcome.status,
      action: result.action,
      detail: result.detail,
      verified: result.verified,
    };
  }

  private context(): SourceContext {
    return {
      recueil: this.recueil,
      signal: this.controller.signal,
      log: (entry) => this.log(entry),
      now: () => nowTimestamp(),
    };
  }

  private log(entry: SourceLogEntry): void {
    this.options.onLog?.({ ...entry, sourceId: this.source.id });
  }
}
