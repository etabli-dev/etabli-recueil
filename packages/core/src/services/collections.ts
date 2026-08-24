/**
 * Collections: the hierarchical filing structure, and saved searches (§4.1, §4.2).
 *
 * A saved search is a collection whose membership is a query rather than a list (CONCEPT §5.7),
 * which is what lets the UI, the API, the `.bib` endpoint and the export path treat both the same
 * way. The difference shows up in exactly one place here: `addItems` refuses a smart collection,
 * because C2 says a smart collection has no `collection_items` rows at all.
 *
 * Four invariants live in this file, and each is here rather than in the database because neither
 * dialect can express it:
 *
 * - **C1.** The hierarchy is a forest. `move` walks the ancestor chain of the proposed parent and
 *   refuses if the collection being moved is on it. There is no materialised path column to fall
 *   out of step; subtree queries are recursive CTEs, which both dialects support.
 * - **C2.** A smart collection holds no membership rows.
 * - **C3.** Trashing a collection trashes its descendants but never its items. The memberships are
 *   captured in the restore payload and removed; a restore puts them back.
 * - **C4.** A move rewrites `depth` for the whole subtree in one transaction.
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { collectionItems, collections, items } from '../db/schema.js';
import type { CollectionRow, ItemRow } from '../db/schema.js';
import { ConflictError, InvariantError, NotFoundError, ValidationError } from '../errors.js';
import { newId, newPublicId } from '../ids.js';
import { normalise } from '../normalise.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { AuditService } from './audit.js';
import { diffFields } from './audit.js';
import type { Page } from './cursor.js';
import { decodeCursor, encodeCursor, resolveLimit } from './cursor.js';
import type { SearchIndexer } from './search.js';
import type { TrashOptions } from './trash-record.js';
import {
  closeTrashRecord,
  findOpenTrashRecord,
  findTrashGroup,
  openTrashRecord,
  readRestorePayload,
} from './trash-record.js';

export type CollectionKind = 'manual' | 'smart';
export type MembershipSource = 'manual' | 'rule' | 'import' | 'connector' | 'merge' | 'plugin';

export interface CreateCollectionInput {
  name: string;
  parentId?: string | null;
  description?: string | null;
  colour?: string | null;
  position?: number;
  kind?: CollectionKind;
  /** Required when `kind` is `smart`: the saved search, in the API's structured query form. */
  query?: Record<string, unknown> | null;
  queryBackend?: 'fts5' | 'meilisearch' | 'sql' | null;
  ownerUserId?: string;
  /** Importers carry a Zotero collection key across; ordinary writes leave it unset. */
  publicId?: string;
}

export interface UpdateCollectionInput {
  name?: string;
  description?: string | null;
  colour?: string | null;
  position?: number;
  query?: Record<string, unknown> | null;
  queryBackend?: 'fts5' | 'meilisearch' | 'sql' | null;
}

export interface ListCollectionsOptions {
  parentId?: string | null;
  ownerUserId?: string;
  kind?: CollectionKind;
  includeTrashed?: boolean;
}

/** A collection with its children — the shape a sidebar renders. */
export interface CollectionNode {
  collection: CollectionRow;
  children: CollectionNode[];
}

export interface ListCollectionItemsOptions {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  includeTrashed?: boolean;
}

