/**
 * Tags and tag assignments (§4.3, §4.4).
 *
 * A tag is something a person typed. A `term` — arriving with the graph phase — is a
 * controlled-vocabulary entry, and the two are deliberately different tables; this service knows
 * only about the first.
 *
 * Two invariants shape the API:
 *
 * - **TG1.** Renaming a tag is an update, not a create-and-remap. Assignments key on the tag id, so
 *   they follow the rename without being touched, which is exactly why the id and not the name is
 *   the key.
 * - **TG2.** Merging two tags is a merge like any other, and leaves a reversible record in `trash`:
 *   the loser's assignments move to the winner, the merge record says which ones were newly created
 *   as opposed to already present, and the loser is trashed rather than deleted.
 *
 * Assignments carry their own provenance in the P4 sense the join-row mechanism prescribes (§1.6):
 * a `source`, the `rule_ref` of the ingestion rule that applied it, and a confidence. "Why is this
 * tagged?" is a column, not an archaeology exercise.
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { itemTags, items, tags } from '../db/schema.js';
import type { ItemRow, TagRow } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../ids.js';
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
  openTrashRecord,
  readRestorePayload,
} from './trash-record.js';

export type TagScheme = 'manual' | 'automatic' | 'imported';
export type TagAssignmentSource = 'manual' | 'rule' | 'resolver' | 'import' | 'plugin' | 'merge';

export interface CreateTagInput {
  name: string;
  colour?: string | null;
  /** `automatic` is a tag a rule or resolver added — Zotero's tag type 1. */
  scheme?: TagScheme;
  position?: number;
  ownerUserId?: string;
}

export interface UpdateTagInput {
  name?: string;
  colour?: string | null;
  scheme?: TagScheme;
  position?: number;
}

export interface ListTagsOptions {
  ownerUserId?: string;
  scheme?: TagScheme;
  /** Case-insensitive prefix over the normalised name — the tag autocomplete. */
  prefix?: string;
  includeTrashed?: boolean;
  limit?: number;
}

export interface AssignTagOptions {
  source?: TagAssignmentSource;
  /** The ingestion rule that applied it (CONCEPT §5.3 stage 8). */
  ruleRef?: string | null;
  confidence?: number | null;
}

/** A tag with how many live items carry it — what a tag sidebar shows. */
export interface TagWithCount {
  tag: TagRow;
  itemCount: number;
}

