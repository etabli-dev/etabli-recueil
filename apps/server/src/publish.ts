/**
 * Publishing lifecycle events from the route handlers.
 *
 * `spec/hooks.md` §7 fixes the payload of each event, and this module builds them. Two properties
 * matter and are worth stating rather than assuming.
 *
 * **Post-commit.** Every function here is called *after* the service call has returned, which on
 * SQLite is after the transaction has committed. A service that threw publishes nothing, and there
 * is no path that emits an event for a write that did not happen (§7.2).
 *
 * **Honest payloads.** Where the spec's payload has a field this phase cannot fill — `ocrApplied`
 * before there is an OCR worker, `confidence` before there is a confidence gate — the field carries
 * the value that is *true today* rather than an invented one, and the choice is commented. A
 * subscriber that reads `stagesRun: ['hash', 'dedup', 'commit']` learns something correct; one that
 * reads a fabricated ten-stage list learns something false.
 */
import { schema as coreSchema } from '@recueil/core';
import type { Actor, IngestResult, ItemRecord, Recueil, schema } from '@recueil/core';
import { and, eq, isNull } from 'drizzle-orm';

import type { EventBus, EventEnvelope } from './events.js';
import { collectionIdsFor, itemTagsFor } from './queries.js';

/** How a record came to exist, as `spec/hooks.md` §7.3 enumerates it. */
export type CreatedVia = 'ui' | 'api' | 'mcp' | 'cli' | 'connector' | 'ingest' | 'import' | 'plugin' | 'promotion';

/** The identifier block of `ItemCreatedPayload`. */
const identifiersOf = (bibliographic: schema.ItemBibliographicRow | null): { scheme: string; value: string }[] => {
  if (bibliographic === null) return [];
  const candidates: readonly (readonly [string, string | null])[] = [
    ['doi', bibliographic.doi],
    ['pmid', bibliographic.pmid],
    ['pmcid', bibliographic.pmcid],
    ['arxiv', bibliographic.arxivId],
    ['isbn', bibliographic.isbn],
    ['issn', bibliographic.issn],
    ['openalex', bibliographic.openalexId],
    ['semantic_scholar', bibliographic.semanticScholarId],
    ['handle', bibliographic.handle],
  ];
  return candidates
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
    .map(([scheme, value]) => ({ scheme, value }));
};

export const publishItemCreated = (
  bus: EventBus,
  recueil: Recueil,
  record: ItemRecord,
  actor: Actor,
  createdVia: CreatedVia,
): EventEnvelope =>
  bus.publish({
    type: 'item.created',
    actor,
    payload: {
      itemId: record.item.id,
      publicId: record.item.publicId,
      itemType: record.item.itemType,
      title: record.item.title ?? undefined,
      collectionIds: collectionIdsFor(recueil.db, record.item.id),
      tags: itemTagsFor(recueil.db, record.item.id).map((tag) => tag.name),
      identifiers: identifiersOf(record.bibliographic),
      citationKey: record.bibliographic?.citationKey ?? undefined,
      createdVia,
      sourceSystem: record.item.sourceSystem ?? undefined,
      sourceId: record.item.sourceId ?? undefined,
      dateAdded: record.item.dateAdded,
    },
  });

export const publishItemUpdated = (
  bus: EventBus,
  recueil: Recueil,
  record: ItemRecord,
  actor: Actor,
  changedFields: readonly string[],
): EventEnvelope =>
  bus.publish({
    type: 'item.updated',
    actor,
    payload: {
      itemId: record.item.id,
      publicId: record.item.publicId,
      itemType: record.item.itemType,
      version: record.item.version,
      changedFields: [...changedFields],
      // `before`/`after` are the audit log's business and are not duplicated into the event: AL4
      // already keeps the changed fields, and copying them here would put field values on a bus
      // whose subscribers are not necessarily entitled to them (§7.2, redaction).
      before: {},
      after: {},
      lockedFields: recueil.provenance.lockedFields('item_bibliographic', record.item.id),
      provenance: [],
    },
  });

export const publishItemTrashed = (
  bus: EventBus,
  record: ItemRecord,
  actor: Actor,
  cascade: { attachmentIds: string[]; noteIds: string[]; annotationIds: string[] },
  reason?: string,
): EventEnvelope =>
  bus.publish({
    type: 'item.trashed',
    actor,
    payload: {
      itemId: record.item.id,
      publicId: record.item.publicId,
      trashedAt: record.item.trashedAt ?? '',
      ...(reason === undefined ? {} : { reason }),
      cascade,
    },
  });

