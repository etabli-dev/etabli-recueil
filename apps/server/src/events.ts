/**
 * The lifecycle event bus, and the envelope `spec/hooks.md` §7.1 specifies.
 *
 * §7 names twelve events and says they are "delivered after the transaction that caused them has
 * committed". That sentence decides the design: the bus is *not* wired into `@recueil/core`, whose
 * services know nothing about it, but is published by the route handler once the service call has
 * returned — which is, on SQLite, once the transaction has committed. A service that threw emits
 * nothing, because the handler never reaches the publish.
 *
 * The envelope is §7.1 verbatim, with one honest deviation recorded here rather than hidden:
 * `sequence` is "monotonic within an install, persisted, continues across restarts" in the spec,
 * and here it is monotonic within the *process*. Persisting it needs a table that Phase 1's
 * migrations do not have, and a counter that silently restarts at 1 would be worse than one whose
 * scope is documented. Ordering within a connection — which is what an SSE client actually uses it
 * for — is correct either way.
 *
 * Delivery to SSE subscribers is best-effort and non-blocking (§7.2, "post-commit"): a slow reader
 * gets disconnected rather than allowed to hold up a write. There is no replay and no backlog,
 * which is exactly what §7.2 promises ("a plugin enabled today receives events from today").
 */
import { EventEmitter } from 'node:events';

import { newId, nowTimestamp } from '@recueil/core';
import type { Actor } from '@recueil/core';

/** The twelve lifecycle events of `spec/hooks.md` §7.1. */
export const LIFECYCLE_EVENT_TYPES = [
  'item.created',
  'item.updated',
  'item.merged',
  'item.trashed',
  'item.restored',
  'document.ingested',
  'attachment.added',
  'annotation.created',
  'check.completed',
  'job.started',
  'job.finished',
  'job.failed',
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

/**
 * The subset of the twelve this surface can actually cause.
 *
 * Published so that a test can assert the stream only ever emits what the REST surface is in a
 * position to know about, and so that `GET /api/v1/events` can say so in its own description
 * rather than implying the whole catalogue.
 *
 * Phase 2 adds the ingestion lifecycle: `job.started`, `job.finished` and `job.failed`, emitted by
 * every ingestion run — an upload, a source poll, a retry — and a `document.ingested` that now
 * carries a real `pipelineRunId` and, when the confidence gate routed the document to a person, a
 * `reviewQueueEntryId` (§7.3).
 *
 * What is deliberately *not* here: an `ingest.*` type. `@recueil/ingest` has its own richer
 * vocabulary internally, and `spec/hooks.md` §8 says there are no events beyond the twelve, so the
 * pipeline's `ingest.review_queued` and `ingest.candidate_failed` are carried by
 * `document.ingested.reviewQueueEntryId` and by `job.failed` rather than invented on the wire.
 * `item.created` stays off the list for a pipeline commit as well, for the honest reason that the
 * commit happens inside `@recueil/ingest` and this server is not in a position to build §7.3's
 * payload for it without re-querying every item the run touched; the run's `job.finished` result
 * carries the counts, and `document.ingested.itemIds` names the items.
 */
export const EMITTED_EVENT_TYPES: readonly LifecycleEventType[] = [
  'item.created',
  'item.updated',
  'item.trashed',
  'item.restored',
  'document.ingested',
  'attachment.added',
  'job.started',
  'job.finished',
  'job.failed',
];

export interface EventEnvelope<TPayload = Record<string, unknown>> {
  /** A ULID. The idempotency key for a handler: the same envelope may arrive twice (§7.2). */
  readonly id: string;
  readonly type: LifecycleEventType;
  readonly occurredAt: string;
  /** Order by this, never by `occurredAt`, which has clock resolution and can tie (§7.2). */
  readonly sequence: number;
  readonly actor: Actor;
  /** Correlates every event caused by one API request. */
  readonly requestId?: string;
  readonly causationId?: string;
  readonly payload: TPayload;
}

export type EventListener = (envelope: EventEnvelope) => void;

export interface PublishInput<TPayload = Record<string, unknown>> {
  readonly type: LifecycleEventType;
  readonly actor: Actor;
  readonly payload: TPayload;
  readonly causationId?: string;
}

/**
 * The in-process bus.
 *
 * `EventEmitter` rather than an array of callbacks because it already has the semantics wanted
 * here — many listeners, synchronous fan-out, a listener throwing does not stop the others — and
 * because §7.2's "a throw from a handler is logged and swallowed" is one `try` away from it.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  private counter = 0;

  constructor(private readonly onListenerError?: (error: unknown, envelope: EventEnvelope) => void) {
    // A stream with many subscribers is a normal state for this server, not a leak.
    this.emitter.setMaxListeners(0);
  }

  /** The highest sequence number issued so far. Zero before anything has happened. */
  get sequence(): number {
    return this.counter;
  }

  /** Publish one event. Returns the envelope, so a caller can log or chain from its id. */
  publish<TPayload extends Record<string, unknown>>(input: PublishInput<TPayload>): EventEnvelope<TPayload> {
    this.counter += 1;
    const envelope: EventEnvelope<TPayload> = {
      id: newId(),
      type: input.type,
      occurredAt: nowTimestamp(),
      sequence: this.counter,
      actor: input.actor,
      ...(input.actor.requestId === undefined || input.actor.requestId === null
        ? {}
        : { requestId: input.actor.requestId }),
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      payload: input.payload,
    };

    for (const listener of this.emitter.listeners('event') as EventListener[]) {
      try {
        listener(envelope as EventEnvelope);
      } catch (error) {
        this.onListenerError?.(error, envelope as EventEnvelope);
      }
    }

    return envelope;
  }

  subscribe(listener: EventListener): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  /** How many subscribers there are. The `/health` and the tests both want to know. */
  get subscriberCount(): number {
    return this.emitter.listenerCount('event');
  }
}

/**
 * Render one envelope as an SSE frame.
 *
 * `id:` carries the sequence so a browser's `EventSource` sends `Last-Event-ID` on reconnect;
 * `event:` carries the lifecycle type so a client can `addEventListener('item.created', …)` rather
 * than switching on a parsed body. The blank line at the end is what terminates the frame — a
 * missing one is the classic reason an SSE stream appears to hang.
 */
export const renderSseFrame = (envelope: EventEnvelope): string => {
  const data = JSON.stringify(envelope);
  return `id: ${envelope.sequence}\nevent: ${envelope.type}\ndata: ${data}\n\n`;
};
