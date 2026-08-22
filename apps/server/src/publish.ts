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
import type { Actor, IngestResult, ItemRecord, Recueil, schema } from '@recueil/core';

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
