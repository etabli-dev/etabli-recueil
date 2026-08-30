/**
 * The source contract, as `spec/hooks.md` §6.4 states it.
 *
 * A source is a place documents come from — a watched folder, a WebDAV share, a mailbox — and the
 * hook spec fixes both its shape and its manners: `start` at activation, `poll` on a schedule,
 * `fetch` when the pipeline is ready for the bytes, `acknowledge` once the pipeline has finished
 * with a candidate, `stop` at deactivation. The division of labour is the important part and it is
 * P2: **the source never hashes, never stores and never creates Items.** It produces candidates and
 * bytes; `@recueil/ingest` owns everything downstream. Every decision this package makes about
 * moving, deleting or flagging something on the far side therefore has to be taken *after* the
 * pipeline has answered, and only on evidence queried back out of the library.
 *
 * The types live here rather than in `@recueil/plugin-sdk` for the same reason `@recueil/ingest`
 * keeps its hook types: the SDK package is a README and nothing else. When it is written it
 * re-exports these, and the sources keep their single definition.
 *
 * Two deliberate departures from the spec's literal signature, both because Phase 2 has no plugin
 * boundary to cross yet:
 *
 *   - `fetch` returns a `Buffer` rather than a `ReadHandle`, because `IngestCandidate.read()` in
 *     `@recueil/ingest` returns a `Buffer` and inventing a second representation to convert between
 *     would be ceremony. The size limits in each source's options are what keep that honest.
 *   - `start` and `stop` take the same `SourceContext` as everything else instead of a
 *     `PluginContext`, which does not exist yet.
 */
import type { DocumentSourceKind, IngestCandidate, IngestOutcome, IngestRef } from '@recueil/ingest';
import type { HealthReport, IngestRule, JsonObject, Timestamp } from '@recueil/ingest';
import type { Recueil } from '@recueil/core';

export type { DocumentSourceKind, IngestCandidate, IngestOutcome, IngestRef };

/** What a source is handed on every call. */
export interface SourceContext {
  /** The library. A source reads the state tables through it; it never writes library data. */
  recueil: Recueil;
  /** Aborted when the runner is stopping. Every network wait must honour it. */
  signal: AbortSignal;
  /** The run log. Goes to the job log when a runner is driving; to nothing when a test is. */
  log(entry: SourceLogEntry): void;
  now(): Timestamp;
}

export interface SourceLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
  externalId?: string;
}

/** One page of `poll`, plus what the source refused and why. Refusals are reported, never silent. */
export interface SourcePage {
  candidates: IngestCandidate[];
  /** Opaque to the runner; handed back on the next `poll`. */
  cursor?: string;
  /** True when the source knows there is more to be had straight away. */
  more: boolean;
  /** Entries the source saw and did not offer. `reason` is a sentence, not a code. */
  skipped: SkippedEntry[];
}

export interface SkippedEntry {
  externalId: string;
  reason: string;
}

/** What `acknowledge` did on the far side. Recorded, so an operator can see it happened. */
export type AcknowledgementAction =
  | 'left'
  | 'moved'
  | 'deleted'
  | 'marked'
  | 'refused'
  | 'vanished';

export interface Acknowledgement {
  action: AcknowledgementAction;
  /** A sentence naming the evidence: which check passed, where the thing went. */
  detail: string;
  /**
   * Whether the store verification passed before this acknowledgement acted.
   *
   * Not the same as "something happened": `vanished` means the work had already been done by an
   * earlier attempt, and it is still backed by a passing verification, while `left` under the
   * `leave` policy is not backed by anything because nothing was destroyed and nothing was claimed.
   */
  verified: boolean;
}

/**
 * What happens to the original once the pipeline has committed it.
 *
 * `leave` is the default everywhere, and it is the only policy that is safe without a state table:
 * the others destroy or move the evidence, so the source has to be certain first. "Certain" has one
 * meaning in this package — `verifyStoredDocuments` re-read the blob out of the content store,
 * recomputed its digest and found the matching `documents` row — and `delete` is refused when that
 * check has not passed.
 */
