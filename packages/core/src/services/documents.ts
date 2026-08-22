/**
 * The document service: CONCEPT §5.3 stages 1 and 2, and nothing beyond them yet.
 *
 * The ingestion pipeline of CONCEPT §5.3 has ten stages. Phase 1 implements the first two and the
 * commit, which is the part everything else hangs off:
 *
 *   1. hash, size, MIME type;
 *   2. exact duplicate check against document hashes — link to the existing document, log, stop;
 *   …
 *  10. single transaction commit; events emitted.
 *
 * Archive extraction, OCR, GROBID, resolvers, the rule engine and the confidence gate are Phase 2
 * and later. They all sit between stages 2 and 10 and none of them changes what happens here.
 *
 * The order matters and is the order of the method: **hash, then check, then store, then record**.
 * Hashing first is what makes the duplicate check exact and free (ADR-0004, P2). Storing before
 * recording means a crash between the two leaves an orphan blob — which a garbage report finds and
 * which costs disk — rather than a database row pointing at bytes that were never written, which
 * costs the library its integrity. `LocalFsBackend.put` is itself hash-first and refuses to rewrite
 * an existing blob, so the "store" step for a known hash writes nothing at all.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import {
  attachments,
  documentProvenance,
  documents,
  items,
} from '../db/schema.js';
import type {
  ATTACHMENT_ROLES,
  DOCUMENT_SOURCE_KINDS,
  DocumentProvenanceRow,
  DocumentRow,
} from '../db/schema.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { newId } from '../ids.js';
import { sniffMimeType } from '../mime.js';
import type { StorageBackend } from '../storage/backend.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import { systemActor } from './actor.js';
import type { AuditService } from './audit.js';

export type DocumentSourceKind = (typeof DOCUMENT_SOURCE_KINDS)[number];
export type AttachmentRole = (typeof ATTACHMENT_ROLES)[number];

/**
 * Where these bytes came from (P4).
 *
 * Everything here describes the *arrival*, not the bytes: the same PDF downloaded from a publisher
 * and later mailed by a colleague is one document and two arrivals, and both arrivals are recorded.
 */
export interface IngestProvenance {
  sourceKind: DocumentSourceKind;
  /** Watched-folder path, IMAP message-id, capture URL, importer record id. */
  sourceRef?: string | null;
  /** Sender, subject, scanner id, connector page title, archive member path. */
  sourceDetail?: Record<string, unknown>;
  originalFilename?: string | null;
  /** What the caller claimed. Advisory: the bytes are sniffed and may disagree (§3.3). */
  declaredMimeType?: string | null;
  /** When the arrival happened. Defaults to now; an importer passes the original. */
  observedAt?: string;
  /** The batch that fetched it, when there is one (§6.3). */
  jobId?: string | null;
  actor?: Actor;
  /** Attach the document to an item in the same transaction, which is the common case. */
  attachTo?: { itemId: string; role?: AttachmentRole; title?: string | null };
}

export interface IngestResult {
  document: DocumentRow;
  provenance: DocumentProvenanceRow;
  /** False when these bytes were already in the library — CONCEPT §5.3 stage 2's "link and stop". */
  created: boolean;
  /** Set when `attachTo` was given and an attachment row was written. */
  attachmentId: string | null;
  /** True when the blob was written to the store, false when it was already there. */
  blobWritten: boolean;
}