export class CollectionService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    private readonly defaultOwnerUserId: string,
    private readonly search?: SearchIndexer,
  ) {}

  /* ---------------------------------------------------------------------------------------- */
  /* Create, read                                                                                */
  /* ---------------------------------------------------------------------------------------- */

  create(input: CreateCollectionInput, actor: Actor): CollectionRow {
    const name = input.name.trim();
    if (name === '') throw new ValidationError('A collection needs a name.');

    const kind = input.kind ?? 'manual';
    if (kind === 'smart' && (input.query === undefined || input.query === null)) {
      throw new ValidationError(
        'A smart collection is a saved search and needs a query (§4.1, ck_collections_smart).',
      );
    }
    if (kind === 'manual' && input.query !== undefined && input.query !== null) {
      throw new ValidationError('A manual collection has a list, not a query (§4.1).');
    }

    const ownerUserId = input.ownerUserId ?? actor.userId ?? this.defaultOwnerUserId;

    return this.db.transaction((tx) => {
      const parentId = input.parentId ?? null;
      let depth = 0;
      if (parentId !== null) {
        const parent = tx.select().from(collections).where(eq(collections.id, parentId)).get();
        if (parent === undefined) throw new NotFoundError('collection', parentId);
        if (parent.trashedAt !== null) {
          throw new ConflictError(
            `Collection '${parentId}' is in the trash; restore it before filing under it.`,
            { collectionId: parentId },
          );
        }
        depth = parent.depth + 1;
      }

      const now = nowTimestamp();
      const row: CollectionRow = {
        id: newId(),
        publicId: input.publicId ?? this.mintPublicId(tx),
        name,
        nameNormalised: normalise(name),
        parentId,
        parentKey: parentId ?? '',
        ownerUserId,
        kind,
        query: input.query === undefined || input.query === null ? null : JSON.stringify(input.query),
        queryBackend: input.queryBackend ?? (kind === 'smart' ? 'fts5' : null),
        description: input.description ?? null,
        colour: input.colour ?? null,
        depth,
        position: input.position ?? this.nextPosition(tx, ownerUserId, parentId),
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
      };

      try {
        tx.insert(collections).values(row).run();
      } catch (error) {
        throw this.siblingNameConflict(error, name, parentId);
      }

      this.audit.record(
        {
          actor,
          action: 'collection.created',
          entityType: 'collection',
          entityId: row.id,
          after: { name: row.name, parentId, kind, depth },
        },
        tx,
      );

      return row;
    });
  }

  get(id: string, options: { includeTrashed?: boolean } = {}): CollectionRow {
    const row = this.db.select().from(collections).where(eq(collections.id, id)).get();
    if (row === undefined) throw new NotFoundError('collection', id);
    if (row.trashedAt !== null && options.includeTrashed !== true) {
      throw new NotFoundError('collection', id);
    }
    return row;
  }

  getByPublicId(publicId: string, options: { includeTrashed?: boolean } = {}): CollectionRow {
    const row = this.db.select().from(collections).where(eq(collections.publicId, publicId)).get();
    if (row === undefined) throw new NotFoundError('collection', publicId);
    return this.get(row.id, options);
  }

  /** A flat list, in sibling order. `parentId: null` asks for the roots specifically. */
  list(options: ListCollectionsOptions = {}): CollectionRow[] {
    const conditions = [];
    if (options.includeTrashed !== true) conditions.push(isNull(collections.trashedAt));
    if (options.ownerUserId !== undefined) {
      conditions.push(eq(collections.ownerUserId, options.ownerUserId));
    }
    if (options.kind !== undefined) conditions.push(eq(collections.kind, options.kind));
    if (options.parentId !== undefined) {
      conditions.push(
        options.parentId === null
          ? isNull(collections.parentId)
          : eq(collections.parentId, options.parentId),
      );
    }

    return this.db
      .select()
      .from(collections)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(collections.depth), asc(collections.position), asc(collections.nameNormalised))
      .all();
  }

  /**
   * The whole forest, as a tree.
   *
   * Built in one pass over the flat list rather than one query per level: a sidebar wants every
   * collection anyway, and N queries for a hierarchy that is three deep and two hundred wide is
   * the classic way to make a fast database look slow.
   */
  tree(options: Omit<ListCollectionsOptions, 'parentId'> = {}): CollectionNode[] {
    const rows = this.list(options);
    const nodes = new Map<string, CollectionNode>();
    for (const row of rows) nodes.set(row.id, { collection: row, children: [] });

    const roots: CollectionNode[] = [];
    for (const row of rows) {
      const node = nodes.get(row.id) as CollectionNode;
      const parent = row.parentId === null ? undefined : nodes.get(row.parentId);
      if (parent === undefined) roots.push(node);
      else parent.children.push(node);
    }
    return roots;
  }

  /** A collection and everything beneath it, the collection itself first (C1: a recursive CTE). */
  descendants(id: string, options: { includeTrashed?: boolean } = {}): CollectionRow[] {
    const rows = this.db.all<{ id: string }>(sql`
      with recursive subtree(id) as (
        select id from collections where id = ${id}
        union all
        select c.id from collections c join subtree s on c.parent_id = s.id
      )
      select id from subtree
    `);
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    const conditions = [inArray(collections.id, ids)];
    if (options.includeTrashed !== true) conditions.push(isNull(collections.trashedAt));

    return this.db
      .select()
      .from(collections)
      .where(and(...conditions))
      .orderBy(asc(collections.depth), asc(collections.position))
      .all();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Rename, update, move                                                                        */
  /* ---------------------------------------------------------------------------------------- */

  rename(id: string, name: string, actor: Actor): CollectionRow {
    return this.update(id, { name }, actor);
  }

  update(id: string, patch: UpdateCollectionInput, actor: Actor): CollectionRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(collections).where(eq(collections.id, id)).get();
      if (current === undefined) throw new NotFoundError('collection', id);
      if (current.trashedAt !== null) {
        throw new ConflictError(`Collection '${id}' is in the trash. Restore it before editing it.`, {
          collectionId: id,
        });
      }

      const name = patch.name === undefined ? current.name : patch.name.trim();
      if (name === '') throw new ValidationError('A collection needs a name.');

      if (patch.query !== undefined) {
        if (current.kind === 'manual' && patch.query !== null) {
          throw new ValidationError('A manual collection has a list, not a query (§4.1).');
        }
        if (current.kind === 'smart' && patch.query === null) {
          throw new ValidationError('A smart collection cannot lose its query; delete it instead.');
        }
      }

      const now = nowTimestamp();
      const next: Partial<CollectionRow> = {
        name,
        nameNormalised: normalise(name),
        description: patch.description !== undefined ? patch.description : current.description,
        colour: patch.colour !== undefined ? patch.colour : current.colour,
        position: patch.position ?? current.position,
        query:
          patch.query === undefined
            ? current.query
            : patch.query === null
              ? null
              : JSON.stringify(patch.query),
        queryBackend: patch.queryBackend !== undefined ? patch.queryBackend : current.queryBackend,
        updatedAt: now,
      };

      try {
        tx.update(collections).set(next).where(eq(collections.id, id)).run();
      } catch (error) {
        throw this.siblingNameConflict(error, name, current.parentId);
      }

      const delta = diffFields(current as unknown as Record<string, unknown>, {
        name: next.name,
        description: next.description,
        colour: next.colour,
        position: next.position,
        query: next.query,
      });

      this.audit.record(
        {
          actor,
          action: 'collection.updated',
          entityType: 'collection',
          entityId: id,
          before: delta.before,
          after: delta.after,
        },
        tx,
      );

      return { ...current, ...next } as CollectionRow;
    });
  }

  /**
   * Re-file a collection under a new parent, or at the root.
   *
   * The cycle check is the reason this is not an `UPDATE`. C1 says the hierarchy is a forest, and
   * neither SQLite nor Postgres can say so in a constraint, so the ancestor chain of the proposed
   * parent is walked here: if the collection being moved is on it — or *is* it — the move is
   * refused with an `InvariantError` naming C1, and the library is left as it was.
   *
   * `depth` is then rewritten for the entire subtree in the same transaction (C4), because a
   * denormalised depth that is right for the moved node and wrong for its children is worse than
   * no depth column at all.
   */
  move(id: string, parentId: string | null, actor: Actor): CollectionRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(collections).where(eq(collections.id, id)).get();
      if (current === undefined) throw new NotFoundError('collection', id);
      if (current.trashedAt !== null) {
        throw new ConflictError(`Collection '${id}' is in the trash. Restore it before moving it.`, {
          collectionId: id,
        });
      }

      let depth = 0;
      if (parentId !== null) {
        if (parentId === id) {
          throw new InvariantError(
            'C1',
            `Collection '${id}' cannot be its own parent — the hierarchy is a forest.`,
            { collectionId: id, parentId },
          );
        }

        const parent = tx.select().from(collections).where(eq(collections.id, parentId)).get();
        if (parent === undefined) throw new NotFoundError('collection', parentId);
        if (parent.trashedAt !== null) {
          throw new ConflictError(
            `Collection '${parentId}' is in the trash; restore it before filing under it.`,
            { collectionId: parentId },
          );
        }

        // Walk up from the proposed parent. Reaching `id` means the move would close a cycle.
        const chain: string[] = [];
        let cursor: string | null = parent.parentId;
        while (cursor !== null) {
          if (cursor === id) {
            throw new InvariantError(
              'C1',
              `Moving collection '${id}' under '${parentId}' would create a cycle: ` +
                `'${parentId}' is already a descendant of it.`,
              { collectionId: id, parentId, ancestors: [parentId, ...chain] },
            );
          }
          chain.push(cursor);
          const next: CollectionRow | undefined = tx
            .select()
            .from(collections)
            .where(eq(collections.id, cursor))
            .get();
          if (next === undefined) break;
          cursor = next.parentId;
          if (chain.length > 1024) {
            throw new InvariantError(
              'C1',
              'The collection hierarchy already contains a cycle; repair it before moving anything.',
              { collectionId: id },
            );
          }
        }

        depth = parent.depth + 1;
      }

      const now = nowTimestamp();

      // `position` orders siblings, and the collection is about to have different ones. Keeping
      // the old number lands it on top of whichever sibling already holds it, which makes the
      // sidebar order depend on the row order of a tie-break rather than on anything a person
      // chose. Moved collections go to the end of their new parent, which is where a person who
      // has just filed something expects to find it; a caller who wants it elsewhere calls
      // `update` with a position afterwards.
      const position =
        parentId === current.parentId
          ? current.position
          : this.nextPosition(tx, current.ownerUserId, parentId);

      try {
        tx.update(collections)
          .set({ parentId, parentKey: parentId ?? '', depth, position, updatedAt: now })
          .where(eq(collections.id, id))
          .run();
      } catch (error) {
        throw this.siblingNameConflict(error, current.name, parentId);
      }

      // C4: the whole subtree's depth, in this transaction.
      tx.run(sql`
        with recursive subtree(id, depth) as (
          select id, ${depth} from collections where id = ${id}
          union all
          select c.id, s.depth + 1 from collections c join subtree s on c.parent_id = s.id
        )
        update collections
           set depth = (select depth from subtree where subtree.id = collections.id),
               updated_at = ${now}
         where id in (select id from subtree)
      `);

      this.audit.record(
        {
          actor,
          action: 'collection.moved',
          entityType: 'collection',
          entityId: id,
          before: { parentId: current.parentId, depth: current.depth, position: current.position },
          after: { parentId, depth, position },
        },
        tx,
      );

      return { ...current, parentId, parentKey: parentId ?? '', depth, position, updatedAt: now };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Membership                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * File items into a collection.
   *
   * Idempotent (P9): an item already in the collection is left where it is rather than raising, so
   * a retried bulk request does not fail halfway. The return value is the number actually added.
   */
  addItems(
    collectionId: string,
    itemIds: readonly string[],
    actor: Actor,
    options: { source?: MembershipSource } = {},
  ): number {
    if (itemIds.length === 0) return 0;

    return this.db.transaction((tx) => {
      const collection = tx.select().from(collections).where(eq(collections.id, collectionId)).get();
      if (collection === undefined) throw new NotFoundError('collection', collectionId);
      if (collection.trashedAt !== null) {
        throw new ConflictError(`Collection '${collectionId}' is in the trash.`, { collectionId });
      }
      if (collection.kind === 'smart') {
        throw new InvariantError(
          'C2',
          `Collection '${collectionId}' is a saved search: its membership is its query, and rows ` +
            'cannot be added to it by hand.',
          { collectionId },
        );
      }

      const now = nowTimestamp();
      let position = this.nextMembershipPosition(tx, collectionId);
      const added: string[] = [];

      for (const itemId of new Set(itemIds)) {
        const item = tx.select().from(items).where(eq(items.id, itemId)).get();
        if (item === undefined) throw new NotFoundError('item', itemId);

        const existing = tx
          .select({ itemId: collectionItems.itemId })
          .from(collectionItems)
          .where(
            and(
              eq(collectionItems.collectionId, collectionId),
              eq(collectionItems.itemId, itemId),
            ),
          )
          .get();
        if (existing !== undefined) continue;

        tx.insert(collectionItems)
          .values({
            collectionId,
            itemId,
            position,
            addedAt: now,
            addedByUserId: actor.userId ?? null,
            source: options.source ?? 'manual',
          })
          .run();
        position += 1;
        added.push(itemId);
      }

      if (added.length > 0) {
        this.audit.record(
          {
            actor,
            action: 'collection.items_added',
            entityType: 'collection',
            entityId: collectionId,
            after: { itemIds: added, source: options.source ?? 'manual' },
          },
          tx,
        );
      }

      return added.length;
    });
  }

  /**
   * Take items out of a collection.
   *
   * A membership row is hard-deleted, not trashed: §1.5 lists join rows as reconstructible from
   * `audit_log` and from the parent's restore payload, and a soft-deleted membership would need a
   * predicate on every query that reads one.
   */
  removeItems(collectionId: string, itemIds: readonly string[], actor: Actor): number {
    if (itemIds.length === 0) return 0;

    return this.db.transaction((tx) => {
      const collection = tx.select().from(collections).where(eq(collections.id, collectionId)).get();
      if (collection === undefined) throw new NotFoundError('collection', collectionId);

      const present = tx
        .select({ itemId: collectionItems.itemId })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionId, collectionId),
            inArray(collectionItems.itemId, [...itemIds]),
          ),
        )
        .all()
        .map((row) => row.itemId);
      if (present.length === 0) return 0;

      tx.delete(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionId, collectionId),
            inArray(collectionItems.itemId, present),
          ),
        )
        .run();

      this.audit.record(
        {
          actor,
          action: 'collection.items_removed',
          entityType: 'collection',
          entityId: collectionId,
          before: { itemIds: present },
        },
        tx,
      );

      return present.length;
    });
  }

  /** A page of the items in a collection, in membership order. */
  listItems(collectionId: string, options: ListCollectionItemsOptions = {}): Page<ItemRow> {
    const collection = this.get(collectionId, { includeTrashed: true });
    if (collection.kind === 'smart') {
      throw new InvariantError(
        'C2',
        `Collection '${collectionId}' is a saved search; run its query rather than listing rows.`,
        { collectionId, query: collection.query },
      );
    }

    const limit = resolveLimit(options.limit);
    const order = options.order ?? 'asc';
    const sortKey = sql<string>`printf('%012d', ${collectionItems.position})`;

    const conditions = [
      eq(collectionItems.collectionId, collectionId),
      sql`${items.libraryState} <> 'merged'`,
    ];
    if (options.includeTrashed !== true) conditions.push(isNull(items.trashedAt));

    if (options.cursor !== undefined) {
      const { k, i } = decodeCursor(options.cursor);
      conditions.push(
        order === 'desc'
          ? or(lt(sortKey, k), and(eq(sortKey, k), lt(items.id, i)))!
          : or(gt(sortKey, k), and(eq(sortKey, k), gt(items.id, i)))!,
      );
    }

    const direction = order === 'desc' ? desc : asc;
    const rows = this.db
      .select({ item: items, sortKey })
      .from(collectionItems)
      .innerJoin(items, eq(items.id, collectionItems.itemId))
      .where(and(...conditions))
      .orderBy(direction(sortKey), direction(items.id))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      data: page.map((row) => row.item),
      page: {
        nextCursor:
          hasMore && last !== undefined ? encodeCursor({ k: last.sortKey, i: last.item.id }) : null,
        hasMore,
        limit,
      },
    };
  }

  /** How many live items are in a collection. */
  countItems(collectionId: string): number {
    return (
      this.db
        .select({ value: count() })
        .from(collectionItems)
        .innerJoin(items, eq(items.id, collectionItems.itemId))
        .where(and(eq(collectionItems.collectionId, collectionId), isNull(items.trashedAt)))
        .get()?.value ?? 0
    );
  }

  /** Every live collection an item is filed in — the reverse lookup the item pane needs. */
  forItem(itemId: string): CollectionRow[] {
    return this.db
      .select({ collection: collections })
      .from(collectionItems)
      .innerJoin(collections, eq(collections.id, collectionItems.collectionId))
      .where(and(eq(collectionItems.itemId, itemId), isNull(collections.trashedAt)))
      .orderBy(asc(collections.nameNormalised))
      .all()
      .map((row) => row.collection);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Trash and restore (P5, C3)                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Trash a collection and its descendants, but never its items (C3).
   *
   * The memberships of every trashed collection are captured in that collection's own restore
   * payload and then removed, so that an item stops appearing under a folder that is in the bin
   * while the item itself stays exactly where it was in the library.
   */
  trash(id: string, actor: Actor, options: TrashOptions = {}): CollectionRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(collections).where(eq(collections.id, id)).get();
      if (current === undefined) throw new NotFoundError('collection', id);
      if (current.trashedAt !== null) return current;

      const now = nowTimestamp();
      const groupId = newId();
      const trashedByUserId = actor.userId ?? null;

      const subtree = tx.all<{ id: string }>(sql`
        with recursive sub(id) as (
          select id from collections where id = ${id}
          union all
          select c.id from collections c join sub on c.parent_id = sub.id
        )
        select id from sub
      `);

      let detachedMemberships = 0;
      for (const node of subtree) {
        const row = tx.select().from(collections).where(eq(collections.id, node.id)).get();
        if (row === undefined || row.trashedAt !== null) continue;

        const memberships = tx
          .select()
          .from(collectionItems)
          .where(eq(collectionItems.collectionId, node.id))
          .all();
        if (memberships.length > 0) {
          tx.delete(collectionItems).where(eq(collectionItems.collectionId, node.id)).run();
          detachedMemberships += memberships.length;
        }

        tx.update(collections)
          .set({ trashedAt: now, updatedAt: now })
          .where(eq(collections.id, node.id))
          .run();

        openTrashRecord(tx, {
          entityType: 'collection',
          entityId: node.id,
          groupId,
          trashedAt: now,
          trashedByUserId,
          reason: node.id === id ? (options.reason ?? 'user') : 'cascade',
          reasonDetail: node.id === id ? (options.reasonDetail ?? null) : `collection ${id} trashed`,
          restorePayload: {
            parentId: row.parentId,
            depth: row.depth,
            position: row.position,
            memberships: memberships.map((membership) => ({
              itemId: membership.itemId,
              position: membership.position,
              addedAt: membership.addedAt,
              addedByUserId: membership.addedByUserId,
              source: membership.source,
            })),
          },
        });

        for (const membership of memberships) this.search?.indexItem(membership.itemId, tx);
      }

      this.audit.record(
        {
          actor,
          action: 'collection.trashed',
          entityType: 'collection',
          entityId: id,
          before: { trashedAt: null },
          after: { trashedAt: now, groupId, descendants: subtree.length - 1, detachedMemberships },
          reason: options.reason ?? 'user',
        },
        tx,
      );

      return { ...current, trashedAt: now, updatedAt: now };
    });
  }

  /** Put a collection back, with its descendants and every membership that went with them (C3). */
  restore(id: string, actor: Actor): CollectionRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(collections).where(eq(collections.id, id)).get();
      if (current === undefined) throw new NotFoundError('collection', id);

      const record = findOpenTrashRecord(tx, 'collection', id);
      if (record === undefined) {
        if (current.trashedAt === null) return current;
        throw new ConflictError(
          `Collection '${id}' is trashed but has no open trash record, which breaks invariant T1.`,
          { collectionId: id },
        );
      }

      const now = nowTimestamp();
      const siblings = record.groupId === null ? [record] : findTrashGroup(tx, record.groupId);
      let restoredMemberships = 0;

      for (const row of siblings) {
        if (row.entityType !== 'collection') continue;

        tx.update(collections)
          .set({ trashedAt: null, updatedAt: now })
          .where(eq(collections.id, row.entityId))
          .run();

        const payload = readRestorePayload(row);
        const memberships = Array.isArray(payload['memberships']) ? payload['memberships'] : [];
        for (const entry of memberships) {
          if (typeof entry !== 'object' || entry === null) continue;
          const membership = entry as {
            itemId?: unknown;
            position?: unknown;
            addedAt?: unknown;
            addedByUserId?: unknown;
            source?: unknown;
          };
          if (typeof membership.itemId !== 'string') continue;

          // The item may have been purged or re-filed in the meantime; a membership that cannot be
          // put back is skipped, not fatal. The trash row keeps the record of what it was.
          const item = tx.select({ id: items.id }).from(items).where(eq(items.id, membership.itemId)).get();
          if (item === undefined) continue;

          tx.insert(collectionItems)
            .values({
              collectionId: row.entityId,
              itemId: membership.itemId,
              position: typeof membership.position === 'number' ? membership.position : 0,
              addedAt: typeof membership.addedAt === 'string' ? membership.addedAt : now,
              addedByUserId:
                typeof membership.addedByUserId === 'string' ? membership.addedByUserId : null,
              source: isMembershipSource(membership.source) ? membership.source : 'manual',
            })
            .onConflictDoNothing()
            .run();
          restoredMemberships += 1;
          this.search?.indexItem(membership.itemId, tx);
        }

        closeTrashRecord(tx, row.id, now, actor.userId ?? null);
      }

      this.audit.record(
        {
          actor,
          action: 'collection.restored',
          entityType: 'collection',
          entityId: id,
          before: { trashedAt: current.trashedAt },
          after: { trashedAt: null, restoredMemberships, restoredCollections: siblings.length },
          reason: record.reason,
        },
        tx,
      );

      return { ...current, trashedAt: null, updatedAt: now };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Internals                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  private nextPosition(
    tx: Pick<RecueilDatabase, 'select'>,
    ownerUserId: string,
    parentId: string | null,
  ): number {
    const row = tx
      .select({ value: sql<number>`coalesce(max(${collections.position}), -1)` })
      .from(collections)
      .where(
        and(eq(collections.ownerUserId, ownerUserId), eq(collections.parentKey, parentId ?? '')),
      )
      .get();
    return (row?.value ?? -1) + 1;
  }

  private nextMembershipPosition(tx: Pick<RecueilDatabase, 'select'>, collectionId: string): number {
    const row = tx
      .select({ value: sql<number>`coalesce(max(${collectionItems.position}), -1)` })
      .from(collectionItems)
      .where(eq(collectionItems.collectionId, collectionId))
      .get();
    return (row?.value ?? -1) + 1;
  }

  /**
   * Turn the partial unique index into the error the caller can act on.
   *
   * `ux_collections_sibling_name` is a real constraint and the right place for the rule; a raw
   * `SQLITE_CONSTRAINT` message is not something an API caller should ever see. SQLite names the
   * columns rather than the index in its message, so the match is on the column list — which is
   * also why it is written out here rather than pattern-matched loosely: a different unique
   * violation must keep its own error.
   */
  private siblingNameConflict(error: unknown, name: string, parentId: string | null): unknown {
    const message = error instanceof Error ? error.message : String(error);
    const isSiblingClash =
      /ux_collections_sibling_name/u.test(message) ||
      (/UNIQUE constraint failed/iu.test(message) && /collections\.name_normalised/u.test(message));
    if (!isSiblingClash) return error;
    return new ConflictError(
      `A collection called '${name}' already exists ${
        parentId === null ? 'at the root' : `under '${parentId}'`
      }.`,
      { name, parentId },
    );
  }

  private mintPublicId(tx: Pick<RecueilDatabase, 'select'>): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = newPublicId();
      const taken = tx
        .select({ id: collections.id })
        .from(collections)
        .where(eq(collections.publicId, candidate))
        .get();
      if (taken === undefined) return candidate;
    }
    throw new ConflictError('Could not mint an unused public id in eight attempts.');
  }
}

const MEMBERSHIP_SOURCE_VALUES: readonly MembershipSource[] = [
  'manual',
  'rule',
  'import',
  'connector',
  'merge',
  'plugin',
];

const isMembershipSource = (value: unknown): value is MembershipSource =>
  typeof value === 'string' && (MEMBERSHIP_SOURCE_VALUES as readonly string[]).includes(value);
