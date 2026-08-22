/**
 * The library service: items and their two facets (§3.4, §3.5, §3.7).
 *
 * Four rules run through every method here, and they are the reason this is a service rather than
 * a thin repository:
 *
 * - **Every mutation writes an `audit_log` row, in the same transaction as the write** (P5, §6.5).
 *   Not afterwards, not best-effort.
 * - **Nothing is deleted.** `trashItem` sets `trashed_at` and opens a `trash` row, and the two are
 *   written together because invariant T1 says one without the other is a corrupt library.
 * - **`items.title` mirrors `item_bibliographic.title`** whenever the facet exists (I3). The
 *   duplication is deliberate — a list view must not join a facet table to render a row — and the
 *   service owns it, because trigger syntax is not portable.
 * - **`version` is optimistic concurrency, not a counter** (§1.7). A conditional write with a stale
 *   version is refused and the refusal is audited as `item.conflict`; nothing is merged (P1).
 */
import { SLUG_PATTERN } from '@recueil/schemas';
import { and, asc, count, desc, eq, isNull, lt, gt, or, sql } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import {
  attachments,
  annotations,
  collectionItems,
  itemBibliographic,
  itemOffice,
  itemTags,
  items,
  notes,
  trash,
} from '../db/schema.js';
import type { ItemBibliographicRow, ItemOfficeRow, ItemRow } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError, VersionConflictError } from '../errors.js';
import { newId, newPublicId } from '../ids.js';
import { normalise, normaliseDoi } from '../normalise.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import { AuditService, diffFields } from './audit.js';
import type { Page } from './cursor.js';
import { decodeCursor, encodeCursor, resolveLimit } from './cursor.js';

/** Everything on the bibliographic facet that a caller may write. */
export type BibliographicInput = Partial<
  Omit<ItemBibliographicRow, 'itemId' | 'itemTrashedAt' | 'createdAt' | 'updatedAt'>
>;

/** Everything on the office facet that a caller may write. `correspondent` is required. */
export type OfficeInput = Partial<
  Omit<ItemOfficeRow, 'itemId' | 'itemTrashedAt' | 'createdAt' | 'updatedAt'>
> & { correspondent: string };

export interface CreateItemInput {
  itemType: string;
  title?: string | null;
  extra?: string | null;
  sourceSystem?: string | null;
  sourceId?: string | null;
  /** Defaults to the actor's user, then to the library's single local account. */
  ownerUserId?: string;
  /** Importers carry a Zotero key across; ordinary writes leave it unset (§1.3). */
  publicId?: string;
  /** Importers preserve the original; ordinary writes leave it unset (§1.8). */
  dateAdded?: string;
  bibliographic?: BibliographicInput;
  office?: OfficeInput;
}

export interface UpdateItemInput {
  itemType?: string;
  title?: string | null;
  extra?: string | null;
  sourceSystem?: string | null;
  sourceId?: string | null;
  bibliographic?: BibliographicInput | null;
  office?: (Partial<OfficeInput> & { correspondent?: string }) | null;
}

/** An item with its facets. The shape `GET /items/{id}` renders. */
export interface ItemRecord {
  item: ItemRow;
  bibliographic: ItemBibliographicRow | null;
  office: ItemOfficeRow | null;
}

export interface ListItemsOptions {
  limit?: number;
  cursor?: string;
  /** `desc` (newest first) is the default a library list view wants. */
  order?: 'asc' | 'desc';
  itemType?: string;
  ownerUserId?: string;
  /** Trashed items are excluded unless asked for; merge losers never appear at all (I2). */
  includeTrashed?: boolean;
}

export interface TrashOptions {
  reason?: 'user' | 'merge' | 'import_rollback' | 'cascade' | 'plugin';
  reasonDetail?: string | null;
  /** Set when `reason` is `merge`: the winner (§6.6). */
  mergeTargetItemId?: string | null;
}

