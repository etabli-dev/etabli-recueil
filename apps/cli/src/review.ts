/**
 * Resolving a review queue entry from the command line.
 *
 * `@recueil/ingest` owns *raising* an entry: that happens inside the pipeline's own transaction at
 * stage 9, and `ReviewQueueService` stops there deliberately. Resolving one is a decision, and this
 * file is the CLI's implementation of it, over the library, in one transaction.
 *
 * **This duplicates `apps/server/src/ingestion/review.ts` and should not stay duplicated.** The
 * server's `ReviewService` does the same three things — execute `create_item`, execute `discard`,
 * refuse anything else — and adds accept-with-edits and bulk accept on top. The CLI cannot call it
 * today because `@recueil/server` exports `buildApp` and its configuration and nothing from
 * `ingestion/`; the moment it exports `ReviewService`, this file should be deleted and the command
 * should construct that instead. Two implementations of "accept" are two things that can disagree,
 * and P6 ("nothing is UI-only") is about there being one implementation, not two that match today.
 *
 * What is kept identical on purpose, because it is the part that would be dangerous to get wrong:
 *
 * - **Atomic.** The item and the resolution commit together. `commitProposal` opens a transaction
 *   which nests here as a savepoint, so a failed commit leaves the entry open and no item created.
 * - **Only an open entry can be resolved**, and only the three proposed actions this build can
 *   actually execute are executed. The other four are refused by name rather than marked accepted
 *   and quietly skipped, which would empty the queue without doing the work.
 * - **`resolution_payload` holds what was executed**, so the audit trail says what the person
 *   agreed to and not merely that they agreed.
 */
import { ConflictError, NotFoundError, nowTimestamp, schema } from '@recueil/core';
import type { Actor, Recueil } from '@recueil/core';
import {
  ReviewQueueService,
  commitProposal,
  emptyProposal,
  ensureIngestSchema,
  reviewQueue,
} from '@recueil/ingest';
import type { ItemProposal, JsonValue, ReviewQueueRow } from '@recueil/ingest';
import { and, asc, desc, eq } from 'drizzle-orm';

/** The proposed actions this build can execute (`spec/data-model.md` §6.1 lists seven). */
export const EXECUTABLE_ACTIONS = ['create_item', 'discard', 'none'] as const;

/** What the pipeline writes into `proposed_payload` for a `create_item` entry. */
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

export interface AcceptResult {
  entry: ReviewQueueRow;
  itemId: string | null;
  attachmentId: string | null;
  warnings: string[];
}

export interface ListFilter {
  status?: ReviewQueueRow['status'];
  reasonCode?: string;
  severity?: ReviewQueueRow['severity'];
  subjectId?: string;
  jobId?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

export class CliReviewQueue {
  private readonly queue: ReviewQueueService;

  constructor(private readonly recueil: Recueil) {
    // A library that has never been ingested into has no `review_queue` table: it is installed by
    // `@recueil/ingest` rather than by core's migration series until `spec/data-model.md` §11
    // lands it there. Installing it here means `recueil review list` answers "nothing to review"
    // instead of "no such table".
    ensureIngestSchema(recueil.connection);
    this.queue = new ReviewQueueService(recueil.db, recueil.audit);
  }

  list(filter: ListFilter = {}): ReviewQueueRow[] {
    const clauses = [];
    if (filter.status !== undefined) clauses.push(eq(reviewQueue.status, filter.status));
    if (filter.reasonCode !== undefined) clauses.push(eq(reviewQueue.reasonCode, filter.reasonCode));
    if (filter.severity !== undefined) clauses.push(eq(reviewQueue.severity, filter.severity));
    if (filter.subjectId !== undefined) clauses.push(eq(reviewQueue.subjectId, filter.subjectId));
    if (filter.jobId !== undefined) clauses.push(eq(reviewQueue.jobId, filter.jobId));

    const query = this.recueil.db.select().from(reviewQueue);
    const filtered = clauses.length === 0 ? query : query.where(and(...clauses));
    return filtered
      .orderBy(filter.order === 'desc' ? desc(reviewQueue.createdAt) : asc(reviewQueue.createdAt))
      .limit(filter.limit ?? 50)
      .all();
  }

  get(id: string): ReviewQueueRow {
    const row = this.recueil.db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).get();
    if (row === undefined) throw new NotFoundError('review queue entry', id);
    return row;
  }

