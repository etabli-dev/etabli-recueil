/**
 * The review queue's write side: accept, accept-with-edits, reject, and accept in bulk.
 *
 * `@recueil/ingest` owns raising an entry — that happens inside the pipeline's own transaction, at
 * stage 9 — and stops there. Resolving one is an HTTP-surface operation, because RQ1 says
 * "accepting an entry executes `proposed_payload` through the normal API path, so the action is
 * audited like any other write. The queue never has a private mutation route."
 *
 * Three properties this module is responsible for.
 *
 * **Atomic.** The item and the resolution commit together. `commitProposal` opens a transaction of
 * its own; nesting it inside this one becomes a savepoint, so a failure anywhere — a bad collection
 * id, a duplicate ASN, a constraint on a custom field — leaves the entry open and no item created.
 * The alternative, two transactions in sequence, has a window in which the library holds an item
 * whose review entry still says "nobody has looked at this".
 *
 * **Audited, with what was executed.** `resolution_payload` holds the proposal as actually run,
 * which is not always `proposed_payload`: accept-with-edits changes it, and the difference between
 * what the machine proposed and what the person accepted is the most interesting thing in the
 * queue. §6.1's column exists for exactly this and is filled.
 *
 * **Honest about what accept can do.** §6.1 lists seven proposed actions; this build can execute
 * three of them — `create_item`, `discard` and `none`. The other four are refused with a 409 that
 * names the action, rather than marking the entry accepted and doing nothing, which would empty
 * the queue without doing the work.
 */
import { ConflictError, NotFoundError, nowTimestamp, schema as coreSchema } from '@recueil/core';
import type { Actor, Recueil } from '@recueil/core';
import { ReviewQueueService, commitProposal, emptyProposal, reviewQueue } from '@recueil/ingest';
import type { ItemProposal, JsonValue, ReviewQueueRow } from '@recueil/ingest';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { assertAsnFree, withAsnConflict } from '../office.js';
import type * as z from 'zod';

import type { ReviewEntrySchema } from '../schemas-ingestion.js';

/** What the pipeline puts in `proposed_payload` for a `create_item` entry. */
interface ProposedItemPayload {
  itemType?: string;
  fields?: Record<string, JsonValue>;
  creators?: Array<{
    role: string;
    family?: string | null;
    given?: string | null;
    literal?: string | null;
    sequence: number;
  }>;
  tags?: string[];
  collectionIds?: string[];
  customFields?: Record<string, JsonValue>;
  notes?: string[];
  confidence?: number;
}

export interface ReviewEdits {
  itemType?: string;
  fields?: Record<string, JsonValue>;
  tags?: string[];
  collectionIds?: string[];
  customFields?: Record<string, JsonValue>;
  notes?: string[];
}

export interface AcceptResult {
  entry: ReviewQueueRow;
  itemId: string | null;
  attachmentId: string | null;
  warnings: string[];
}

export interface ListReviewFilter {
  status?: ReviewQueueRow['status'];
  reasonCode?: string;
  subjectType?: ReviewQueueRow['subjectType'];
  subjectId?: string;
  jobId?: string;
  severity?: ReviewQueueRow['severity'];
  limit?: number;
  order?: 'asc' | 'desc';
}

/** The proposed actions this build can actually execute. */
export const EXECUTABLE_ACTIONS = ['create_item', 'discard', 'none'] as const;

export class ReviewService {
  private readonly queue: ReviewQueueService;

  constructor(private readonly recueil: Recueil) {
    this.queue = new ReviewQueueService(recueil.db, recueil.audit);
  }

  list(filter: ListReviewFilter = {}): ReviewQueueRow[] {
    const clauses = [];
    if (filter.status !== undefined) clauses.push(eq(reviewQueue.status, filter.status));
    if (filter.reasonCode !== undefined) clauses.push(eq(reviewQueue.reasonCode, filter.reasonCode));
    if (filter.subjectType !== undefined) clauses.push(eq(reviewQueue.subjectType, filter.subjectType));
    if (filter.subjectId !== undefined) clauses.push(eq(reviewQueue.subjectId, filter.subjectId));
    if (filter.jobId !== undefined) clauses.push(eq(reviewQueue.jobId, filter.jobId));
    if (filter.severity !== undefined) clauses.push(eq(reviewQueue.severity, filter.severity));

    const query = this.recueil.db.select().from(reviewQueue);
    const filtered = clauses.length === 0 ? query : query.where(and(...clauses));
    return filtered
      .orderBy(filter.order === 'asc' ? asc(reviewQueue.createdAt) : desc(reviewQueue.createdAt))
      .limit(filter.limit ?? 50)
      .all();
  }