export class DocumentService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly storage: StorageBackend,
    private readonly audit: AuditService,
  ) {}

  /**
   * Ingest a buffer: hash, check for an exact duplicate, store, record.
   *
   * Idempotent in the way that matters (D1, P9): a second call with the same bytes returns the same
   * document and writes no second `documents` row. It is deliberately *not* idempotent in its
   * provenance — the second arrival is a new fact and gets its own `document_provenance` row, which
   * is how "where did this file come from" survives the deduplication that P2 makes free.
   */
  async ingestBuffer(bytes: Buffer | Uint8Array, provenance: IngestProvenance): Promise<IngestResult> {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const actor = provenance.actor ?? systemActor();

    // Stages 1 and 3: hashing and storing are one pass over the bytes, and the store refuses to
    // rewrite a blob it already holds, so a duplicate costs a hash and nothing else.
    const stored = await this.storage.put(buffer);

    const { mimeType, mimeSource } = sniffMimeType(buffer, {
      declared: provenance.declaredMimeType ?? null,
      filename: provenance.originalFilename ?? null,
    });

    return this.db.transaction((tx) => {
      const now = nowTimestamp();
      const observedAt = provenance.observedAt ?? now;

      // Stage 2: the exact duplicate check. `ux_documents_sha256` is what makes this total.
      const existing = tx.select().from(documents).where(eq(documents.sha256, stored.sha256)).get();
      const created = existing === undefined;

      let document: DocumentRow;
      if (existing === undefined) {
        document = {
          id: newId(),
          sha256: stored.sha256,
          byteSize: stored.size,
          mimeType,
          mimeSource,
          originalFilename: provenance.originalFilename ?? null,
          storageBackend: this.storage.backend,
          storageKey: stored.key,
          storageVerifiedAt: now,
          storageOk: true,
          pageCount: null,
          hasTextLayer: null,
          textExtractedAt: null,
          textCharCount: null,
          ocrStatus: 'not_applicable',
          simhash: null,
          sourceKind: provenance.sourceKind,
          sourceRef: provenance.sourceRef ?? null,
          sourceDetail: JSON.stringify(provenance.sourceDetail ?? {}),
          parentDocumentId: null,
          ingestedAt: observedAt,
          createdAt: now,
          updatedAt: now,
          trashedAt: null,
        };
        tx.insert(documents).values(document).run();
      } else {
        document = existing;
      }

      const provenanceRow: DocumentProvenanceRow = {
        id: newId(),
        documentId: document.id,
        sha256: document.sha256,
        sourceKind: provenance.sourceKind,
        sourceRef: provenance.sourceRef ?? null,
        sourceDetail: JSON.stringify(provenance.sourceDetail ?? {}),
        originalFilename: provenance.originalFilename ?? null,
        declaredMimeType: provenance.declaredMimeType ?? null,
        isFirst: created,
        observedAt,
        jobId: provenance.jobId ?? null,
        createdByUserId: actor.userId ?? null,
        createdAt: now,
      };
      tx.insert(documentProvenance).values(provenanceRow).run();

      let attachmentId: string | null = null;
      if (provenance.attachTo !== undefined) {
        attachmentId = this.attachInTransaction(tx, {
          itemId: provenance.attachTo.itemId,
          documentId: document.id,
          role: provenance.attachTo.role ?? 'primary',
          title: provenance.attachTo.title ?? provenance.originalFilename ?? null,
          actor,
          now,
        });
      }

      this.audit.record(
        {
          actor,
          action: created ? 'document.ingested' : 'document.duplicate_ingested',
          entityType: 'document',
          entityId: document.id,
          after: {
            sha256: document.sha256,
            byteSize: document.byteSize,
            mimeType: document.mimeType,
            sourceKind: provenance.sourceKind,
            sourceRef: provenance.sourceRef ?? null,
            provenanceId: provenanceRow.id,
            ...(attachmentId === null ? {} : { attachmentId }),
          },
          reason: created
            ? null
            : 'these bytes were already in the library; linked the existing document (D1, CONCEPT §5.3 stage 2)',
        },
        tx,
      );

      return {
        document,
        provenance: provenanceRow,
        created,
        attachmentId,
        blobWritten: stored.created,
      };
    });
  }

  /** Every recorded arrival of one document's bytes, newest first (P4). */
  provenanceFor(documentId: string): DocumentProvenanceRow[] {
    return this.db
      .select()
      .from(documentProvenance)
      .where(eq(documentProvenance.documentId, documentId))
      .orderBy(desc(documentProvenance.observedAt), desc(documentProvenance.id))
      .all();
  }

  getDocument(id: string): DocumentRow {
    const row = this.db.select().from(documents).where(eq(documents.id, id)).get();
    if (row === undefined) throw new NotFoundError('document', id);
    return row;
  }

  /** Lookup by the identity (ADR-0004). Null rather than a throw: "is this known" is a question. */
  findBySha256(sha256: string): DocumentRow | null {
    return this.db.select().from(documents).where(eq(documents.sha256, sha256)).get() ?? null;
  }

  /** The bytes themselves. */
  async readBuffer(id: string): Promise<Buffer> {
    return this.storage.getBuffer(this.getDocument(id).sha256);
  }

  /**
   * Attach a known document to an item (§3.8).
   *
   * Attaching an already-known file creates an `attachments` row and no `documents` row (AT1): two
   * items citing the same supplementary dataset share one blob.
   */
  attachDocument(
    input: { itemId: string; documentId: string; role?: AttachmentRole; title?: string | null },
    actor: Actor,
  ): string {
    return this.db.transaction((tx) => {
      const now = nowTimestamp();
      const attachmentId = this.attachInTransaction(tx, {
        itemId: input.itemId,
        documentId: input.documentId,
        role: input.role ?? 'primary',
        title: input.title ?? null,
        actor,
        now,
      });

      this.audit.record(
        {
          actor,
          action: 'attachment.added',
          entityType: 'attachment',
          entityId: attachmentId,
          after: { itemId: input.itemId, documentId: input.documentId, role: input.role ?? 'primary' },
        },
        tx,
      );

      return attachmentId;
    });
  }

  private attachInTransaction(
    tx: Pick<RecueilDatabase, 'select' | 'insert'>,
    input: {
      itemId: string;
      documentId: string;
      role: AttachmentRole;
      title: string | null;
      actor: Actor;
      now: string;
    },
  ): string {
    const item = tx.select({ id: items.id }).from(items).where(eq(items.id, input.itemId)).get();
    if (item === undefined) throw new NotFoundError('item', input.itemId);

    const alreadyThere = tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.itemId, input.itemId),
          eq(attachments.documentId, input.documentId),
          isNull(attachments.trashedAt),
        ),
      )
      .get();
    if (alreadyThere !== undefined) return alreadyThere.id;

    // ux_attachments_primary allows one primary per item; a second file becomes a supplement rather
    // than failing the whole ingest on a constraint the caller did not ask about.
    let role = input.role;
    if (role === 'primary') {
      const existingPrimary = tx
        .select({ id: attachments.id })
        .from(attachments)
        .where(
          and(
            eq(attachments.itemId, input.itemId),
            eq(attachments.role, 'primary'),
            isNull(attachments.trashedAt),
          ),
        )
        .get();
      if (existingPrimary !== undefined) role = 'supplement';
    }

    const position =
      tx.select({ id: attachments.id }).from(attachments).where(eq(attachments.itemId, input.itemId)).all()
        .length;

    const id = newId();
    try {
      tx.insert(attachments)
        .values({
          id,
          itemId: input.itemId,
          documentId: input.documentId,
          role,
          linkMode: 'stored',
          title: input.title,
          url: null,
          linkedPath: null,
          contentTypeHint: null,
          hasAnnotations: false,
          annotationCount: 0,
          position,
          addedAt: input.now,
          addedByUserId: input.actor.userId ?? null,
          source: 'ingest',
          updatedAt: input.now,
          trashedAt: null,
        })
        .run();
    } catch (error) {
      throw new ConflictError(
        `Could not attach document '${input.documentId}' to item '${input.itemId}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        { itemId: input.itemId, documentId: input.documentId },
      );
    }
    return id;
  }
}