export const publishItemRestored = (
  bus: EventBus,
  record: ItemRecord,
  actor: Actor,
  cascade: { attachmentIds: string[]; noteIds: string[]; annotationIds: string[] },
): EventEnvelope =>
  bus.publish({
    type: 'item.restored',
    actor,
    payload: {
      itemId: record.item.id,
      publicId: record.item.publicId,
      restoredAt: record.item.dateModified,
      restoredFrom: 'trash',
      cascade,
    },
  });

export const publishDocumentIngested = (
  bus: EventBus,
  result: IngestResult,
  actor: Actor,
  itemIds: readonly string[],
  pipelineRunId: string,
): EventEnvelope =>
  bus.publish({
    type: 'document.ingested',
    actor,
    payload: {
      documentId: result.document.id,
      sha256: result.document.sha256,
      mediaType: result.document.mimeType,
      byteSize: result.document.byteSize,
      storageBackend: result.document.storageBackend,
      storageKey: result.document.storageKey,
      hasTextLayer: result.document.hasTextLayer ?? false,
      // No OCR worker exists before Phase 2, so this is false rather than unknown: nothing ran.
      ocrApplied: false,
      source: {
        kind: result.document.sourceKind,
        ...(result.document.sourceRef === null ? {} : { ref: result.document.sourceRef }),
      },
      ...(result.created ? {} : { duplicateOfDocumentId: result.document.id }),
      itemIds: [...itemIds],
      pipelineRunId,
      // The stages this phase actually runs (CONCEPT.md §5.3): hash, the exact duplicate check,
      // and the commit. Archive extraction, OCR, GROBID and the rule engine arrive with Phase 2.
      stagesRun: ['hash', 'dedup', 'commit'],
      // There is no confidence gate yet, and a direct upload is not a guess.
      confidence: 1,
    },
  });

export const publishAttachmentAdded = (
  bus: EventBus,
  attachment: schema.AttachmentRow,
  actor: Actor,
  addedVia: 'ui' | 'api' | 'mcp' | 'connector' | 'ingest' | 'import' | 'plugin',
): EventEnvelope =>
  bus.publish({
    type: 'attachment.added',
    actor,
    payload: {
      attachmentId: attachment.id,
      itemId: attachment.itemId,
      ...(attachment.documentId === null ? {} : { documentId: attachment.documentId }),
      role: attachment.role,
      linkMode: attachment.linkMode,
      ...(attachment.url === null ? {} : { url: attachment.url }),
      ...(attachment.title === null ? {} : { filename: attachment.title }),
      position: attachment.position,
      addedVia,
    },
  });

/* -------------------------------------------------------------------------------------------- */
/* Phase 2: the ingestion pipeline and the job queue                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * `document.ingested` for a document the pipeline handled.
 *
 * §7.3 says the event "fires once per Document that reaches commit at pipeline stage 10, including
 * when the pipeline stopped at stage 2 because the hash already existed — with
 * `duplicateOfDocumentId` set and no new bytes stored". Both cases go through here.
 *
 * Every field is read back out of the library rather than taken from the pipeline's own event:
 * `storageBackend`, `storageKey` and `hasTextLayer` are columns, `itemIds` is a query over live
 * attachments, and `reviewQueueEntryId` is a query over open review rows for this document. A
 * payload assembled from the emitter's in-memory notion of what it had just done would agree with
 * itself whatever went wrong at the commit.
 */
