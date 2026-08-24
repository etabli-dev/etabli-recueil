/**
 * The `ingestStage` hook (`spec/hooks.md` §6.5).
 *
 * Every one of the ten stages is a hook point, `before` and `after`, so a plugin can insert a
 * custom OCR pre-pass, a barcode reader, a bank-statement parser or a house rule that reads a stamp
 * on a scanned letter. This module is the registry and the caller; the pipeline holds one and calls
 * `run` twice per anchor.
 *
 * The three guarantees the spec gives, and where each lives here:
 *
 * *Ordering* is total and unchanged between restarts: anchor position in the pipeline, then
 * `before` before `after`, then descending manifest priority, then plugin name, then hook id. That
 * is `compareStages`, and it is a pure function of the registration, so it is testable on its own.
 *
 * *Error handling* is the caller's: a throw propagates, which rolls back the document's ingestion,
 * and the pipeline counts consecutive throws and routes the document to review on the third rather
 * than retrying for ever. The registry does not swallow anything.
 *
 * *Idempotency* is the plugin's, and the input shape is what makes it feasible: a stage gets the
 * proposal read-only and returns a patch, so two stages that touch different fields commute and a
 * re-run applies the same patch to the same input.
 *
 * One deliberate difference from the spec text. §6.5 says a stage "runs inside the pipeline's
 * transaction (stage 10 is the commit)". Stages 1 and 2 cannot: hashing and storing the bytes are
 * asynchronous and the content store is not transactional, and `documents` has to exist before the
 * duplicate check can query it. So the honest statement is: stages 3 to 9 and the commit run
 * against a document row that is already durable, and everything the pipeline writes to the
 * *library* — item, attachment, facets, tags, collections, custom fields, index entry, review entry
 * — is one transaction at stage 10. A crash before it leaves a Document with no Item, which is a
 * state `spec/data-model.md` D4 explicitly allows ("an ingested file not yet filed") and which the
 * resume journal picks up from.
 */
import { newId, nowTimestamp } from '@recueil/core';
import type { Actor } from '@recueil/core';

import type {
  IngestRef,
  ItemProposal,
  JsonObject,
  PipelineAnchor,
  ProposalPatch,
  Sha256,
} from './types.js';
import { PIPELINE_ANCHORS } from './types.js';

export type StagePosition = 'before' | 'after';

/** What a stage is handed (`spec/hooks.md` §6.5, adapted to the in-process host of ADR-0012). */
export interface IngestStageInput {
  readonly documentId: string;
  readonly sha256: Sha256;
  readonly mediaType: string;
  readonly byteSize: number;
  /**
   * The bytes.
   *
   * The spec's `ReadHandle` exists so that bytes cross a `structuredClone` boundary without being
   * copied. There is no boundary yet — the host is in-process and trusted (ADR-0012) — so this is
   * a function returning a Buffer, which is the same contract with the ceremony deferred to the day
   * the host moves to `worker_threads` (ADR-0018).
   */
  readonly bytes: () => Promise<Buffer>;
  /** Extracted text, once a stage has produced it. */
  readonly text: string | null;
  /** The item the pipeline intends to create. Read-only: patch it through the result. */
  readonly proposal: Readonly<ItemProposal>;
  readonly source: { kind: string; ref: IngestRef; metadata?: JsonObject };
  readonly previousStages: readonly string[];
}

export type IngestStageResult =
  | {
      action: 'continue';
      patch?: ProposalPatch;
      /** Added to the running confidence the stage-9 gate reads. Range -1..1. */
      confidenceDelta?: number;
      /** Written to the job log, visible in the ingestion detail view. */
      notes?: string[];
    }
  | { action: 'review'; reasonCode: string; explanation: string; proposedAction?: string }
  | { action: 'stop'; reasonCode: string; explanation: string };

