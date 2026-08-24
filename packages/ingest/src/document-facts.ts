/**
 * Writing back what the pipeline learned about the bytes.
 *
 * `documents` already carries the Phase 2 columns — `has_text_layer`, `text_extracted_at`,
 * `text_char_count`, `ocr_status`, `page_count`, `simhash`, `parent_document_id` — because
 * `0000_core` created them. What core does not have yet is a service method that sets them:
 * `DocumentService` is explicit that it implements "stages 1 and 2, and nothing beyond them".
 *
 * So this module writes those columns directly, and does exactly that and nothing more. It is
 * deliberately small and deliberately in one place, so that the day `DocumentService` grows a
 * `recordExtraction` method the change is one import. Every write here is audited like any other,
 * because a column that says a document has no text layer is a claim about the library and P5
 * applies to claims.
 */
import { nowTimestamp, schema } from '@recueil/core';
import type { Actor, Recueil } from '@recueil/core';
import { eq } from 'drizzle-orm';

type OcrStatus = (typeof schema.OCR_STATUSES)[number];

export interface DocumentFacts {
  hasTextLayer?: boolean;
  textCharCount?: number;
  pageCount?: number | null;
  ocrStatus?: OcrStatus;
  simhash?: string | null;
  /** The archive this document was extracted from (CONCEPT §5.3 stage 3). */
  parentDocumentId?: string | null;
  /** True when `textCharCount` reflects text that was actually extracted just now. */
  textExtracted?: boolean;
}

/**
 * Record what stages 4 to 6 found. Returns the columns that changed, so a caller can log them.
 *
 * Callable inside the stage-10 transaction — pass nothing special, the nested `db.transaction`
 * becomes a savepoint — and outside it, which is where the OCR result is written so that a resumed
 * run can see it without re-running the engine.
 */
export const recordDocumentFacts = (
  recueil: Recueil,
  documentId: string,
  facts: DocumentFacts,
  actor: Actor,
): Record<string, unknown> =>
  recueil.db.transaction((tx) => {
    const current = tx.select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (current === undefined) {
      throw new Error(`Cannot record facts for document '${documentId}': it is not in the library.`);
    }

    const now = nowTimestamp();
    const patch: Record<string, unknown> = {};

    if (facts.hasTextLayer !== undefined && facts.hasTextLayer !== current.hasTextLayer) {
      patch['hasTextLayer'] = facts.hasTextLayer;
    }
    if (facts.textCharCount !== undefined && facts.textCharCount !== current.textCharCount) {
      patch['textCharCount'] = facts.textCharCount;
    }
    if (facts.textExtracted === true) patch['textExtractedAt'] = now;
    if (facts.pageCount !== undefined && facts.pageCount !== current.pageCount) {
      patch['pageCount'] = facts.pageCount;
    }
    if (facts.ocrStatus !== undefined && facts.ocrStatus !== current.ocrStatus) {
      patch['ocrStatus'] = facts.ocrStatus;
    }
    if (facts.simhash !== undefined && facts.simhash !== current.simhash) {
      patch['simhash'] = facts.simhash;
    }
    if (
      facts.parentDocumentId !== undefined &&
      facts.parentDocumentId !== current.parentDocumentId &&
      // `parent_document_id` records where the bytes came from the first time. A second arrival of
      // the same bytes from a different archive does not rewrite it: the first archive is still
      // where the document entered the library, and the later arrival is a `document_provenance`
      // row, which is exactly the distinction that table exists to keep.
      current.parentDocumentId === null
    ) {
      patch['parentDocumentId'] = facts.parentDocumentId;
    }

    if (Object.keys(patch).length === 0) return {};

    patch['updatedAt'] = now;
    tx.update(schema.documents).set(patch).where(eq(schema.documents.id, documentId)).run();

    recueil.audit.record(
      {
        actor,
        action: 'document.examined',
        entityType: 'document',
        entityId: documentId,
        after: patch,
        reason: 'the ingestion pipeline recorded what stages 4 to 6 found in these bytes',
      },
      tx,
    );

    return patch;
  });