  get(id: string): ReviewQueueRow {
    const row = this.recueil.db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).get();
    if (row === undefined) throw new NotFoundError('review queue entry', id);
    return row;
  }

  /** How many entries are open, per severity. What a badge in the UI reads. */
  openCounts(): Record<'info' | 'warning' | 'blocker', number> {
    const rows = this.recueil.connection
      .prepare(`select severity, count(*) as n from review_queue where status = 'open' group by severity`)
      .all() as { severity: 'info' | 'warning' | 'blocker'; n: number }[];
    const counts = { info: 0, warning: 0, blocker: 0 };
    for (const row of rows) counts[row.severity] = row.n;
    return counts;
  }

  /**
   * Accept one entry, executing its proposal.
   *
   * `edits` replaces parts of the proposal before it runs; `fields` and `customFields` are patches
   * over the proposal's own maps, where a `null` removes the entry, and everything else replaces
   * wholesale. What actually ran is stored in `resolution_payload`.
   */
  accept(id: string, input: { actor: Actor; note?: string; edits?: ReviewEdits }): AcceptResult {
    return this.recueil.db.transaction((tx): AcceptResult => {
      const entry = tx.select().from(reviewQueue).where(eq(reviewQueue.id, id)).get();
      if (entry === undefined) throw new NotFoundError('review queue entry', id);
      if (entry.status !== 'open') {
        throw new ConflictError(
          `Review entry '${id}' is already ${entry.status}. Only an open entry can be accepted.`,
          { reviewEntryId: id, status: entry.status },
        );
      }

      const action = entry.proposedAction ?? 'none';
      if (!(EXECUTABLE_ACTIONS as readonly string[]).includes(action)) {
        throw new ConflictError(
          `This build cannot execute the proposed action '${action}'. It can execute ` +
            `${EXECUTABLE_ACTIONS.join(', ')}; '${action}' arrives with the phase that implements ` +
            'it. Reject the entry, or resolve the situation directly and let the next run supersede it.',
          { reviewEntryId: id, proposedAction: action },
        );
      }

      const executed =
        action === 'create_item'
          ? this.executeCreateItem(entry, input.actor, input.edits)
          : action === 'discard'
            ? this.executeDiscard(entry, input.actor)
            : { itemId: null, attachmentId: null, warnings: [], payload: null as unknown };

      const now = nowTimestamp();
      const patch = {
        status: 'accepted' as const,
        resolvedAt: now,
        resolvedByUserId: input.actor.userId ?? this.recueil.user.id,
        resolutionNote: input.note ?? null,
        resolutionPayload: executed.payload === null ? null : JSON.stringify(executed.payload),
        updatedAt: now,
      };
      tx.update(reviewQueue).set(patch).where(eq(reviewQueue.id, id)).run();

      this.recueil.audit.record(
        {
          actor: input.actor,
          action: 'review_queue.accepted',
          entityType: 'review_queue_entry',
          entityId: id,
          before: { status: entry.status, proposedAction: entry.proposedAction },
          after: {
            status: 'accepted',
            itemId: executed.itemId,
            attachmentId: executed.attachmentId,
            edited: input.edits !== undefined,
          },
          reason: input.note ?? `accepted: ${action}`,
        },
        tx,
      );

      return {
        entry: { ...entry, ...patch },
        itemId: executed.itemId,
        attachmentId: executed.attachmentId,
        warnings: executed.warnings,
      };
    });
  }

  /** Reject one entry. Nothing is executed and nothing is created; the reason is recorded. */
  reject(id: string, input: { actor: Actor; note?: string }): ReviewQueueRow {
    return this.recueil.db.transaction((tx): ReviewQueueRow => {
      const entry = tx.select().from(reviewQueue).where(eq(reviewQueue.id, id)).get();
      if (entry === undefined) throw new NotFoundError('review queue entry', id);
      if (entry.status !== 'open') {
        throw new ConflictError(
          `Review entry '${id}' is already ${entry.status}. Only an open entry can be rejected.`,
          { reviewEntryId: id, status: entry.status },
        );
      }

      const now = nowTimestamp();
      const patch = {
        status: 'rejected' as const,
        resolvedAt: now,
        resolvedByUserId: input.actor.userId ?? this.recueil.user.id,
        resolutionNote: input.note ?? null,
        updatedAt: now,
      };
      tx.update(reviewQueue).set(patch).where(eq(reviewQueue.id, id)).run();

      this.recueil.audit.record(
        {
          actor: input.actor,
          action: 'review_queue.rejected',
          entityType: 'review_queue_entry',
          entityId: id,
          before: { status: entry.status },
          after: { status: 'rejected' },
          reason: input.note ?? 'rejected without a note',
        },
        tx,
      );

      return { ...entry, ...patch };
    });
  }

  /**
   * Accept several.
   *
   * Each in its own transaction, deliberately: a hundred scans reviewed at once should not all be
   * rolled back because the fiftieth one hits a duplicate ASN. The response says which landed and
   * why each of the others did not, so nothing is silently skipped.
   */
  bulkAccept(
    ids: readonly string[],
    input: { actor: Actor; note?: string },
  ): { accepted: AcceptResult[]; refused: { id: string; code: string; detail: string }[] } {
    const accepted: AcceptResult[] = [];
    const refused: { id: string; code: string; detail: string }[] = [];

    // Fetch first, so an id that is not an entry at all is reported before anything is executed.
    const known = new Set(
      this.recueil.db
        .select({ id: reviewQueue.id })
        .from(reviewQueue)
        .where(inArray(reviewQueue.id, [...ids]))
        .all()
        .map((row) => row.id),
    );

    for (const id of ids) {
      if (!known.has(id)) {
        refused.push({ id, code: 'not_found', detail: 'no review queue entry with this id' });
        continue;
      }
      try {
        accepted.push(this.accept(id, input));
      } catch (error) {
        refused.push({
          id,
          code: error instanceof ConflictError ? 'conflict' : 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { accepted, refused };
  }

  /* ---- the executions ------------------------------------------------------------------------ */

  private executeCreateItem(
    entry: ReviewQueueRow,
    actor: Actor,
    edits: ReviewEdits | undefined,
  ): { itemId: string; attachmentId: string; warnings: string[]; payload: unknown } {
    if (entry.subjectType !== 'document') {
      throw new ConflictError(
        `A 'create_item' proposal is executed against a document; this entry's subject is a ` +
          `${entry.subjectType}.`,
        { reviewEntryId: entry.id, subjectType: entry.subjectType },
      );
    }

    const document = this.recueil.db
      .select()
      .from(coreSchema.documents)
      .where(eq(coreSchema.documents.id, entry.subjectId))
      .get();
    if (document === undefined) {
      throw new ConflictError(
        `The document '${entry.subjectId}' this entry is about is no longer in the library, so ` +
          'there is nothing to file. Reject the entry.',
        { reviewEntryId: entry.id, documentId: entry.subjectId },
      );
    }

    const payload = parsePayload(entry.proposedPayload);
    const proposal = buildProposal(payload, edits, entry.confidence);

    // The office facet's ASN is unique across live items, and accepting is one of the two ways a
    // person can collide with that (the other is editing an item). Checked here for the message and
    // translated around the commit for the race — the same pair `routes/items.ts` uses. The whole
    // accept is inside one transaction, so a collision leaves the entry open and no item created.
    const asn = readAsn(proposal.fields['office.asn']?.value);
    assertAsnFree(this.recueil, asn);

    const result = withAsnConflict(this.recueil, asn, () =>
      commitProposal({
        recueil: this.recueil,
        reviewQueue: this.queue,
        actor,
        documentId: document.id,
        sha256: document.sha256,
        proposal,
        attachmentRole: document.sourceKind === 'scanner' ? 'scan' : 'primary',
        // The provenance of every field says a person accepted it, not that a rule guessed it: an
        // accepted value has been looked at, and P4-1 reserves the lock for a human's edit.
        provenanceSource: edits === undefined ? 'review:accepted' : 'review:accepted-with-edits',
        ...(entry.jobId === null ? {} : { runId: entry.jobId }),
        sourceStage: 'review.accept',
      }),
    );

    return {
      itemId: result.itemId,
      attachmentId: result.attachmentId,
      warnings: result.warnings,
      payload: {
        action: 'create_item',
        itemType: proposal.itemType,
        fields: Object.fromEntries(
          Object.entries(proposal.fields).map(([path, field]) => [path, field.value]),
        ),
        tags: proposal.tags,
        collectionIds: proposal.collectionIds,
        customFields: proposal.customFields,
        notes: proposal.notes,
        itemId: result.itemId,
        attachmentId: result.attachmentId,
      },
    };
  }

  /**
   * Discard: the document is filed nowhere, on purpose.
   *
   * Trashed rather than deleted (P5), so a scanner's blank separator page accepted as a discard is
   * still recoverable, and the blob is never removed — reclaiming storage is a separate, explicit
   * operation (AT2).
   */
  private executeDiscard(
    entry: ReviewQueueRow,
    actor: Actor,
  ): { itemId: null; attachmentId: null; warnings: string[]; payload: unknown } {
    if (entry.subjectType !== 'document') {
      throw new ConflictError(
        `A 'discard' proposal is executed against a document; this entry's subject is a ` +
          `${entry.subjectType}.`,
        { reviewEntryId: entry.id, subjectType: entry.subjectType },
      );
    }

    const warnings: string[] = [];
    try {
      this.recueil.documents.trashDocument(entry.subjectId, actor, {
        reason: 'user',
        reasonDetail: `discarded from the review queue (entry ${entry.id})`,
      });
    } catch (error) {
      // D4: a document with a live attachment cannot be trashed. That is not a reason to refuse the
      // discard — the operator's decision stands — but it is emphatically something to report.
      warnings.push(
        `the document was not trashed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      itemId: null,
      attachmentId: null,
      warnings,
      payload: { action: 'discard', documentId: entry.subjectId, trashed: warnings.length === 0 },
    };
  }
}

/** An ASN out of a proposal field, whatever JSON shape it arrived as. */
const readAsn = (value: JsonValue | undefined): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number.parseInt(value, 10);
  return null;
};

/** The stored payload, or an empty one. A row with unparseable JSON is a bug, not a crash. */
const parsePayload = (raw: string | null): ProposedItemPayload => {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ProposedItemPayload)
      : {};
  } catch {
    return {};
  }
};

/**
 * The proposal the pipeline would have committed, plus the operator's edits.
 *
 * Provenance is stamped here rather than carried from the pipeline's own proposal, because the
 * payload is deliberately flat — §6.1 stores "exactly the request body that accept will execute",
 * not the pipeline's internal representation with a provenance object per field.
 */
export const buildProposal = (
  payload: ProposedItemPayload,
  edits: ReviewEdits | undefined,
  confidence: number | null,
): ItemProposal => {
  const proposal = emptyProposal();
  const fetchedAt = nowTimestamp();
  const score = confidence ?? payload.confidence ?? 0.5;

  const fields: Record<string, JsonValue> = { ...(payload.fields ?? {}) };
  for (const [path, value] of Object.entries(edits?.fields ?? {})) {
    if (value === null) delete fields[path];
    else fields[path] = value;
  }
  for (const [path, value] of Object.entries(fields)) {
    proposal.fields[path] = {
      value,
      provenance: { source: 'review:accepted', fetchedAt, confidence: score },
    };
  }

  const customFields: Record<string, JsonValue> = { ...(payload.customFields ?? {}) };
  for (const [key, value] of Object.entries(edits?.customFields ?? {})) {
    if (value === null) delete customFields[key];
    else customFields[key] = value;
  }

  proposal.itemType = edits?.itemType ?? payload.itemType ?? 'document';
  proposal.tags = [...(edits?.tags ?? payload.tags ?? [])];
  proposal.collectionIds = [...(edits?.collectionIds ?? payload.collectionIds ?? [])];
  proposal.customFields = customFields;
  proposal.notes = [...(edits?.notes ?? payload.notes ?? [])];
  proposal.creators = (payload.creators ?? []).map((creator) => ({
    role: creator.role,
    ...(creator.family === null || creator.family === undefined ? {} : { family: creator.family }),
    ...(creator.given === null || creator.given === undefined ? {} : { given: creator.given }),
    ...(creator.literal === null || creator.literal === undefined ? {} : { literal: creator.literal }),
    sequence: creator.sequence,
    provenance: { source: 'review:accepted', fetchedAt, confidence: score },
  }));
  // An accepted proposal is one a person has looked at, so it enters at the score the gate would
  // have wanted rather than at the score that failed it. The audit row and `resolution_payload`
  // record who decided that.
  proposal.confidence = 1;

  return proposal;
};

/** The wire shape of one entry. Typed by the published schema, so the two cannot drift. */
export const reviewEntryToWire = (row: ReviewQueueRow): z.input<typeof ReviewEntrySchema> => ({
  id: row.id,
  subjectType: row.subjectType,
  subjectId: row.subjectId,
  secondarySubjectType: row.secondarySubjectType,
  secondarySubjectId: row.secondarySubjectId,
  reasonCode: row.reasonCode,
  explanation: row.explanation,
  proposedAction: row.proposedAction,
  proposedPayload: row.proposedPayload === null ? null : (JSON.parse(row.proposedPayload) as unknown),
  confidence: row.confidence,
  severity: row.severity,
  status: row.status,
  sourceStage: row.sourceStage,
  jobId: row.jobId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  resolvedAt: row.resolvedAt,
  resolutionNote: row.resolutionNote,
  resolutionPayload:
    row.resolutionPayload === null ? null : (JSON.parse(row.resolutionPayload) as unknown),
});