export const publishDocumentIngestedFromPipeline = (
  bus: EventBus,
  recueil: Recueil,
  input: {
    actor: Actor;
    documentId: string;
    duplicate: boolean;
    pipelineRunId: string;
    ref?: { sourceId: string; externalId: string; revision?: string };
  },
): EventEnvelope | null => {
  const document = recueil.db
    .select()
    .from(coreSchema.documents)
    .where(eq(coreSchema.documents.id, input.documentId))
    .get();
  // A document the pipeline named and the library does not hold is a bug worth being loud about,
  // and emitting a half-filled event would hide it. No event, and the caller's log line stands.
  if (document === undefined) return null;

  const itemIds = recueil.db
    .select({ itemId: coreSchema.attachments.itemId })
    .from(coreSchema.attachments)
    .where(
      and(
        eq(coreSchema.attachments.documentId, input.documentId),
        isNull(coreSchema.attachments.trashedAt),
      ),
    )
    .all()
    .map((row) => row.itemId);

  const openReview = recueil.connection
    .prepare(
      `select id from review_queue
       where subject_type = 'document' and subject_id = ? and status = 'open'
       order by created_at limit 1`,
    )
    .get(input.documentId) as { id: string } | undefined;

  return bus.publish({
    type: 'document.ingested',
    actor: input.actor,
    payload: {
      documentId: document.id,
      sha256: document.sha256,
      mediaType: document.mimeType,
      byteSize: document.byteSize,
      storageBackend: document.storageBackend,
      storageKey: document.storageKey,
      hasTextLayer: document.hasTextLayer ?? false,
      // Stage 5 is off in this process: there is no OCR worker to reach (no container runtime), so
      // this is false because nothing ran, not because nothing was needed.
      ocrApplied: false,
      source: {
        kind: document.sourceKind,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        ...(document.sourceRef === null ? {} : { path: document.sourceRef }),
      },
      ...(input.duplicate ? { duplicateOfDocumentId: document.id } : {}),
      itemIds,
      pipelineRunId: input.pipelineRunId,
      stagesRun: PIPELINE_STAGES_RUN,
      confidence: 1,
      ...(openReview === undefined ? {} : { reviewQueueEntryId: openReview.id }),
    },
  });
};

/**
 * The stages this build's pipeline really runs.
 *
 * Not the ten of CONCEPT §5.3: OCR is off because there is no worker to reach, and resolution has
 * no resolvers until Phase 3. A subscriber that reads this list learns something correct; one that
 * read a fabricated ten-stage list would learn something false (the same reasoning as the Phase 1
 * `stagesRun: ['hash','dedup','commit']`).
 */
const PIPELINE_STAGES_RUN = [
  'hash',
  'duplicate_check',
  'archive_extraction',
  'type_detection',
  'metadata_extraction',
  'resolution',
  'rules',
  'confidence_gate',
  'commit',
];

export interface JobStartedInput {
  jobId: string;
  jobType: string;
  idempotencyKey?: string;
  params: Record<string, unknown>;
  attempt: number;
  priority: number;
  parentJobId?: string;
  startedAt: string;
}

/** `job.started` (§7.3). `params` carries no credential: the job rows this server writes hold none. */
export const publishJobStarted = (bus: EventBus, actor: Actor, input: JobStartedInput): EventEnvelope =>
  bus.publish({
    type: 'job.started',
    actor,
    payload: {
      jobId: input.jobId,
      jobType: input.jobType,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      params: input.params,
      attempt: input.attempt,
      priority: input.priority,
      ...(input.parentJobId === undefined ? {} : { parentJobId: input.parentJobId }),
      startedAt: input.startedAt,
    },
  });

export interface JobFinishedInput {
  jobId: string;
  jobType: string;
  state: 'succeeded' | 'cancelled';
  attempt: number;
  durationMs: number;
  result: Record<string, unknown>;
  parentJobId?: string;
  finishedAt: string;
}

export const publishJobFinished = (bus: EventBus, actor: Actor, input: JobFinishedInput): EventEnvelope =>
  bus.publish({
    type: 'job.finished',
    actor,
    payload: {
      jobId: input.jobId,
      jobType: input.jobType,
      state: input.state,
      attempt: input.attempt,
      durationMs: input.durationMs,
      result: input.result,
      ...(input.parentJobId === undefined ? {} : { parentJobId: input.parentJobId }),
      finishedAt: input.finishedAt,
    },
  });

export interface JobFailedInput {
  jobId: string;
  jobType: string;
  state: 'failed' | 'dead';
  attempt: number;
  willRetry: boolean;
  nextRunAfter?: string;
  error: { code: string; message: string; retryable: boolean; userMessage?: string };
  parentJobId?: string;
  failedAt: string;
}

export const publishJobFailed = (bus: EventBus, actor: Actor, input: JobFailedInput): EventEnvelope =>
  bus.publish({
    type: 'job.failed',
    actor,
    payload: {
      jobId: input.jobId,
      jobType: input.jobType,
      state: input.state,
      attempt: input.attempt,
      willRetry: input.willRetry,
      ...(input.nextRunAfter === undefined ? {} : { nextRunAfter: input.nextRunAfter }),
      error: input.error,
      ...(input.parentJobId === undefined ? {} : { parentJobId: input.parentJobId }),
      failedAt: input.failedAt,
    },
  });