export class TagService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    private readonly defaultOwnerUserId: string,
    private readonly search?: SearchIndexer,
  ) {}

  /* ---------------------------------------------------------------------------------------- */
  /* Create and read                                                                             */
  /* ---------------------------------------------------------------------------------------- */

  create(input: CreateTagInput, actor: Actor): TagRow {
    const name = input.name.trim();
    if (name === '') throw new ValidationError('A tag needs a name.');

    const ownerUserId = input.ownerUserId ?? actor.userId ?? this.defaultOwnerUserId;
    const nameNormalised = normalise(name);

    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(tags)
        .where(
          and(
            eq(tags.ownerUserId, ownerUserId),
            eq(tags.nameNormalised, nameNormalised),
            isNull(tags.trashedAt),
          ),
        )
        .get();
      if (existing !== undefined) {
        throw new ConflictError(`A tag called '${existing.name}' already exists.`, {
          tagId: existing.id,
          name: existing.name,
        });
      }

      const now = nowTimestamp();
      const row: TagRow = {
        id: newId(),
        name,
        nameNormalised,
        colour: input.colour ?? null,
        scheme: input.scheme ?? 'manual',
        ownerUserId,
        position: input.position ?? 0,
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
      };
      tx.insert(tags).values(row).run();

      this.audit.record(
        {
          actor,
          action: 'tag.created',
          entityType: 'tag',
          entityId: row.id,
          after: { name: row.name, scheme: row.scheme, colour: row.colour },
        },
        tx,
      );

      return row;
    });
  }

  /**
   * The tag with this name, creating it if it is new.
   *
   * The workhorse of every importer and every rule: tagging by name has to be idempotent, or a
   * second import run produces a second `machine learning`.
   */
  ensure(name: string, actor: Actor, options: Omit<CreateTagInput, 'name'> = {}): TagRow {
    const ownerUserId = options.ownerUserId ?? actor.userId ?? this.defaultOwnerUserId;
    const existing = this.findByName(name, ownerUserId);
    if (existing !== undefined) return existing;
    return this.create({ ...options, name, ownerUserId }, actor);
  }

  get(id: string, options: { includeTrashed?: boolean } = {}): TagRow {
    const row = this.db.select().from(tags).where(eq(tags.id, id)).get();
    if (row === undefined) throw new NotFoundError('tag', id);
    if (row.trashedAt !== null && options.includeTrashed !== true) throw new NotFoundError('tag', id);
    return row;
  }

  /** Lookup by name, case- and whitespace-insensitively (§1.1's normalised mirror). */
  findByName(name: string, ownerUserId?: string): TagRow | undefined {
    return this.db
      .select()
      .from(tags)
      .where(
        and(
          eq(tags.ownerUserId, ownerUserId ?? this.defaultOwnerUserId),
          eq(tags.nameNormalised, normalise(name)),
          isNull(tags.trashedAt),
        ),
      )
      .get();
  }

  list(options: ListTagsOptions = {}): TagRow[] {
    const conditions = [];
    if (options.includeTrashed !== true) conditions.push(isNull(tags.trashedAt));
    if (options.ownerUserId !== undefined) conditions.push(eq(tags.ownerUserId, options.ownerUserId));
    if (options.scheme !== undefined) conditions.push(eq(tags.scheme, options.scheme));
    if (options.prefix !== undefined && options.prefix.trim() !== '') {
      const prefix = normalise(options.prefix).replaceAll('%', '\\%').replaceAll('_', '\\_');
      conditions.push(sql`${tags.nameNormalised} like ${`${prefix}%`} escape '\\'`);
    }

    const query = this.db
      .select()
      .from(tags)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(tags.position), asc(tags.nameNormalised));

    return options.limit === undefined ? query.all() : query.limit(resolveLimit(options.limit)).all();
  }

  /** The same list with live item counts beside it. One query, not one per tag. */
  listWithCounts(options: ListTagsOptions = {}): TagWithCount[] {
    const tagRows = this.list(options);
    if (tagRows.length === 0) return [];

    const counts = new Map<string, number>();
    for (const row of this.db
      .select({ tagId: itemTags.tagId, value: count() })
      .from(itemTags)
      .innerJoin(items, eq(items.id, itemTags.itemId))
      .where(and(inArray(itemTags.tagId, tagRows.map((row) => row.id)), isNull(items.trashedAt)))
      .groupBy(itemTags.tagId)
      .all()) {
      counts.set(row.tagId, row.value);
    }

    return tagRows.map((tag) => ({ tag, itemCount: counts.get(tag.id) ?? 0 }));
  }

  /** The tags on one item, with the assignment metadata that says why each is there. */
  forItem(itemId: string): Array<TagRow & { source: TagAssignmentSource; ruleRef: string | null; confidence: number | null }> {
    return this.db
      .select({
        tag: tags,
        source: itemTags.source,
        ruleRef: itemTags.ruleRef,
        confidence: itemTags.confidence,
      })
      .from(itemTags)
      .innerJoin(tags, eq(tags.id, itemTags.tagId))
      .where(and(eq(itemTags.itemId, itemId), isNull(tags.trashedAt)))
      .orderBy(asc(tags.position), asc(tags.nameNormalised))
      .all()
      .map((row) => ({
        ...row.tag,
        source: row.source,
        ruleRef: row.ruleRef,
        confidence: row.confidence,
      }));
  }

  /** A page of the items carrying a tag, newest first by default. */
  listItems(
    tagId: string,
    options: { limit?: number; cursor?: string; order?: 'asc' | 'desc'; includeTrashed?: boolean } = {},
  ): Page<ItemRow> {
    const limit = resolveLimit(options.limit);
    const order = options.order ?? 'desc';

    const conditions = [eq(itemTags.tagId, tagId), sql`${items.libraryState} <> 'merged'`];
    if (options.includeTrashed !== true) conditions.push(isNull(items.trashedAt));

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
      .select({ item: items })
      .from(itemTags)
      .innerJoin(items, eq(items.id, itemTags.itemId))
      .where(and(...conditions))
      .orderBy(direction(items.dateModified), direction(items.id))
      .limit(limit + 1)
      .all()
      .map((row) => row.item);

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

  /* ---------------------------------------------------------------------------------------- */
  /* Update                                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  /** TG1: a rename is an update. Every assignment follows it, because they key on the id. */
  rename(id: string, name: string, actor: Actor): TagRow {
    return this.update(id, { name }, actor);
  }

  update(id: string, patch: UpdateTagInput, actor: Actor): TagRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(tags).where(eq(tags.id, id)).get();
      if (current === undefined) throw new NotFoundError('tag', id);
      if (current.trashedAt !== null) {
        throw new ConflictError(`Tag '${id}' is in the trash. Restore it before editing it.`, {
          tagId: id,
        });
      }

      const name = patch.name === undefined ? current.name : patch.name.trim();
      if (name === '') throw new ValidationError('A tag needs a name.');

      const now = nowTimestamp();
      const next = {
        name,
        nameNormalised: normalise(name),
        colour: patch.colour !== undefined ? patch.colour : current.colour,
        scheme: patch.scheme ?? current.scheme,
        position: patch.position ?? current.position,
        updatedAt: now,
      };

      try {
        tx.update(tags).set(next).where(eq(tags.id, id)).run();
      } catch (error) {
        // SQLite names the columns rather than the index in a unique-violation message.
        const message = error instanceof Error ? error.message : String(error);
        if (/ux_tags_owner_name/u.test(message) || /tags\.name_normalised/u.test(message)) {
          throw new ConflictError(
            `A tag called '${name}' already exists. Merge the two rather than renaming into a clash.`,
            { tagId: id, name },
          );
        }
        throw error;
      }

      const delta = diffFields(current as unknown as Record<string, unknown>, {
        name: next.name,
        colour: next.colour,
        scheme: next.scheme,
        position: next.position,
      });
      this.audit.record(
        {
          actor,
          action: 'tag.updated',
          entityType: 'tag',
          entityId: id,
          before: delta.before,
          after: delta.after,
        },
        tx,
      );

      if (next.name !== current.name) {
        for (const row of tx
          .select({ itemId: itemTags.itemId })
          .from(itemTags)
          .where(eq(itemTags.tagId, id))
          .all()) {
          this.search?.indexItem(row.itemId, tx);
        }
      }

      return { ...current, ...next };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Assignment                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  /** Put a tag on an item. Idempotent: a second call refreshes the assignment metadata. */
  assign(itemId: string, tagId: string, actor: Actor, options: AssignTagOptions = {}): void {
    this.db.transaction((tx) => {
      const item = tx.select({ id: items.id }).from(items).where(eq(items.id, itemId)).get();
      if (item === undefined) throw new NotFoundError('item', itemId);
      const tag = tx.select().from(tags).where(eq(tags.id, tagId)).get();
      if (tag === undefined) throw new NotFoundError('tag', tagId);
      if (tag.trashedAt !== null) {
        throw new ConflictError(`Tag '${tagId}' is in the trash.`, { tagId });
      }

      const now = nowTimestamp();
      const values = {
        source: options.source ?? 'manual',
        ruleRef: options.ruleRef ?? null,
        confidence: options.confidence ?? null,
      };

      const existing = tx
        .select()
        .from(itemTags)
        .where(and(eq(itemTags.itemId, itemId), eq(itemTags.tagId, tagId)))
        .get();

      if (existing === undefined) {
        tx.insert(itemTags)
          .values({ itemId, tagId, ...values, addedAt: now, addedByUserId: actor.userId ?? null })
          .run();
      } else {
        tx.update(itemTags)
          .set(values)
          .where(and(eq(itemTags.itemId, itemId), eq(itemTags.tagId, tagId)))
          .run();
      }

      this.audit.record(
        {
          actor,
          action: existing === undefined ? 'tag.assigned' : 'tag.reassigned',
          entityType: 'item',
          entityId: itemId,
          after: { tagId, name: tag.name, ...values },
        },
        tx,
      );

      this.search?.indexItem(itemId, tx);
    });
  }

  /** Tag by name, creating the tag if it is new. The shape a rule engine and an importer want. */
  assignByName(
    itemId: string,
    name: string,
    actor: Actor,
    options: AssignTagOptions & { scheme?: TagScheme; ownerUserId?: string } = {},
  ): TagRow {
    const tag = this.ensure(name, actor, {
      scheme: options.scheme ?? (options.source === 'manual' || options.source === undefined ? 'manual' : 'automatic'),
      ownerUserId: options.ownerUserId,
    });
    this.assign(itemId, tag.id, actor, options);
    return tag;
  }

  /** Take a tag off an item. The assignment row is hard-deleted (§1.5: join rows are). */
  unassign(itemId: string, tagId: string, actor: Actor): boolean {
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(itemTags)
        .where(and(eq(itemTags.itemId, itemId), eq(itemTags.tagId, tagId)))
        .get();
      if (existing === undefined) return false;

      tx.delete(itemTags)
        .where(and(eq(itemTags.itemId, itemId), eq(itemTags.tagId, tagId)))
        .run();

      this.audit.record(
        {
          actor,
          action: 'tag.unassigned',
          entityType: 'item',
          entityId: itemId,
          before: { tagId, source: existing.source, ruleRef: existing.ruleRef },
        },
        tx,
      );

      this.search?.indexItem(itemId, tx);
      return true;
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Merge (TG2)                                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Fold one tag into another.
   *
   * Every assignment of the loser moves to the winner; where the winner already carried the tag,
   * the loser's row is simply dropped. Which assignments were newly created is written into the
   * merge record, so that reversing the merge removes exactly those and leaves the winner's own
   * assignments alone. The loser is trashed, not deleted (P5).
   */
  merge(loserId: string, winnerId: string, actor: Actor): { winner: TagRow; moved: number } {
    if (loserId === winnerId) {
      throw new ValidationError('A tag cannot be merged into itself.', { tagId: loserId });
    }

    return this.db.transaction((tx) => {
      const loser = tx.select().from(tags).where(eq(tags.id, loserId)).get();
      if (loser === undefined) throw new NotFoundError('tag', loserId);
      const winner = tx.select().from(tags).where(eq(tags.id, winnerId)).get();
      if (winner === undefined) throw new NotFoundError('tag', winnerId);
      if (loser.trashedAt !== null) {
        throw new ConflictError(`Tag '${loserId}' is already in the trash.`, { tagId: loserId });
      }
      if (winner.trashedAt !== null) {
        throw new ConflictError(`Tag '${winnerId}' is in the trash and cannot win a merge.`, {
          tagId: winnerId,
        });
      }

      const now = nowTimestamp();
      const assignments = tx.select().from(itemTags).where(eq(itemTags.tagId, loserId)).all();

      const movedItemIds: string[] = [];
      const collapsedItemIds: string[] = [];

      for (const assignment of assignments) {
        const alreadyThere = tx
          .select({ itemId: itemTags.itemId })
          .from(itemTags)
          .where(and(eq(itemTags.itemId, assignment.itemId), eq(itemTags.tagId, winnerId)))
          .get();

        if (alreadyThere === undefined) {
          tx.insert(itemTags)
            .values({
              itemId: assignment.itemId,
              tagId: winnerId,
              source: 'merge',
              ruleRef: assignment.ruleRef,
              confidence: assignment.confidence,
              addedAt: now,
              addedByUserId: actor.userId ?? null,
            })
            .run();
          movedItemIds.push(assignment.itemId);
        } else {
          collapsedItemIds.push(assignment.itemId);
        }
      }

      tx.delete(itemTags).where(eq(itemTags.tagId, loserId)).run();
      tx.update(tags).set({ trashedAt: now, updatedAt: now }).where(eq(tags.id, loserId)).run();

      openTrashRecord(tx, {
        entityType: 'tag',
        entityId: loserId,
        groupId: newId(),
        trashedAt: now,
        trashedByUserId: actor.userId ?? null,
        reason: 'merge',
        reasonDetail: `merged into tag ${winnerId}`,
        // `merge_target_item_id` is an item column and does not apply to a tag merge; the winner
        // is recorded in the merge record instead, which is what the reversal reads.
        mergeRecord: { winnerTagId: winnerId, movedItemIds, collapsedItemIds },
        restorePayload: {
          assignments: assignments.map((assignment) => ({
            itemId: assignment.itemId,
            source: assignment.source,
            ruleRef: assignment.ruleRef,
            confidence: assignment.confidence,
            addedAt: assignment.addedAt,
            addedByUserId: assignment.addedByUserId,
          })),
          winnerTagId: winnerId,
        },
      });

      this.audit.record(
        {
          actor,
          action: 'tag.merged',
          entityType: 'tag',
          entityId: loserId,
          before: { name: loser.name, assignments: assignments.length },
          after: { winnerTagId: winnerId, moved: movedItemIds.length, collapsed: collapsedItemIds.length },
          reason: 'merge (TG2)',
        },
        tx,
      );

      for (const itemId of new Set([...movedItemIds, ...collapsedItemIds])) {
        this.search?.indexItem(itemId, tx);
      }

      return { winner, moved: movedItemIds.length };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Trash and restore (P5)                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Trash a tag.
   *
   * Its assignments come off the items and go into the restore payload, so an item stops showing a
   * tag that is in the bin, and a restore puts every assignment back exactly as it was — including
   * the source and rule reference that said why it was there.
   */
  trash(id: string, actor: Actor, options: TrashOptions = {}): TagRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(tags).where(eq(tags.id, id)).get();
      if (current === undefined) throw new NotFoundError('tag', id);
      if (current.trashedAt !== null) return current;

      const now = nowTimestamp();
      const assignments = tx.select().from(itemTags).where(eq(itemTags.tagId, id)).all();
      if (assignments.length > 0) tx.delete(itemTags).where(eq(itemTags.tagId, id)).run();

      tx.update(tags).set({ trashedAt: now, updatedAt: now }).where(eq(tags.id, id)).run();

      openTrashRecord(tx, {
        entityType: 'tag',
        entityId: id,
        groupId: newId(),
        trashedAt: now,
        trashedByUserId: actor.userId ?? null,
        reason: options.reason ?? 'user',
        reasonDetail: options.reasonDetail ?? null,
        restorePayload: {
          assignments: assignments.map((assignment) => ({
            itemId: assignment.itemId,
            source: assignment.source,
            ruleRef: assignment.ruleRef,
            confidence: assignment.confidence,
            addedAt: assignment.addedAt,
            addedByUserId: assignment.addedByUserId,
          })),
        },
      });

      this.audit.record(
        {
          actor,
          action: 'tag.trashed',
          entityType: 'tag',
          entityId: id,
          before: { trashedAt: null, assignments: assignments.length },
          after: { trashedAt: now },
          reason: options.reason ?? 'user',
        },
        tx,
      );

      for (const assignment of assignments) this.search?.indexItem(assignment.itemId, tx);
      return { ...current, trashedAt: now, updatedAt: now };
    });
  }

  /** Put a tag back, with every assignment it had. */
  restore(id: string, actor: Actor): TagRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(tags).where(eq(tags.id, id)).get();
      if (current === undefined) throw new NotFoundError('tag', id);

      const record = findOpenTrashRecord(tx, 'tag', id);
      if (record === undefined) {
        if (current.trashedAt === null) return current;
        throw new ConflictError(
          `Tag '${id}' is trashed but has no open trash record, which breaks invariant T1.`,
          { tagId: id },
        );
      }

      const now = nowTimestamp();
      tx.update(tags).set({ trashedAt: null, updatedAt: now }).where(eq(tags.id, id)).run();

      const payload = readRestorePayload(record);
      const assignments = Array.isArray(payload['assignments']) ? payload['assignments'] : [];
      let restored = 0;

      for (const entry of assignments) {
        if (typeof entry !== 'object' || entry === null) continue;
        const assignment = entry as Record<string, unknown>;
        const itemId = assignment['itemId'];
        if (typeof itemId !== 'string') continue;

        const item = tx.select({ id: items.id }).from(items).where(eq(items.id, itemId)).get();
        if (item === undefined) continue;

        tx.insert(itemTags)
          .values({
            itemId,
            tagId: id,
            source: isAssignmentSource(assignment['source']) ? assignment['source'] : 'manual',
            ruleRef: typeof assignment['ruleRef'] === 'string' ? assignment['ruleRef'] : null,
            confidence: typeof assignment['confidence'] === 'number' ? assignment['confidence'] : null,
            addedAt: typeof assignment['addedAt'] === 'string' ? assignment['addedAt'] : now,
            addedByUserId:
              typeof assignment['addedByUserId'] === 'string' ? assignment['addedByUserId'] : null,
          })
          .onConflictDoNothing()
          .run();
        restored += 1;
        this.search?.indexItem(itemId, tx);
      }

      closeTrashRecord(tx, record.id, now, actor.userId ?? null);

      this.audit.record(
        {
          actor,
          action: 'tag.restored',
          entityType: 'tag',
          entityId: id,
          before: { trashedAt: current.trashedAt },
          after: { trashedAt: null, restoredAssignments: restored },
          reason: record.reason,
        },
        tx,
      );

      return { ...current, trashedAt: null, updatedAt: now };
    });
  }
}

const ASSIGNMENT_SOURCE_VALUES: readonly TagAssignmentSource[] = [
  'manual',
  'rule',
  'resolver',
  'import',
  'plugin',
  'merge',
];

const isAssignmentSource = (value: unknown): value is TagAssignmentSource =>
  typeof value === 'string' && (ASSIGNMENT_SOURCE_VALUES as readonly string[]).includes(value);
