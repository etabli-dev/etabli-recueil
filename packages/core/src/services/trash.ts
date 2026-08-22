/**
 * The trash, across every entity (§6.6, P5).
 *
 * Each service knows how to trash and restore its own entity — that is where the cascade rules and
 * the restore payloads live. This service is the view over all of them: what is in the bin, how
 * long it has been there, and one `restore` that dispatches to whichever service owns the entity,
 * so a caller with a `trash` row in hand does not have to know which one that is.
 *
 * **Purging.** `purge` marks `purged_at` and stops there. It does not delete the entity's row, and
 * that is deliberate rather than unfinished: `ON DELETE RESTRICT` is on almost every foreign key in
 * the schema precisely so that nothing vanishes out from under a reference, and a real hard delete
 * has to walk those references and decide what to do about each — which is a storage-reclamation
 * operation over documents with no live attachment (AT2), not a row delete. What `purge` does give
 * is TR2's contract: the entity leaves the restorable set, permanently, on an explicit request, and
 * the audit log says who asked.
 */
import { and, asc, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { trash } from '../db/schema.js';
import type { TrashRow } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { AuditService } from './audit.js';
import type { CollectionService } from './collections.js';
import type { CreatorService } from './creators.js';
import type { Page } from './cursor.js';
import { decodeCursor, encodeCursor, resolveLimit } from './cursor.js';
import type { DocumentService } from './documents.js';
import type { LibraryService } from './library.js';
import type { NoteService } from './notes.js';
import type { TagService } from './tags.js';
import type { TrashEntityType } from './trash-record.js';

export interface ListTrashOptions {
  entityType?: TrashEntityType;
  /** Include rows that have already been restored or purged. Default false. */
  includeClosed?: boolean;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

/** The services `restore` dispatches to. Every one of them is optional so a partial wiring works. */
export interface TrashDependencies {
  library?: LibraryService;
  collections?: CollectionService;
  tags?: TagService;
  notes?: NoteService;
  creators?: CreatorService;
  documents?: DocumentService;
}

export class TrashService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    private readonly services: TrashDependencies,
  ) {}

  /** What is in the bin, newest first, paged by `(trashed_at, id)`. */
  list(options: ListTrashOptions = {}): Page<TrashRow> {
    const limit = resolveLimit(options.limit);
    const order = options.order ?? 'desc';

    const conditions = [];
    if (options.includeClosed !== true) {
      conditions.push(isNull(trash.restoredAt), isNull(trash.purgedAt));
    }
    if (options.entityType !== undefined) conditions.push(eq(trash.entityType, options.entityType));

    if (options.cursor !== undefined) {
      const { k, i } = decodeCursor(options.cursor);
      conditions.push(
        order === 'desc'
          ? or(lt(trash.trashedAt, k), and(eq(trash.trashedAt, k), lt(trash.id, i)))!
          : or(gt(trash.trashedAt, k), and(eq(trash.trashedAt, k), gt(trash.id, i)))!,
      );
    }

    const direction = order === 'desc' ? desc : asc;
    const rows = this.db
      .select()
      .from(trash)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(direction(trash.trashedAt), direction(trash.id))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const last = data.at(-1);

    return {
      data,
      page: {
        nextCursor:
          hasMore && last !== undefined ? encodeCursor({ k: last.trashedAt, i: last.id }) : null,
        hasMore,
        limit,
      },
    };
  }

  /** The open record for one entity, if it is in the bin. */
  find(entityType: TrashEntityType, entityId: string): TrashRow | undefined {
    return this.db
      .select()
      .from(trash)
      .where(
        and(
          eq(trash.entityType, entityType),
          eq(trash.entityId, entityId),
          isNull(trash.restoredAt),
          isNull(trash.purgedAt),
        ),
      )
      .get();
  }

  /**
   * Restore whatever is behind a trash row.
   *
   * Dispatch, not reimplementation: each service already knows the cascade it wrote and the payload
   * it captured, and a second copy of that knowledge here would drift from the first.
   */
  restore(entityType: TrashEntityType, entityId: string, actor: Actor): void {
    switch (entityType) {
      case 'item':
        this.require(this.services.library, entityType).restoreItem(entityId, actor);
        return;
      case 'collection':
        this.require(this.services.collections, entityType).restore(entityId, actor);
        return;
      case 'tag':
        this.require(this.services.tags, entityType).restore(entityId, actor);
        return;
      case 'note':
        this.require(this.services.notes, entityType).restore(entityId, actor);
        return;
      case 'creator':
        this.require(this.services.creators, entityType).restore(entityId, actor);
        return;
      case 'document':
        this.require(this.services.documents, entityType).restoreDocument(entityId, actor);
        return;
      case 'attachment':
        // A detached file goes back on its item; one that went into the bin *with* its item is
        // refused by `restoreAttachment` itself, because I4 says it comes back with the item.
        this.require(this.services.documents, entityType).restoreAttachment(entityId, actor);
        return;
      case 'annotation':
        // Restored as part of the item it hangs off (I4), never on its own.
        throw new ValidationError(
          `An annotation is restored with the item it belongs to, not by itself (I4).`,
          { entityType, entityId },
        );
      case 'review':
      case 'curated_network':
        throw new ValidationError(
          `Restoring a '${entityType}' arrives with the phase that brings the entity.`,
          { entityType, entityId },
        );
    }
  }

  /** Restore by trash-row id, for a caller paging the bin. */
  restoreRecord(trashId: string, actor: Actor): void {
    const row = this.db.select().from(trash).where(eq(trash.id, trashId)).get();
    if (row === undefined) throw new NotFoundError('trash', trashId);
    if (row.restoredAt !== null) {
      throw new ConflictError(`Trash record '${trashId}' was already restored.`, { trashId });
    }
    if (row.purgedAt !== null) {
      throw new ConflictError(`Trash record '${trashId}' was purged and cannot be restored.`, {
        trashId,
      });
    }
    this.restore(row.entityType, row.entityId, actor);
  }

  /** Take an entity out of the restorable set, for good (TR2). See the module note. */
  purge(trashId: string, actor: Actor, reason?: string): TrashRow {
    return this.db.transaction((tx) => {
      const row = tx.select().from(trash).where(eq(trash.id, trashId)).get();
      if (row === undefined) throw new NotFoundError('trash', trashId);
      if (row.purgedAt !== null) return row;
      if (row.restoredAt !== null) {
        throw new ConflictError(
          `Trash record '${trashId}' was restored; the entity is live and cannot be purged from the bin.`,
          { trashId },
        );
      }

      const now = nowTimestamp();
      tx.update(trash)
        .set({ purgedAt: now, purgedByUserId: actor.userId ?? null })
        .where(eq(trash.id, trashId))
        .run();

      this.audit.record(
        {
          actor,
          action: 'trash.purged',
          entityType: row.entityType,
          entityId: row.entityId,
          before: { trashedAt: row.trashedAt, reason: row.reason },
          after: { purgedAt: now },
          reason: reason ?? 'explicit purge (TR2)',
        },
        tx,
      );

      return { ...row, purgedAt: now, purgedByUserId: actor.userId ?? null };
    });
  }

  /** How many entities of each type are in the bin. */
  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.db
      .select({ entityType: trash.entityType })
      .from(trash)
      .where(and(isNull(trash.restoredAt), isNull(trash.purgedAt)))
      .all()) {
      out[row.entityType] = (out[row.entityType] ?? 0) + 1;
    }
    return out;
  }

  private require<TService>(service: TService | undefined, entityType: string): TService {
    if (service === undefined) {
      throw new ConflictError(
        `This library was constructed without the service that owns '${entityType}'.`,
        { entityType },
      );
    }
    return service;
  }
}
