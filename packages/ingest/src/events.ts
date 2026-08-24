/**
 * The events stage 10 emits.
 *
 * `spec/hooks.md` §1 draws the line this module sits on: "an event is a notification that something
 * already happened. It is delivered after the transaction that caused it has committed." So nothing
 * here can change an outcome, nothing here is awaited by the transaction, and — the part that
 * matters for correctness — an event handler that throws does not undo the ingest. A handler that
 * wants to stop something wants an `ingestStage` hook instead.
 *
 * `document.ingested` fires exactly once per successful commit, which is what makes it the right
 * place for a side effect: a webhook, a mail, a move of the source file. `ingestStage` hooks are
 * re-run on retry and on resume, and are therefore the wrong place for all three.
 */
import type { DetectedType, IngestRef, Sha256 } from './types.js';

export type IngestEvent =
  | {
      type: 'document.ingested';
      documentId: string;
      sha256: Sha256;
      mediaType: string;
      byteSize: number;
      detectedType: DetectedType;
      /** The archive it came out of, when it came out of one. */
      parentDocumentId: string | null;
      ref: IngestRef;
      occurredAt: string;
    }
  | {
      type: 'document.duplicate';
      documentId: string;
      sha256: Sha256;
      ref: IngestRef;
      /** How many arrivals of these bytes are now on record, this one included. */
      arrivals: number;
      occurredAt: string;
    }
  | {
      type: 'item.created';
      itemId: string;
      itemType: string;
      documentId: string;
      attachmentId: string;
      confidence: number;
      occurredAt: string;
    }
  | {
      type: 'ingest.review_queued';
      reviewQueueEntryId: string;
      documentId: string;
      reasonCode: string;
      confidence: number | null;
      occurredAt: string;
    }
  | {
      type: 'ingest.candidate_failed';
      ref: IngestRef;
      code: string;
      message: string;
      attempt: number;
      occurredAt: string;
    }
  | {
      type: 'ingest.run_finished';
      runId: string;
      ingested: number;
      duplicates: number;
      review: number;
      failed: number;
      occurredAt: string;
    };

export type IngestEventType = IngestEvent['type'];

export interface IngestEventSink {
  emit(event: IngestEvent): void;
}

/**
 * The default sink: it collects, and it never lets a subscriber's throw reach the pipeline.
 *
 * Swallowing is right here and would be wrong almost anywhere else. The transaction has already
 * committed by the time an event is emitted; a subscriber that throws has failed at its own job,
 * not at the ingest, and unwinding the caller would turn a webhook timeout into a lost document.
 * The error is reported through `onError` so it is not invisible.
 */
export class EventBus implements IngestEventSink {
  private readonly subscribers = new Map<IngestEventType | '*', Array<(event: IngestEvent) => void>>();

  /** Every event emitted, in order. Small, and what the tests assert against. */
  readonly emitted: IngestEvent[] = [];

  constructor(private readonly onError: (error: unknown, event: IngestEvent) => void = () => {}) {}

  on(type: IngestEventType | '*', handler: (event: IngestEvent) => void): this {
    const existing = this.subscribers.get(type);
    if (existing === undefined) this.subscribers.set(type, [handler]);
    else existing.push(handler);
    return this;
  }

  emit(event: IngestEvent): void {
    this.emitted.push(event);
    for (const handler of [...(this.subscribers.get(event.type) ?? []), ...(this.subscribers.get('*') ?? [])]) {
      try {
        handler(event);
      } catch (error) {
        this.onError(error, event);
      }
    }
  }

  of<T extends IngestEventType>(type: T): Array<Extract<IngestEvent, { type: T }>> {
    return this.emitted.filter((event): event is Extract<IngestEvent, { type: T }> => event.type === type);
  }
}
