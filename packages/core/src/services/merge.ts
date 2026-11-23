/**
 * Merging duplicate items, reversibly (CONCEPT §5.6, `spec/data-model.md` §6.6).
 *
 * A merge keeps one item — the winner — and retires the others:
 *
 * 1. **Children move.** Live attachments and notes of a loser are re-parented to the winner, and
 *    the reading context of their annotations follows. An attachment whose document the winner
 *    already carries does not move (`ux_attachments_item_document`): it is the same file twice, and
 *    it goes to the trash with the loser. A moved primary attachment becomes a supplement when the
 *    winner already has a primary.
 * 2. **Organisation is united.** Every tag and collection membership of a loser is given to the
 *    winner, marked `merge`.
 * 3. **Blanks are filled.** A bibliographic column the winner leaves empty takes the loser's value
 *    ("newest wins, fill blanks" — the Argus One policy); an empty creator list takes the loser's.
 *    The winner's own values are never overwritten.
 * 4. **The loser goes to the trash**, `reason = 'merge'`, `library_state = 'merged'`, with a merge
 *    record that names everything above, value by value.
 *
 * `unmerge` reads that record and reverses it: the loser comes back, its children go back to it,
 * the tags and memberships it brought are taken off the winner, and every filled value the winner
 * still holds unchanged is cleared again. A value someone edited after the merge is left alone and
 * reported, because it is no longer the merge's to take back.
 */
import { and, eq, isNull } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import {
  annotations,
  attachments,
  collectionItems,
  itemBibliographic,
  itemTags,
  items,
  notes,
  trash,
} from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { AuditService } from './audit.js';
import type { CollectionService } from './collections.js';
import type { CreatorService } from './creators.js';
import type { LibraryService, BibliographicInput } from './library.js';
import type { TagService } from './tags.js';

/** Columns a merge may fill. Identity and derived columns are excluded. */
const FILLABLE_COLUMNS = [
  'cslType',
  'title',
  'subtitle',
  'shortTitle',
  'containerTitle',
  'containerShort',
  'collectionTitle',
  'collectionNumber',
  'publisher',
  'publisherPlace',
  'edition',
  'volume',
  'issue',
  'pages',
  'pageFirst',
  'pageLast',
  'numberOfPages',
  'issuedDate',
  'issuedYear',
  'issuedMonth',
  'availableDate',
  'accessedAt',
  'doi',
  'pmid',
  'pmcid',
  'arxivId',
  'isbn',
  'issn',
  'eissn',
  'issnL',
  'openalexId',
  'semanticScholarId',
  'dataciteDoi',
  'handle',
  'url',
  'abstract',
  'languageCode',
  'licence',
  'versionLabel',
] as const;

type FillableColumn = (typeof FILLABLE_COLUMNS)[number];

export interface MergeRecord {
  schema: 'recueil.merge/1';
  winnerId: string;
  movedAttachments: { id: string; previousRole: string; role: string }[];
  movedNotes: string[];
  movedAnnotations: string[];
  addedTagIds: string[];
  addedCollectionIds: string[];
  filled: Partial<Record<FillableColumn, string | number | boolean | null>>;
  filledCreators: boolean;
  /** Why the merge happened: the rule and its evidence, for the review history. */
  reason?: Record<string, unknown>;
}

export interface MergeOutcome {
  winnerId: string;
  losers: { id: string; record: MergeRecord }[];
}

export interface UnmergeOutcome {
  restoredId: string;
  winnerId: string;
  /** Filled values the winner no longer holds as the merge left them, so they were not cleared. */
  keptOnWinner: string[];
  /** Identifiers the restored item could not take back, because the winner holds them (B1). */
  droppedIdentifiers: string[];
}

const blank = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