export class LibraryService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    /** The account owned records fall back to. In v1 there is exactly one (§1.4). */
    private readonly defaultOwnerUserId: string,
  ) {}

  /* ---------------------------------------------------------------------------------------- */
  /* Create                                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  createItem(input: CreateItemInput, actor: Actor): ItemRecord {
    if (!SLUG_PATTERN.test(input.itemType)) {
      throw new ValidationError(
        `Item type '${input.itemType}' is not a slug. The vocabulary is open (§3.4, O3), but the ` +
          'shape is not: lowercase, starting with a letter, underscores only.',
        { itemType: input.itemType },
      );
    }
    if (input.office !== undefined && input.office.correspondent.trim() === '') {
      throw new ValidationError('The office facet requires a correspondent (§3.7).');
    }

    const now = nowTimestamp();
    const id = newId();
    const ownerUserId = input.ownerUserId ?? actor.userId ?? this.defaultOwnerUserId;
    const bibliographic = input.bibliographic;

    // I3: when the facet exists, the item title is the facet title.
    const title =
      bibliographic === undefined ? (input.title ?? null) : (bibliographic.title ?? input.title ?? null);

    return this.db.transaction((tx) => {
      const itemRow: ItemRow = {
        id,
        publicId: input.publicId ?? this.mintPublicId(),
        itemType: input.itemType,
        title,
        ownerUserId,
        libraryState: 'normal',
        mergedIntoItemId: null,
        sourceSystem: input.sourceSystem ?? null,
        sourceId: input.sourceId ?? null,
        extra: input.extra ?? null,
        version: 1,
        dateAdded: input.dateAdded ?? now,
        dateModified: now,
        trashedAt: null,
      };
      tx.insert(items).values(itemRow).run();

      let bibliographicRow: ItemBibliographicRow | null = null;
      if (bibliographic !== undefined) {
        tx.insert(itemBibliographic)
          .values({
            ...normaliseBibliographic(bibliographic),
            itemId: id,
            title,
            itemTrashedAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        bibliographicRow = tx
          .select()
          .from(itemBibliographic)
          .where(eq(itemBibliographic.itemId, id))
          .get() as ItemBibliographicRow;
      }

      let officeRow: ItemOfficeRow | null = null;
      if (input.office !== undefined) {
        tx.insert(itemOffice)
          .values({
            ...input.office,
            itemId: id,
            correspondentNormalised: normalise(input.office.correspondent),
            itemTrashedAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        officeRow = tx
          .select()
          .from(itemOffice)
          .where(eq(itemOffice.itemId, id))
          .get() as ItemOfficeRow;
      }

      this.audit.record(
        {
          actor,
          action: 'item.created',
          entityType: 'item',
          entityId: id,
          after: {
            itemType: itemRow.itemType,
            title: itemRow.title,
            ownerUserId,
            hasBibliographic: bibliographicRow !== null,
            hasOffice: officeRow !== null,
          },
        },
        tx,
      );

      return { item: itemRow, bibliographic: bibliographicRow, office: officeRow };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Read                                                                                        */
  /* ---------------------------------------------------------------------------------------- */

  /** One item with its facets. Trashed items are hidden unless asked for (§1.5). */
  getItem(id: string, options: { includeTrashed?: boolean } = {}): ItemRecord {
    const item = this.db.select().from(items).where(eq(items.id, id)).get();
    if (item === undefined) throw new NotFoundError('item', id);
    if (item.trashedAt !== null && options.includeTrashed !== true) throw new NotFoundError('item', id);

    return {
      item,
      bibliographic:
        this.db.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, id)).get() ?? null,
      office: this.db.select().from(itemOffice).where(eq(itemOffice.itemId, id)).get() ?? null,
    };
  }

  /** The same lookup by the eight-character public key the API exposes as `key` (§1.3). */
  getItemByPublicId(publicId: string, options: { includeTrashed?: boolean } = {}): ItemRecord {
    const row = this.db.select().from(items).where(eq(items.publicId, publicId)).get();
    if (row === undefined) throw new NotFoundError('item', publicId);
    return this.getItem(row.id, options);
  }

  /**
   * A page of items, ordered by `(date_modified, id)`.
   *
   * The pair is what makes the order total: `date_modified` alone repeats within a millisecond, and
   * a cursor over a non-total order silently skips or repeats rows. Merge losers are excluded
   * unconditionally — I2 says they never appear in a list.
   */
  listItems(options: ListItemsOptions = {}): Page<ItemRow> {
    const limit = resolveLimit(options.limit);
    const order = options.order ?? 'desc';

    const conditions = [sql`${items.libraryState} <> 'merged'`];
    if (options.includeTrashed !== true) conditions.push(isNull(items.trashedAt));
    if (options.itemType !== undefined) conditions.push(eq(items.itemType, options.itemType));
    if (options.ownerUserId !== undefined) conditions.push(eq(items.ownerUserId, options.ownerUserId));

    if (options.cursor !== undefined) {
      const { k, i } = decodeCursor(options.cursor);
      conditions.push(
        order === 'desc'
          ? or(lt(items.dateModified, k), and(eq(items.dateModified, k), lt(items.id, i)))!
          : or(gt(items.dateModified, k), and(eq(items.dateModified, k), gt(items.id, i)))!,
      );
    }

    const direction = order === 'desc' ? desc : asc;
    const rows = this.db
      .select()
      .from(items)
      .where(and(...conditions))
      .orderBy(direction(items.dateModified), direction(items.id))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const last = data.at(-1);

    return {
      data,
      page: {
        nextCursor:
          hasMore && last !== undefined ? encodeCursor({ k: last.dateModified, i: last.id }) : null,
        hasMore,
        limit,
      },
    };
  }

  /** How many live items there are. Cheap enough to expose as `page.total`. */
  countItems(options: Pick<ListItemsOptions, 'includeTrashed' | 'itemType' | 'ownerUserId'> = {}): number {
    const conditions = [sql`${items.libraryState} <> 'merged'`];
    if (options.includeTrashed !== true) conditions.push(isNull(items.trashedAt));
    if (options.itemType !== undefined) conditions.push(eq(items.itemType, options.itemType));
    if (options.ownerUserId !== undefined) conditions.push(eq(items.ownerUserId, options.ownerUserId));

    return (
      this.db
        .select({ value: count() })
        .from(items)
        .where(and(...conditions))
        .get()?.value ?? 0
    );
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Update                                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * A partial write.
   *
   * `expectedVersion` is the ETag the API handed out. When it is given and does not match, the
   * write is refused, the refusal is written to the audit log as `item.conflict`, and the caller
   * re-reads — P1's "conflicts logged, not merged", made concrete.
   */
  updateItem(
    id: string,
    patch: UpdateItemInput,
    actor: Actor,
    options: { expectedVersion?: number } = {},
  ): ItemRecord {
    // The conflict check happens before the transaction opens, because the audit row that records
    // the refusal must survive it: a rejected write rolls its own transaction back, and an audit
    // row written inside would roll back with it, leaving §1.7's "the rejected write is recorded"
    // quietly false.
    if (options.expectedVersion !== undefined) {
      const seen = this.db.select().from(items).where(eq(items.id, id)).get();
      if (seen !== undefined && seen.version !== options.expectedVersion) {
        this.audit.record({
          actor,
          action: 'item.conflict',
          entityType: 'item',
          entityId: id,
          before: { version: seen.version },
          after: { version: options.expectedVersion },
          reason: 'stale conditional write, refused (§1.7, P1)',
        });
        throw new VersionConflictError('item', id, options.expectedVersion, seen.version);
      }
    }

    return this.db.transaction((tx) => {
      const current = tx.select().from(items).where(eq(items.id, id)).get();
      if (current === undefined) throw new NotFoundError('item', id);
      if (current.trashedAt !== null) {
        throw new ConflictError(
          `Item '${id}' is in the trash. Restore it before editing it (§1.5).`,
          { itemId: id },
        );
      }

      // Re-checked inside the transaction: between the check above and here, another writer may
      // have committed. SQLite has one writer, so this is the belt to that braces.
      if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
        throw new VersionConflictError('item', id, options.expectedVersion, current.version);
      }

      const now = nowTimestamp();
      const currentBibliographic =
        tx.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, id)).get() ?? null;
      const currentOffice = tx.select().from(itemOffice).where(eq(itemOffice.itemId, id)).get() ?? null;

      /* Facets first, because the item title mirrors the bibliographic one (I3). */
      let bibliographicRow = currentBibliographic;
      if (patch.bibliographic !== undefined && patch.bibliographic !== null) {
        const values = normaliseBibliographic(patch.bibliographic);
        if (currentBibliographic === null) {
          tx.insert(itemBibliographic)
            .values({
              ...values,
              itemId: id,
              itemTrashedAt: null,
              createdAt: now,
              updatedAt: now,
            })
            .run();
        } else {
          tx.update(itemBibliographic)
            .set({ ...values, updatedAt: now })
            .where(eq(itemBibliographic.itemId, id))
            .run();
        }
        bibliographicRow =
          tx.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, id)).get() ?? null;
      }

      let officeRow = currentOffice;
      if (patch.office !== undefined && patch.office !== null) {
        const correspondent = patch.office.correspondent ?? currentOffice?.correspondent;
        if (correspondent === undefined) {
          throw new ValidationError('The office facet requires a correspondent (§3.7).');
        }
        const values = {
          ...patch.office,
          correspondent,
          correspondentNormalised: normalise(correspondent),
        };
        if (currentOffice === null) {
          tx.insert(itemOffice)
            .values({ ...values, itemId: id, itemTrashedAt: null, createdAt: now, updatedAt: now })
            .run();
        } else {
          tx.update(itemOffice)
            .set({ ...values, updatedAt: now })
            .where(eq(itemOffice.itemId, id))
            .run();
        }
        officeRow = tx.select().from(itemOffice).where(eq(itemOffice.itemId, id)).get() ?? null;
      }

      const nextTitle =
        bibliographicRow !== null
          ? (bibliographicRow.title ?? (patch.title !== undefined ? patch.title : current.title))
          : patch.title !== undefined
            ? patch.title
            : current.title;

      const nextItem: ItemRow = {
        ...current,
        itemType: patch.itemType ?? current.itemType,
        title: nextTitle ?? null,
        extra: patch.extra !== undefined ? patch.extra : current.extra,
        sourceSystem: patch.sourceSystem !== undefined ? patch.sourceSystem : current.sourceSystem,
        sourceId: patch.sourceId !== undefined ? patch.sourceId : current.sourceId,
        version: current.version + 1,
        dateModified: now,
      };

      tx.update(items)
        .set({
          itemType: nextItem.itemType,
          title: nextItem.title,
          extra: nextItem.extra,
          sourceSystem: nextItem.sourceSystem,
          sourceId: nextItem.sourceId,
          version: nextItem.version,
          dateModified: nextItem.dateModified,
        })
        .where(eq(items.id, id))
        .run();

      const delta = diffFields(current as unknown as Record<string, unknown>, {
        itemType: nextItem.itemType,
        title: nextItem.title,
        extra: nextItem.extra,
        sourceSystem: nextItem.sourceSystem,
        sourceId: nextItem.sourceId,
      });

      this.audit.record(
        {
          actor,
          action: 'item.updated',
          entityType: 'item',
          entityId: id,
          before: { ...(delta.before ?? {}), version: current.version },
          after: {
            ...(delta.after ?? {}),
            version: nextItem.version,
            ...(patch.bibliographic !== undefined && patch.bibliographic !== null
              ? { bibliographic: Object.keys(patch.bibliographic) }
              : {}),
            ...(patch.office !== undefined && patch.office !== null
              ? { office: Object.keys(patch.office) }
              : {}),
          },
        },
        tx,
      );

      return { item: nextItem, bibliographic: bibliographicRow, office: officeRow };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Trash and restore (P5)                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Soft-delete an item and everything that hangs off it.
   *
   * The cascade is logical, never `ON DELETE CASCADE` (I4): attachments, notes and annotations get
   * their own `trashed_at` and their own `trash` row, all sharing one `group_id`, so a restore puts
   * back exactly what was removed together and nothing that was already in the trash beforehand.
   *
   * Collection memberships are left alone. Trashing an item is not leaving a collection — the item
   * is filtered out of every live query by `trashed_at`, and the memberships are recorded in the
   * restore payload so that a later purge still knows what they were.
   *
   * Calling this on an item that is already trashed is a no-op, so a retried request does not open
   * a second trash record (P9).
   */
  trashItem(id: string, actor: Actor, options: TrashOptions = {}): ItemRecord {
    return this.db.transaction((tx) => {
      const current = tx.select().from(items).where(eq(items.id, id)).get();
      if (current === undefined) throw new NotFoundError('item', id);
      if (current.trashedAt !== null) {
        return {
          item: current,
          bibliographic:
            tx.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, id)).get() ?? null,
          office: tx.select().from(itemOffice).where(eq(itemOffice.itemId, id)).get() ?? null,
        };
      }

      const now = nowTimestamp();
      const groupId = newId();
      const reason = options.reason ?? 'user';
      const trashedByUserId = actor.userId ?? null;

      const memberships = tx
        .select({ collectionId: collectionItems.collectionId })
        .from(collectionItems)
        .where(eq(collectionItems.itemId, id))
        .all()
        .map((row) => row.collectionId);
      const tagIds = tx
        .select({ tagId: itemTags.tagId })
        .from(itemTags)
        .where(eq(itemTags.itemId, id))
        .all()
        .map((row) => row.tagId);

      /* The children, each trashed in its own right so that restore is exact. */
      const childAttachments = tx
        .select({ id: attachments.id })
        .from(attachments)
        .where(and(eq(attachments.itemId, id), isNull(attachments.trashedAt)))
        .all();
      const childNotes = tx
        .select({ id: notes.id })
        .from(notes)
        .where(and(eq(notes.itemId, id), isNull(notes.trashedAt)))
        .all();
      const childAnnotations = tx
        .select({ id: annotations.id })
        .from(annotations)
        .where(and(eq(annotations.itemId, id), isNull(annotations.trashedAt)))
        .all();

      for (const child of childAttachments) {
        tx.update(attachments)
          .set({ trashedAt: now, updatedAt: now })
          .where(eq(attachments.id, child.id))
          .run();
        this.openTrashRecord(tx, {
          entityType: 'attachment',
          entityId: child.id,
          groupId,
          now,
          reason: 'cascade',
          reasonDetail: `item ${id} trashed`,
          trashedByUserId,
          restorePayload: { parentItemId: id },
        });
      }
      for (const child of childNotes) {
        tx.update(notes).set({ trashedAt: now, updatedAt: now }).where(eq(notes.id, child.id)).run();
        this.openTrashRecord(tx, {
          entityType: 'note',
          entityId: child.id,
          groupId,
          now,
          reason: 'cascade',
          reasonDetail: `item ${id} trashed`,
          trashedByUserId,
          restorePayload: { parentItemId: id },
        });
      }
      for (const child of childAnnotations) {
        tx.update(annotations)
          .set({ trashedAt: now, updatedAt: now })
          .where(eq(annotations.id, child.id))
          .run();
        this.openTrashRecord(tx, {
          entityType: 'annotation',
          entityId: child.id,
          groupId,
          now,
          reason: 'cascade',
          reasonDetail: `item ${id} trashed`,
          trashedByUserId,
          restorePayload: { parentItemId: id },
        });
      }

      tx.update(items)
        .set({ trashedAt: now, dateModified: now, version: current.version + 1 })
        .where(eq(items.id, id))
        .run();
      /* The facets mirror the parent so that the partial unique indexes stay correct (§1.1). */
      tx.update(itemBibliographic)
        .set({ itemTrashedAt: now, updatedAt: now })
        .where(eq(itemBibliographic.itemId, id))
        .run();
      tx.update(itemOffice)
        .set({ itemTrashedAt: now, updatedAt: now })
        .where(eq(itemOffice.itemId, id))
        .run();

      this.openTrashRecord(tx, {
        entityType: 'item',
        entityId: id,
        groupId,
        now,
        reason,
        reasonDetail: options.reasonDetail ?? null,
        trashedByUserId,
        mergeTargetItemId: options.mergeTargetItemId ?? null,
        restorePayload: {
          collectionIds: memberships,
          tagIds,
          attachmentIds: childAttachments.map((row) => row.id),
          noteIds: childNotes.map((row) => row.id),
          annotationIds: childAnnotations.map((row) => row.id),
        },
      });

      this.audit.record(
        {
          actor,
          action: 'item.trashed',
          entityType: 'item',
          entityId: id,
          before: { trashedAt: null, version: current.version },
          after: {
            trashedAt: now,
            version: current.version + 1,
            groupId,
            cascaded: {
              attachments: childAttachments.length,
              notes: childNotes.length,
              annotations: childAnnotations.length,
            },
          },
          reason,
        },
        tx,
      );

      return {
        item: { ...current, trashedAt: now, dateModified: now, version: current.version + 1 },
        bibliographic:
          tx.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, id)).get() ?? null,
        office: tx.select().from(itemOffice).where(eq(itemOffice.itemId, id)).get() ?? null,
      };
    });
  }

  /**
   * Put a trashed item back, along with everything that went into the trash with it.
   *
   * A restore is a normal write (TR4): it bumps `version`, it is audited, and it closes the trash
   * rows rather than deleting them, so the history of "this was in the trash from Tuesday to
   * Thursday" survives.
   */
  restoreItem(id: string, actor: Actor): ItemRecord {
    return this.db.transaction((tx) => {
      const current = tx.select().from(items).where(eq(items.id, id)).get();
      if (current === undefined) throw new NotFoundError('item', id);

      const record = tx
        .select()
        .from(trash)
        .where(
          and(
            eq(trash.entityType, 'item'),
            eq(trash.entityId, id),
            isNull(trash.restoredAt),
            isNull(trash.purgedAt),
          ),
        )
        .get();

      if (record === undefined) {
        if (current.trashedAt === null) {
          // Already live and no open trash record: T1 holds, there is nothing to do.
          return {
            item: current,
            bibliographic:
              tx.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, id)).get() ?? null,
            office: tx.select().from(itemOffice).where(eq(itemOffice.itemId, id)).get() ?? null,
          };
        }
        throw new ConflictError(
          `Item '${id}' is trashed but has no open trash record, which breaks invariant T1. ` +
            'Repair it before restoring.',
          { itemId: id },
        );
      }

      const now = nowTimestamp();
      const group = record.groupId;
      const siblings =
        group === null
          ? [record]
          : tx
              .select()
              .from(trash)
              .where(and(eq(trash.groupId, group), isNull(trash.restoredAt), isNull(trash.purgedAt)))
              .all();

      let restoredChildren = 0;
      for (const row of siblings) {
        switch (row.entityType) {
          case 'item':
            tx.update(items)
              .set({ trashedAt: null, dateModified: now, version: current.version + 1 })
              .where(eq(items.id, row.entityId))
              .run();
            tx.update(itemBibliographic)
              .set({ itemTrashedAt: null, updatedAt: now })
              .where(eq(itemBibliographic.itemId, row.entityId))
              .run();
            tx.update(itemOffice)
              .set({ itemTrashedAt: null, updatedAt: now })
              .where(eq(itemOffice.itemId, row.entityId))
              .run();
            break;
          case 'attachment':
            tx.update(attachments)
              .set({ trashedAt: null, updatedAt: now })
              .where(eq(attachments.id, row.entityId))
              .run();
            restoredChildren += 1;
            break;
          case 'note':
            tx.update(notes)
              .set({ trashedAt: null, updatedAt: now })
              .where(eq(notes.id, row.entityId))
              .run();
            restoredChildren += 1;
            break;
          case 'annotation':
            tx.update(annotations)
              .set({ trashedAt: null, updatedAt: now })
              .where(eq(annotations.id, row.entityId))
              .run();
            restoredChildren += 1;
            break;
          default:
            throw new ConflictError(
              `Trash group ${String(group)} holds a '${row.entityType}', which restoring an item ` +
                'does not know how to put back.',
              { entityType: row.entityType, entityId: row.entityId },
            );
        }

        tx.update(trash)
          .set({ restoredAt: now, restoredByUserId: actor.userId ?? null })
          .where(eq(trash.id, row.id))
          .run();
      }

      this.audit.record(
        {
          actor,
          action: 'item.restored',
          entityType: 'item',
          entityId: id,
          before: { trashedAt: current.trashedAt, version: current.version },
          after: { trashedAt: null, version: current.version + 1, restoredChildren },
          reason: record.reason,
        },
        tx,
      );

      return {
        item: { ...current, trashedAt: null, dateModified: now, version: current.version + 1 },
        bibliographic:
          tx.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, id)).get() ?? null,
        office: tx.select().from(itemOffice).where(eq(itemOffice.itemId, id)).get() ?? null,
      };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Internals                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  /** One open `trash` row — the other half of invariant T1 (§1.5). */
  private openTrashRecord(
    tx: Pick<RecueilDatabase, 'insert'>,
    input: {
      entityType: (typeof trash.entityType)['_']['data'];
      entityId: string;
      groupId: string;
      now: string;
      reason: NonNullable<TrashOptions['reason']>;
      reasonDetail?: string | null;
      trashedByUserId: string | null;
      mergeTargetItemId?: string | null;
      restorePayload: Record<string, unknown>;
    },
  ): void {
    tx.insert(trash)
      .values({
        id: newId(),
        entityType: input.entityType,
        entityId: input.entityId,
        groupId: input.groupId,
        trashedAt: input.now,
        trashedByUserId: input.trashedByUserId,
        reason: input.reason,
        reasonDetail: input.reasonDetail ?? null,
        restorePayload: JSON.stringify(input.restorePayload),
        mergeTargetItemId: input.mergeTargetItemId ?? null,
      })
      .run();
  }

  /** A public key that is not taken. Eight Crockford characters collide about never, but check. */
  private mintPublicId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = newPublicId();
      const taken = this.db.select({ id: items.id }).from(items).where(eq(items.publicId, candidate)).get();
      if (taken === undefined) return candidate;
    }
    throw new ConflictError('Could not mint an unused public id in eight attempts.');
  }
}

/** Identifier columns are stored normalised, so the deduplicator compares with `=` (B1). */
const normaliseBibliographic = (input: BibliographicInput): BibliographicInput => {
  const values: BibliographicInput = { ...input };
  if (typeof values.doi === 'string') values.doi = normaliseDoi(values.doi);
  if (typeof values.publishedVersionDoi === 'string') {
    values.publishedVersionDoi = normaliseDoi(values.publishedVersionDoi);
  }
  if (typeof values.isbn === 'string') values.isbn = values.isbn.replace(/[^0-9Xx]/gu, '').toUpperCase();
  if (typeof values.issuedDate === 'string' && values.issuedYear === undefined) {
    const year = Number.parseInt(values.issuedDate.slice(0, 4), 10);
    if (Number.isInteger(year)) values.issuedYear = year;
  }
  return values;
};
