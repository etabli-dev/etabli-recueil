/**
 * Finding, by query, which Recueil row a Paperless record became.
 *
 * The importer knows the correspondence while it runs, in a `Map` in the process. That knowledge is
 * worth nothing to two of the people who need it: a resumed run in a *new* process, and the
 * verification report. Both have to rediscover it from the database — and for the report that is
 * not an inconvenience but the whole point. A check that counts the importer's own log entries
 * cannot fail, and a report full of checks that cannot fail is worse than no report, because it
 * reads as evidence.
 *
 * So the correspondence is reconstructed here, from facts the target database holds:
 *
 * - **Items.** `items.source_system = 'paperless'` and `items.source_id = '<document id>'`. One
 *   query, one index.
 * - **Documents.** `document_provenance.source_ref = 'paperless:document:<id>'`, which the ingest
 *   wrote (P4). That is the whole reason the importer sets it: it makes the correspondence a fact
 *   in the database rather than something only the running process knew.
 * - **Attachments.** The row on the host item that points at that document.
 *
 * Nothing here reads `job_logs`, and nothing here consults the running import.
 */
import { schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { and, eq, isNull, like } from 'drizzle-orm';

/**
 * The custom field the Paperless document-type name is carried across in, verbatim.
 *
 * These three keys live here rather than in `import.ts` because the verification report has to look
 * the values up in the target by key, and `import.ts` already imports this module. A literal
 * repeated in the report would be a second source of truth for the same string, which is exactly
 * how a check comes to look at a field nothing writes.
 */
export const DOCUMENT_TYPE_FIELD_KEY = 'paperless_document_type';

/** The custom field the Paperless storage-path name is carried across in. */
export const STORAGE_PATH_FIELD_KEY = 'paperless_storage_path';

/** The custom field an ASN goes to when another item already holds it in `item_office`. */
export const ASN_FIELD_KEY = 'paperless_asn';

/** `items.source_system` for everything this importer writes. */
export const SOURCE_SYSTEM = 'paperless';

/** `document_provenance.source_ref` for an imported original. */
export const documentSourceRef = (paperlessId: number): string => `paperless:document:${paperlessId}`;

const SOURCE_REF_PREFIX = 'paperless:document:';

/**
 * Paperless document id → Recueil item id, for every **live** item the target says came from
 * Paperless.
 *
 * Trashed items are left out on purpose. An item a person has binned since the last run is not a
 * place to write to — the services refuse it — and it is not evidence that the document was
 * carried either. Both callers want the live set: a resumed run, which must not write into the
 * trash, and the verification report, which counts the trashed ones separately and names them.
 */
export const importedItemIds = (recueil: Recueil): Map<number, string> => {
  const rows = recueil.db
    .select({ id: schema.items.id, sourceId: schema.items.sourceId })
    .from(schema.items)
    .where(and(eq(schema.items.sourceSystem, SOURCE_SYSTEM), isNull(schema.items.trashedAt)))
    .all();

  const byPaperlessId = new Map<number, string>();
  for (const row of rows) {
    if (row.sourceId === null) continue;
    const parsed = Number(row.sourceId);
    if (Number.isSafeInteger(parsed)) byPaperlessId.set(parsed, row.id);
  }
  return byPaperlessId;
};

/** Paperless document id → Recueil document id, from `document_provenance`. */
export const importedDocumentIds = (recueil: Recueil): Map<number, string> => {
  const rows = recueil.db
    .select({
      documentId: schema.documentProvenance.documentId,
      sourceRef: schema.documentProvenance.sourceRef,
    })
    .from(schema.documentProvenance)
    .where(like(schema.documentProvenance.sourceRef, `${SOURCE_REF_PREFIX}%`))
    .all();

  const byPaperlessId = new Map<number, string>();
  for (const row of rows) {
    if (row.sourceRef === null) continue;
    const parsed = Number(row.sourceRef.slice(SOURCE_REF_PREFIX.length));
    if (Number.isSafeInteger(parsed)) byPaperlessId.set(parsed, row.documentId);
  }
  return byPaperlessId;
};

export interface AttachmentCorrespondence {
  /** Paperless document id → Recueil `attachments.id`, for the ones that are really there. */
  readonly attachmentIdByPaperlessId: ReadonlyMap<number, string>;
  /** Paperless document id → Recueil `documents.id`. */
  readonly documentIdByPaperlessId: ReadonlyMap<number, string>;
  /**
   * Paperless document ids with an item and a stored blob, but no `attachments` row joining them.
   *
   * The genuine defect condition, and distinct from "the original was never fetched": a document
   * with no blob has nothing to attach, while a blob with no attachment row is a file in the store
   * that no item can reach.
   */
  readonly withoutAttachment: readonly number[];
  /** Paperless document ids with an item but no stored original. Not a defect on its own (P3). */
  readonly withoutDocument: readonly number[];
  /** Paperless document ids with no Recueil item at all, in ascending id order. */
  readonly withoutItem: readonly number[];
}

/**
 * Match every Paperless document to the Recueil rows it became, by querying for them.
 *
 * Used by the verification report to count what is actually in the target, and by a resumed run to
 * decide what it may skip. The two uses want the same answer for opposite reasons, which is a good
 * sign that it belongs in one place.
 */
export const reconcileDocuments = (
  recueil: Recueil,
  paperlessIds: readonly number[],
): AttachmentCorrespondence => {
  const itemIdByPaperlessId = importedItemIds(recueil);
  const documentIdByPaperlessId = importedDocumentIds(recueil);

  const attachmentIdByPaperlessId = new Map<number, string>();
  const withoutAttachment: number[] = [];
  const withoutDocument: number[] = [];
  const withoutItem: number[] = [];

  for (const paperlessId of [...paperlessIds].sort((left, right) => left - right)) {
    const itemId = itemIdByPaperlessId.get(paperlessId);
    if (itemId === undefined) {
      withoutItem.push(paperlessId);
      continue;
    }

    const documentId = documentIdByPaperlessId.get(paperlessId);
    if (documentId === undefined) {
      withoutDocument.push(paperlessId);
      continue;
    }

    const match = recueil.db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(
        and(eq(schema.attachments.itemId, itemId), eq(schema.attachments.documentId, documentId)),
      )
      .get();

    if (match === undefined) withoutAttachment.push(paperlessId);
    else attachmentIdByPaperlessId.set(paperlessId, match.id);
  }

  return {
    attachmentIdByPaperlessId,
    documentIdByPaperlessId,
    withoutAttachment,
    withoutDocument,
    withoutItem,
  };
};

/** The Recueil item behind one Paperless id, or undefined. One query, for a caller with one id. */
export const findItemByPaperlessId = (recueil: Recueil, paperlessId: number): string | undefined =>
  recueil.db
    .select({ id: schema.items.id })
    .from(schema.items)
    .where(
      and(eq(schema.items.sourceSystem, SOURCE_SYSTEM), eq(schema.items.sourceId, String(paperlessId))),
    )
    .get()?.id;