export class ItemMergeService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    private readonly services: {
      library: LibraryService;
      tags: TagService;
      collections: CollectionService;
      creators: CreatorService;
    },
  ) {}

  merge(
    winnerId: string,
    loserIds: readonly string[],
    actor: Actor,
    options: { reason?: Record<string, unknown> } = {},
  ): MergeOutcome {
    if (loserIds.length === 0) throw new ValidationError('A merge needs at least one item to merge in.');
    if (loserIds.includes(winnerId)) throw new ValidationError('An item cannot be merged into itself.');
    if (new Set(loserIds).size !== loserIds.length) throw new ValidationError('The same item is named twice.');

    return this.db.transaction(() => {
      const winner = this.liveItem(winnerId);
      const outcome: MergeOutcome = { winnerId, losers: [] };
      for (const loserId of loserIds) {
        const loser = this.liveItem(loserId);
        if (loser.itemType !== winner.itemType) {
          // Argus One refuses a type mismatch; so does this, because "fill blanks" across two types
          // would fill fields the winner's type does not have.
          throw new ValidationError(`'${loserId}' is a ${loser.itemType}, '${winnerId}' a ${winner.itemType}.`);
        }
        outcome.losers.push({ id: loserId, record: this.mergeOne(winnerId, loserId, actor, options.reason) });
      }
      return outcome;
    });
  }

  private liveItem(id: string) {
    const row = this.db.select().from(items).where(eq(items.id, id)).get();
    if (row === undefined) throw new NotFoundError('item', id);
    if (row.trashedAt !== null) throw new ConflictError(`Item '${id}' is in the trash.`, { itemId: id });
    return row;
  }

  private mergeOne(winnerId: string, loserId: string, actor: Actor, reason?: Record<string, unknown>): MergeRecord {
    const now = nowTimestamp();
    const record: MergeRecord = {
      schema: 'recueil.merge/1',
      winnerId,
      movedAttachments: [],
      movedNotes: [],
      movedAnnotations: [],
      addedTagIds: [],
      addedCollectionIds: [],
      filled: {},
      filledCreators: false,
      ...(reason === undefined ? {} : { reason }),
    };

    /* 1. Children. */
    const winnerDocuments = new Set(
      this.db
        .select({ documentId: attachments.documentId })
        .from(attachments)
        .where(and(eq(attachments.itemId, winnerId), isNull(attachments.trashedAt)))
        .all()
        .map((row) => row.documentId)
        .filter((id): id is string => id !== null),
    );
    let winnerHasPrimary =
      this.db
        .select({ id: attachments.id })
        .from(attachments)
        .where(and(eq(attachments.itemId, winnerId), eq(attachments.role, 'primary'), isNull(attachments.trashedAt)))
        .get() !== undefined;

    const loserAttachments = this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.itemId, loserId), isNull(attachments.trashedAt)))
      .all();
    for (const attachment of loserAttachments) {
      if (attachment.documentId !== null && winnerDocuments.has(attachment.documentId)) continue;
      const role = attachment.role === 'primary' && winnerHasPrimary ? 'supplement' : attachment.role;
      if (role === 'primary') winnerHasPrimary = true;
      this.db
        .update(attachments)
        .set({ itemId: winnerId, role, updatedAt: now })
        .where(eq(attachments.id, attachment.id))
        .run();
      record.movedAttachments.push({ id: attachment.id, previousRole: attachment.role, role });
      if (attachment.documentId !== null) winnerDocuments.add(attachment.documentId);

      const moved = this.db
        .select({ id: annotations.id })
        .from(annotations)
        .where(and(eq(annotations.attachmentId, attachment.id), eq(annotations.itemId, loserId)))
        .all();
      for (const annotation of moved) {
        this.db.update(annotations).set({ itemId: winnerId, updatedAt: now }).where(eq(annotations.id, annotation.id)).run();
        record.movedAnnotations.push(annotation.id);
      }
    }

    const loserNotes = this.db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.itemId, loserId), isNull(notes.trashedAt)))
      .all();
    for (const note of loserNotes) {
      this.db.update(notes).set({ itemId: winnerId, updatedAt: now }).where(eq(notes.id, note.id)).run();
      record.movedNotes.push(note.id);
    }

    /* 2. Tags and collections. */
    const winnerTags = new Set(
      this.db.select({ tagId: itemTags.tagId }).from(itemTags).where(eq(itemTags.itemId, winnerId)).all().map((r) => r.tagId),
    );
    for (const { tagId } of this.db.select({ tagId: itemTags.tagId }).from(itemTags).where(eq(itemTags.itemId, loserId)).all()) {
      if (winnerTags.has(tagId)) continue;
      this.services.tags.assign(winnerId, tagId, actor, { source: 'merge' });
      record.addedTagIds.push(tagId);
    }
    const winnerCollections = new Set(
      this.db
        .select({ collectionId: collectionItems.collectionId })
        .from(collectionItems)
        .where(eq(collectionItems.itemId, winnerId))
        .all()
        .map((r) => r.collectionId),
    );
    for (const { collectionId } of this.db
      .select({ collectionId: collectionItems.collectionId })
      .from(collectionItems)
      .where(eq(collectionItems.itemId, loserId))
      .all()) {
      if (winnerCollections.has(collectionId)) continue;
      this.services.collections.addItems(collectionId, [winnerId], actor, { source: 'merge' });
      record.addedCollectionIds.push(collectionId);
    }

    /* 3. Creators: an empty list takes the loser's. */
    const loserCreators = this.services.creators.forItem(loserId);
    if (this.services.creators.forItem(winnerId).length === 0 && loserCreators.length > 0) {
      this.services.creators.setItemCreators(
        winnerId,
        loserCreators.map(({ appearance }) => ({
          creatorId: appearance.creatorId,
          role: appearance.role,
          rawName: appearance.rawName,
        })),
        actor,
      );
      record.filledCreators = true;
    }

    // Blanks are computed now, written after the loser is in the trash: the loser's DOI and
    // citation key only become free once it is no longer a live claimant (B1, ADR-0016).
    const winnerBib = this.db.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, winnerId)).get();
    const loserBib = this.db.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, loserId)).get();
    const fill: BibliographicInput = {};
    if (loserBib !== undefined) {
      for (const column of FILLABLE_COLUMNS) {
        const current = winnerBib?.[column];
        const offered = loserBib[column];
        if (blank(current) && !blank(offered)) {
          (fill as Record<string, unknown>)[column] = offered;
          record.filled[column] = offered as string | number | boolean | null;
        }
      }
    }

    /* 4. The loser. */
    this.services.library.trashItem(loserId, actor, {
      reason: 'merge',
      reasonDetail: `merged into ${winnerId}`,
      mergeTargetItemId: winnerId,
      mergeRecord: record as unknown as Record<string, unknown>,
    });
    this.db
      .update(items)
      .set({ libraryState: 'merged', mergedIntoItemId: winnerId })
      .where(eq(items.id, loserId))
      .run();

    if (Object.keys(fill).length > 0) {
      this.services.library.writeBibliographic(winnerId, fill, actor, { provenance: { source: 'merge', lock: false } });
    }

    this.audit.record({
      actor,
      action: 'item.merged',
      entityType: 'item',
      entityId: winnerId,
      before: { loserId },
      after: {
        movedAttachments: record.movedAttachments.length,
        movedNotes: record.movedNotes.length,
        addedTags: record.addedTagIds.length,
        addedCollections: record.addedCollectionIds.length,
        filled: Object.keys(record.filled),
      },
      reason: 'merge',
    });
    return record;
  }

  /** The open merge record of a merged-away item. */
  mergeRecordOf(loserId: string): MergeRecord | null {
    const row = this.db
      .select()
      .from(trash)
      .where(
        and(
          eq(trash.entityType, 'item'),
          eq(trash.entityId, loserId),
          eq(trash.reason, 'merge'),
          isNull(trash.restoredAt),
          isNull(trash.purgedAt),
        ),
      )
      .get();
    if (row === undefined || row.mergeRecord === null) return null;
    return JSON.parse(row.mergeRecord) as MergeRecord;
  }

  unmerge(loserId: string, actor: Actor): UnmergeOutcome {
    return this.db.transaction(() => {
      const record = this.mergeRecordOf(loserId);
      if (record === null) throw new ConflictError(`Item '${loserId}' is not a merged-away item.`, { itemId: loserId });
      const winnerId = record.winnerId;
      const now = nowTimestamp();
      const outcome: UnmergeOutcome = { restoredId: loserId, winnerId, keptOnWinner: [], droppedIdentifiers: [] };

      /* Filled values first, so the identifiers the loser gets back are free again. */
      const winnerBib = this.db.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, winnerId)).get();
      const clear: BibliographicInput = {};
      for (const [column, value] of Object.entries(record.filled)) {
        const current = (winnerBib as Record<string, unknown> | undefined)?.[column];
        if (current === value) (clear as Record<string, unknown>)[column] = null;
        else outcome.keptOnWinner.push(column);
      }
      if (Object.keys(clear).length > 0) {
        this.services.library.writeBibliographic(winnerId, clear, actor, { provenance: { source: 'merge', lock: false } });
      }

      /* An identifier the winner holds in its own right cannot be live twice (B1). */
      const loserBib = this.db.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, loserId)).get();
      const freshWinner = this.db.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, winnerId)).get();
      for (const column of ['doi', 'citationKey'] as const) {
        const value = loserBib?.[column];
        if (value != null && freshWinner?.[column] === value) {
          this.db.update(itemBibliographic).set({ [column]: null, updatedAt: now }).where(eq(itemBibliographic.itemId, loserId)).run();
          outcome.droppedIdentifiers.push(`${column}=${value}`);
        }
      }

      this.db.update(items).set({ libraryState: 'normal', mergedIntoItemId: null }).where(eq(items.id, loserId)).run();
      this.services.library.restoreItem(loserId, actor);

      for (const moved of record.movedAttachments) {
        this.db
          .update(attachments)
          .set({ itemId: loserId, role: moved.previousRole as typeof attachments.$inferSelect.role, updatedAt: now })
          .where(and(eq(attachments.id, moved.id), eq(attachments.itemId, winnerId)))
          .run();
      }
      for (const annotationId of record.movedAnnotations) {
        this.db.update(annotations).set({ itemId: loserId, updatedAt: now }).where(and(eq(annotations.id, annotationId), eq(annotations.itemId, winnerId))).run();
      }
      for (const noteId of record.movedNotes) {
        this.db.update(notes).set({ itemId: loserId, updatedAt: now }).where(and(eq(notes.id, noteId), eq(notes.itemId, winnerId))).run();
      }
      for (const tagId of record.addedTagIds) this.services.tags.unassign(winnerId, tagId, actor);
      for (const collectionId of record.addedCollectionIds) {
        this.services.collections.removeItems(collectionId, [winnerId], actor);
      }
      if (record.filledCreators) this.services.creators.setItemCreators(winnerId, [], actor);

      this.audit.record({
        actor,
        action: 'item.unmerged',
        entityType: 'item',
        entityId: loserId,
        before: { mergedInto: winnerId },
        after: { keptOnWinner: outcome.keptOnWinner, droppedIdentifiers: outcome.droppedIdentifiers },
        reason: 'unmerge',
      });
      return outcome;
    });
  }
}