  /** Open entries per severity — the number a prompt or a badge shows. */
  openCounts(): Record<'info' | 'warning' | 'blocker', number> {
    const rows = this.recueil.connection
      .prepare(`select severity, count(*) as n from review_queue where status = 'open' group by severity`)
      .all() as { severity: 'info' | 'warning' | 'blocker'; n: number }[];
    const counts = { info: 0, warning: 0, blocker: 0 };
    for (const row of rows) counts[row.severity] = row.n;
    return counts;
  }

  accept(id: string, input: { actor: Actor; note?: string }): AcceptResult {
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
            `${EXECUTABLE_ACTIONS.join(', ')}. Reject the entry, or resolve the situation directly ` +
            'and let the next run supersede it.',
          { reviewEntryId: id, proposedAction: action },
        );
      }

      const executed =
        action === 'create_item'
          ? this.executeCreateItem(entry, input.actor)
          : action === 'discard'
            ? this.executeDiscard(entry, input.actor)
            : { itemId: null, attachmentId: null, warnings: [] as string[], payload: null as unknown };

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
          after: { status: 'accepted', itemId: executed.itemId, attachmentId: executed.attachmentId },
          reason: input.note ?? `accepted from the command line: ${action}`,
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
          reason: input.note ?? 'rejected from the command line, without a note',
        },
        tx,
      );

      return { ...entry, ...patch };
    });
  }

  /* ---- the executions ---------------------------------------------------------------------- */

  private executeCreateItem(
    entry: ReviewQueueRow,
    actor: Actor,
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
      .from(schema.documents)
      .where(eq(schema.documents.id, entry.subjectId))
      .get();
    if (document === undefined) {
      throw new ConflictError(
        `The document '${entry.subjectId}' this entry is about is no longer in the library, so ` +
          'there is nothing to file. Reject the entry.',
        { reviewEntryId: entry.id, documentId: entry.subjectId },
      );
    }

    const proposal = buildProposal(parsePayload(entry.proposedPayload), entry.confidence);
    const result = commitProposal({
      recueil: this.recueil,
      reviewQueue: this.queue,
      actor,
      documentId: document.id,
      sha256: document.sha256,
      proposal,
      attachmentRole: document.sourceKind === 'scanner' ? 'scan' : 'primary',
      provenanceSource: 'review:accepted',
      ...(entry.jobId === null ? {} : { runId: entry.jobId }),
      sourceStage: 'review.accept',
    });

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

  /** Filed nowhere, on purpose: trashed rather than deleted (P5), and the blob is never removed. */
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
 * The proposal the pipeline would have committed, stamped as a human decision.
 *
 * `proposed_payload` is deliberately flat — §6.1 stores "exactly the request body that accept will
 * execute", not the pipeline's internal representation with a provenance object per field — so the
 * provenance is reconstructed here, and it says a person accepted the value rather than that a rule
 * guessed it.
 */
export const buildProposal = (
  payload: ProposedItemPayload,
  confidence: number | null,
): ItemProposal => {
  const proposal = emptyProposal();
  const fetchedAt = nowTimestamp();
  const score = confidence ?? payload.confidence ?? 0.5;

  for (const [path, value] of Object.entries(payload.fields ?? {})) {
    proposal.fields[path] = {
      value,
      provenance: { source: 'review:accepted', fetchedAt, confidence: score },
    };
  }

  proposal.itemType = payload.itemType ?? 'document';
  proposal.tags = [...(payload.tags ?? [])];
  proposal.collectionIds = [...(payload.collectionIds ?? [])];
  proposal.customFields = { ...(payload.customFields ?? {}) };
  proposal.notes = [...(payload.notes ?? [])];
  proposal.creators = (payload.creators ?? []).map((creator) => ({
    role: creator.role,
    ...(creator.family === null || creator.family === undefined ? {} : { family: creator.family }),
    ...(creator.given === null || creator.given === undefined ? {} : { given: creator.given }),
    ...(creator.literal === null || creator.literal === undefined ? {} : { literal: creator.literal }),
    sequence: creator.sequence,
    provenance: { source: 'review:accepted', fetchedAt, confidence: score },
  }));

  // An accepted proposal is one a person has looked at, so it enters at the score the gate would
  // have wanted rather than at the score that failed it. The audit row records who decided that.
  proposal.confidence = 1;

  return proposal;
};
