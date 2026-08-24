/**
 * Finding, by query, which Recueil row a Zotero row became.
 *
 * The importer knows the correspondence while it runs, in a `Map` in the process. That knowledge is
 * worth nothing to two of the people who need it: a resumed run in a *new* process, and the
 * verification report. Both have to rediscover it from the two databases — and for the report that
 * is not an inconvenience but the whole point. A check that counts the importer's own log entries
 * cannot fail, and a report full of checks that cannot fail is worse than no report, because it
 * reads as evidence.
 *
 * So the correspondence is reconstructed here, from facts the databases hold:
 *
 * - **Items.** `items.source_system = 'zotero'` and `items.source_id = <Zotero item key>`. One
 *   query, one index.
 * - **Attachments.** No column carries the Zotero attachment key, so the link is rebuilt the way
 *   the importer wrote it: `document_provenance.source_ref = 'zotero:<key>'` gives the document,
 *   and the attachment is the row on the host item that points at that document. For an attachment
 *   with no document — a bookmark, or a linked file left as a link — the match is on `url` or
 *   `linked_path`, which is the value the importer put there and is likewise a fact in the target.
 *
 * Nothing here reads `job_logs`, and nothing here consults the running import.
 */
import { schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { and, eq, like } from 'drizzle-orm';

import { resolveAttachment } from './attachments.js';
import type { AttachmentSources } from './attachments.js';
import type { ZoteroLibrary } from './reader/zotero-library.js';

/** `items.source_system` for everything this importer writes. Mirrors `import.ts`. */
const SOURCE_SYSTEM = 'zotero';

/** Zotero item key → Recueil item id, for every item the target says came from this library. */
export const importedItemIds = (recueil: Recueil): Map<string, string> => {
  const rows = recueil.db
    .select({ id: schema.items.id, sourceId: schema.items.sourceId })
    .from(schema.items)
    .where(eq(schema.items.sourceSystem, SOURCE_SYSTEM))
    .all();

  const byKey = new Map<string, string>();
  for (const row of rows) {
    if (row.sourceId !== null) byKey.set(row.sourceId, row.id);
  }
  return byKey;
};

/** Zotero attachment key → Recueil document id, from `document_provenance`. */
export const importedDocumentIds = (recueil: Recueil): Map<string, string> => {
  const rows = recueil.db
    .select({
      documentId: schema.documentProvenance.documentId,
      sourceRef: schema.documentProvenance.sourceRef,
    })
    .from(schema.documentProvenance)
    .where(like(schema.documentProvenance.sourceRef, 'zotero:%'))
    .all();

  const byKey = new Map<string, string>();
  for (const row of rows) {
    if (row.sourceRef !== null) byKey.set(row.sourceRef.slice('zotero:'.length), row.documentId);
  }
  return byKey;
};

export interface AttachmentCorrespondence {
  /** Zotero attachment key → Recueil `attachments.id`, for the ones that are really there. */
  readonly attachmentIdByKey: ReadonlyMap<string, string>;
  /** Zotero attachment key → Recueil `documents.id`. */
  readonly documentIdByKey: ReadonlyMap<string, string>;
  /** Zotero attachment keys with no Recueil attachment row, in source order. */
  readonly missing: readonly string[];
}

/**
 * Match every Zotero attachment to the Recueil `attachments` row it became, by querying for it.
 *
 * Used by the resumed import to rebuild its map, and by the verification report to count what is
 * actually in the target. The two uses want the same answer for opposite reasons, which is a good
 * sign that it belongs in one place.
 */
export const reconcileAttachments = (
  recueil: Recueil,
  library: ZoteroLibrary,
  sources: AttachmentSources,
): AttachmentCorrespondence => {
  const itemIdByKey = importedItemIds(recueil);
  const documentIdByKey = importedDocumentIds(recueil);

  const attachmentIdByKey = new Map<string, string>();
  const missing: string[] = [];

  const fieldValues = library.fieldValues();
  const itemsById = library.itemsById();

  for (const attachment of library.attachments()) {
    const zoteroItem = itemsById.get(attachment.itemID);
    if (zoteroItem === undefined) continue;

    // A child attachment hangs off its parent's item; a standalone one off the host item the
    // importer created for it, which carries the attachment's own key as its `source_id`.
    const parentKey =
      attachment.parentItemID === null ? null : (itemsById.get(attachment.parentItemID)?.key ?? null);
    const hostItemId = itemIdByKey.get(parentKey ?? zoteroItem.key);
    if (hostItemId === undefined) {
      missing.push(zoteroItem.key);
      continue;
    }

    const rows = recueil.db
      .select({
        id: schema.attachments.id,
        documentId: schema.attachments.documentId,
        url: schema.attachments.url,
        linkedPath: schema.attachments.linkedPath,
      })
      .from(schema.attachments)
      .where(eq(schema.attachments.itemId, hostItemId))
      .all();

    const documentId = documentIdByKey.get(zoteroItem.key);
    if (documentId !== undefined) {
      const match = rows.find((row) => row.documentId === documentId);
      if (match === undefined) missing.push(zoteroItem.key);
      else attachmentIdByKey.set(zoteroItem.key, match.id);
      continue;
    }

    const resolution = resolveAttachment(attachment, zoteroItem.key, sources);
    const expected =
      resolution.status === 'resolved'
        ? resolution.source
        : (resolution.expectedPath ?? `zotero:${zoteroItem.key}/${resolution.filename ?? ''}`);
    const url =
      fieldValues.get(attachment.itemID)?.find((field) => field.baseField === 'url')?.value ?? null;

    const match = rows.find((row) =>
      attachment.linkMode === 3 ? row.url === url : row.linkedPath === expected,
    );
    if (match === undefined) missing.push(zoteroItem.key);
    else attachmentIdByKey.set(zoteroItem.key, match.id);
  }

  return { attachmentIdByKey, documentIdByKey, missing };
};

/** The Recueil item behind one Zotero key, or undefined. One query, for a caller with one key. */
export const findItemByZoteroKey = (recueil: Recueil, key: string): string | undefined =>
  recueil.db
    .select({ id: schema.items.id })
    .from(schema.items)
    .where(and(eq(schema.items.sourceSystem, SOURCE_SYSTEM), eq(schema.items.sourceId, key)))
    .get()?.id;