export type ConsumePolicy =
  | { mode: 'leave' }
  /** Move it aside. A directory for a folder, a collection for WebDAV, a mailbox for IMAP. */
  | { mode: 'move'; to: string }
  | { mode: 'delete' };

/** Outcome statuses a consume policy is allowed to act on. */
export const DEFAULT_CONSUME_ON = ['ingested', 'duplicate', 'review', 'container'] as const;

export type ConsumableStatus = IngestOutcome['status'];

/**
 * How many bytes a source will pull into memory for one candidate, unless told otherwise.
 *
 * ADR-0022 asks for budgets that are "configuration with conservative defaults, surfaced in one
 * place rather than scattered as literals". `maxBytes` was the budget that had no default at all:
 * every enforcement site was guarded by `!== undefined`, and no caller in the tree set it — not
 * `apps/server/src/ingestion/sources.ts`, which is the only production caller there is. So a
 * server-configured IMAP source would fetch a stranger's arbitrarily large message whole into a
 * `Buffer` before `parseEmail` decoded it at roughly seven times that again, and a WebDAV share
 * could hand back as many bytes as it liked. An unset budget is not a generous budget; it is an
 * absent one.
 *
 * 256 MiB is chosen against the largest thing a person legitimately drops into a watched folder — a
 * long duplex colour scan is tens of megabytes, and ADR-0022's own worked example of a large
 * legitimate file is 900 MB, which is above this on purpose so that raising it is a knowing act.
 * A candidate over the limit is skipped by name with the number in the message (ADR-0022 §6), not
 * silently dropped.
 */
export const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024 * 1024;

/** The options every source shares. */
export interface CommonSourceOptions {
  /** Defaults per source: the resolved root, the collection URL, `imap://user@host/mailbox`. */
  id?: string;
  /** `documents.source_kind`. A scanner drop directory is a `FolderSource` with `'scanner'` here. */
  sourceKind?: DocumentSourceKind;
  consume?: ConsumePolicy;
  /**
   * Which outcomes the consume policy acts on. Defaults to `DEFAULT_CONSUME_ON`.
   *
   * `stopped` and `failed` are deliberately not in the default: a document the pipeline refused is
   * the one case where the copy on the far side is the only copy left.
   */
  consumeOn?: readonly ConsumableStatus[];
  /** Merged into every candidate's `sourceMetadata`, for the stage-8 rule engine to match on. */
  sourceMetadata?: JsonObject;
  /** Rules the source contributes to stage 8. Passed to the pipeline by the runner. */
  rules?: readonly IngestRule[];
  /** Refuse anything larger rather than reading it into memory. Defaults to `DEFAULT_MAX_SOURCE_BYTES`. */
  maxBytes?: number;
}

/**
 * A source, per `spec/hooks.md` §6.4.
 *
 * `kind` says how the runner drives it: `poll` on a schedule, `watch` when the source pushes (a
 * watched folder does, through `subscribe`), `push` for an inbound webhook, which nothing here is.
 */
export interface IngestSource {
  readonly id: string;
  readonly kind: 'poll' | 'watch' | 'push';
  readonly sourceKind: DocumentSourceKind;
  /** The rules this source contributes to stage 8 — mail rules, mostly. */
  readonly rules: readonly IngestRule[];

  start(ctx: SourceContext): Promise<void>;
  poll(request: { cursor?: string; limit: number }, ctx: SourceContext): Promise<SourcePage>;
  fetch(ref: IngestRef, ctx: SourceContext): Promise<{ bytes: Buffer; mediaType?: string }>;
  /**
   * Apply the consume policy. Called once per candidate once the pipeline is done with it, and
   * possibly again after a crash, so every side effect it has must be safe to repeat.
   */
  acknowledge(ref: IngestRef, outcome: IngestOutcome, ctx: SourceContext): Promise<Acknowledgement>;
  stop(ctx: SourceContext): Promise<void>;
  health(ctx: SourceContext): Promise<HealthReport>;
  /** Push notification, for a `watch` source. Returns an unsubscribe function. */
  subscribe?(listener: () => void): () => void;
}