/** Handed to every hook call (`spec/hooks.md` §3.1), with what is true of this invocation. */
export interface IngestHookContext {
  readonly invocationId: string;
  readonly hookId: string;
  readonly anchor: PipelineAnchor;
  readonly position: StagePosition;
  readonly signal: AbortSignal;
  readonly deadline: string;
  /** 1 on the first attempt. Retries reuse the same idempotency key. */
  readonly attempt: number;
  readonly jobId?: string;
  readonly idempotencyKey?: string;
  readonly actor: Actor;
  /** True when the host is producing a report rather than applying changes. */
  readonly dryRun: boolean;
  readonly now: () => string;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface IngestStage {
  readonly id: string;
  readonly anchor: PipelineAnchor;
  readonly position: StagePosition;
  /** Manifest priority. Higher runs first within one anchor and position. */
  readonly priority?: number;
  /** The plugin that registered it, for the ordering tie-break and the audit trail. */
  readonly pluginName?: string;
  run(input: IngestStageInput, context: IngestHookContext): Promise<IngestStageResult>;
}

const ANCHOR_ORDER = new Map<PipelineAnchor, number>(
  PIPELINE_ANCHORS.map((anchor, index) => [anchor, index]),
);

/**
 * The total order of §6.5, as a comparator.
 *
 * Exported because "the order does not change between restarts" is a claim that should be tested
 * directly rather than inferred from a pipeline run.
 */
export const compareStages = (a: IngestStage, b: IngestStage): number =>
  (ANCHOR_ORDER.get(a.anchor) ?? 0) - (ANCHOR_ORDER.get(b.anchor) ?? 0) ||
  positionRank(a.position) - positionRank(b.position) ||
  (b.priority ?? 0) - (a.priority ?? 0) ||
  (a.pluginName ?? '').localeCompare(b.pluginName ?? '') ||
  a.id.localeCompare(b.id);

const positionRank = (position: StagePosition): number => (position === 'before' ? 0 : 1);

export class IngestStageRegistry {
  private readonly stages: IngestStage[] = [];

  constructor(stages: readonly IngestStage[] = []) {
    for (const stage of stages) this.register(stage);
  }

  register(stage: IngestStage): this {
    if (this.stages.some((existing) => existing.id === stage.id)) {
      throw new Error(`An ingest stage with id '${stage.id}' is already registered.`);
    }
    if (!ANCHOR_ORDER.has(stage.anchor)) {
      throw new Error(
        `'${stage.id}' declares anchor '${stage.anchor}', which is not one of ${PIPELINE_ANCHORS.join(', ')}.`,
      );
    }
    this.stages.push(stage);
    this.stages.sort(compareStages);
    return this;
  }

  /** Every registered stage, in the order they will run. */
  get all(): readonly IngestStage[] {
    return this.stages;
  }

  at(anchor: PipelineAnchor, position: StagePosition): IngestStage[] {
    return this.stages.filter((stage) => stage.anchor === anchor && stage.position === position);
  }

  get size(): number {
    return this.stages.length;
  }
}

export interface HookContextSeed {
  actor: Actor;
  signal: AbortSignal;
  attempt: number;
  jobId?: string;
  idempotencyKey?: string;
  dryRun: boolean;
  timeoutMs: number;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/** Build the per-invocation context. The deadline is the §5 timeout for `ingestStage.run`: 120 s. */
export const hookContext = (
  stage: IngestStage,
  seed: HookContextSeed,
): IngestHookContext => ({
  invocationId: newId(),
  hookId: stage.id,
  anchor: stage.anchor,
  position: stage.position,
  signal: seed.signal,
  deadline: new Date(Date.now() + seed.timeoutMs).toISOString(),
  attempt: seed.attempt,
  ...(seed.jobId === undefined ? {} : { jobId: seed.jobId }),
  ...(seed.idempotencyKey === undefined ? {} : { idempotencyKey: seed.idempotencyKey }),
  actor: seed.actor,
  dryRun: seed.dryRun,
  now: () => nowTimestamp(),
  log: seed.log,
});
