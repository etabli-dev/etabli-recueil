/**
 * Creators, and their appearances on items (§5.1, §5.2).
 *
 * A creator is a person or an organisation as an *entity*, with identity-resolution state. Their
 * appearance on a particular item — role, position in the author list, the affiliation as printed —
 * is `item_creators`, and the split is what makes bibliometrix `C1` and institutional collaboration
 * networks possible at all: affiliation is a property of the publication event, not of the person.
 *
 * The invariants this service owns:
 *
 * - **IC1.** `ordinal` is dense from zero within an item. `setItemCreators` rewrites the whole
 *   block in one transaction rather than patching positions, because a gap in the author list is
 *   the kind of corruption that shows up much later, in an export.
 * - **IC2.** The same creator may appear twice on an item with different roles — author and editor
 *   of a collection is a real thing — but never twice in the same role.
 * - **CR1.** `disambiguation_status = 'merged'` exactly when `merged_into_creator_id` is set, and
 *   the row is trashed. Appearances are re-pointed at the winner and the previous state sits in the
 *   merge record.
 * - **CR2.** Two creators with different non-null ORCIDs are **never** merged automatically. The
 *   merge is refused here; P3 says the conflict goes to the review queue instead of being guessed
 *   at.
 */
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { creators, itemCreators, items } from '../db/schema.js';
import type { CreatorRow, ItemCreatorRow, ItemRow } from '../db/schema.js';
import { ConflictError, InvariantError, NotFoundError, ValidationError } from '../errors.js';
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

export type CreatorKind = 'person' | 'organisation';
export type CreatorRole =
  | 'author'
  | 'editor'
  | 'translator'
  | 'contributor'
  | 'series_editor'
  | 'recipient'
  | 'interviewer'
  | 'director'
  | 'reviewed_author'
  | 'sender'
  | 'correspondent';

export interface CreateCreatorInput {
  kind?: CreatorKind;
  familyName?: string | null;
  givenName?: string | null;
  namePrefix?: string | null;
  nameSuffix?: string | null;
  /** Required for an organisation, and for a person whose name does not split. */
  literalName?: string | null;
  /** Rendered from the parts when absent. */
  displayName?: string;
  initials?: string | null;
  orcid?: string | null;
  openalexAuthorId?: string | null;
  semanticScholarAuthorId?: string | null;
  scopusAuthorId?: string | null;
  researcherId?: string | null;
  isni?: string | null;
  viaf?: string | null;
  ror?: string | null;
  wikidataId?: string | null;
  /** `{form, source, count}` entries — the "name forms" of CONCEPT §5.2. */
  nameVariants?: Array<Record<string, unknown>>;
}

export type UpdateCreatorInput = Omit<CreateCreatorInput, 'kind'> & { kind?: CreatorKind };

export interface ListCreatorsOptions {
  kind?: CreatorKind;
  /** Case-insensitive prefix over the sort name — the creator autocomplete. */
  prefix?: string;
  disambiguationStatus?: 'unreviewed' | 'confirmed' | 'ambiguous' | 'merged';
  includeTrashed?: boolean;
  limit?: number;
}

/** One appearance, as a caller declares it. `ordinal` is assigned by the service (IC1). */
export interface ItemCreatorInput {
  creatorId: string;
  role?: CreatorRole;
  /** Exactly as printed, for BibTeX fidelity and the `author_consistency` check. */
  rawName?: string | null;
  affiliationRaw?: string | null;
  affiliationRor?: string | null;
  affiliationCreatorId?: string | null;
  countryCode?: string | null;
  isCorresponding?: boolean;
  contributionRoles?: string[] | null;
}

/** An appearance joined to the creator behind it — what an item pane renders. */
export interface ItemCreatorRecord {
  appearance: ItemCreatorRow;
  creator: CreatorRow;
}

export class CreatorService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    private readonly search?: SearchIndexer,
  ) {}

  /* ---------------------------------------------------------------------------------------- */
  /* Create and read                                                                             */
  /* ---------------------------------------------------------------------------------------- */

  create(input: CreateCreatorInput, actor: Actor): CreatorRow {
    const kind = input.kind ?? 'person';
    const familyName = trimOrNull(input.familyName);
    const givenName = trimOrNull(input.givenName);
    const literalName = trimOrNull(input.literalName);

    if (kind === 'organisation' && literalName === null) {
      throw new ValidationError(
        'An organisation needs a literal name (§5.1, ck_creators_org).',
        { kind },
      );
    }
    if (literalName === null && familyName === null) {
      throw new ValidationError(
        'A creator needs either a family name or a literal name (§5.1, ck_creators_name).',
      );
    }

    const displayName = input.displayName ?? renderDisplayName({ ...input, literalName, familyName, givenName });
    const orcid = normaliseOrcid(input.orcid);

    return this.db.transaction((tx) => {
      if (orcid !== null) {
        const clash = tx
          .select()
          .from(creators)
          .where(and(eq(creators.orcid, orcid), isNull(creators.trashedAt)))
          .get();
        if (clash !== undefined) {
          throw new ConflictError(
            `ORCID ${orcid} already belongs to '${clash.displayName}'. An ORCID identifies one ` +
              'person, so this is the same person or one of the two records is wrong.',
            { creatorId: clash.id, orcid },
          );
        }
      }

      const now = nowTimestamp();
      const row: CreatorRow = {
        id: newId(),
        kind,
        familyName,
        givenName,
        namePrefix: trimOrNull(input.namePrefix),
        nameSuffix: trimOrNull(input.nameSuffix),
        literalName,
        displayName,
        sortName: renderSortName({ literalName, familyName, givenName }),
        initials: input.initials ?? renderInitials(givenName),
        nameVariants: JSON.stringify(input.nameVariants ?? []),
        orcid,
        openalexAuthorId: trimOrNull(input.openalexAuthorId),
        semanticScholarAuthorId: trimOrNull(input.semanticScholarAuthorId),
        scopusAuthorId: trimOrNull(input.scopusAuthorId),
        researcherId: trimOrNull(input.researcherId),
        isni: trimOrNull(input.isni),
        viaf: trimOrNull(input.viaf),
        ror: trimOrNull(input.ror),
        wikidataId: trimOrNull(input.wikidataId),
        disambiguationStatus: 'unreviewed',
        mergedIntoCreatorId: null,
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
      };
      tx.insert(creators).values(row).run();

      this.audit.record(
        {
          actor,
          action: 'creator.created',
          entityType: 'creator',
          entityId: row.id,
          after: { displayName: row.displayName, kind, orcid },
        },
        tx,
      );

      return row;
    });
  }

  get(id: string, options: { includeTrashed?: boolean } = {}): CreatorRow {
    const row = this.db.select().from(creators).where(eq(creators.id, id)).get();
    if (row === undefined) throw new NotFoundError('creator', id);
    if (row.trashedAt !== null && options.includeTrashed !== true) {
      throw new NotFoundError('creator', id);
    }
    return row;
  }

  findByOrcid(orcid: string): CreatorRow | undefined {
    const normalised = normaliseOrcid(orcid);
    if (normalised === null) return undefined;
    return this.db
      .select()
      .from(creators)
      .where(and(eq(creators.orcid, normalised), isNull(creators.trashedAt)))
      .get();
  }

  /** Lookup by the blocking key the deduplicator uses: the normalised `family, given`. */
  findBySortName(sortName: string): CreatorRow[] {
    return this.db
      .select()
      .from(creators)
      .where(and(eq(creators.sortName, normalise(sortName)), isNull(creators.trashedAt)))
      .orderBy(asc(creators.id))
      .all();
  }

  list(options: ListCreatorsOptions = {}): CreatorRow[] {
    const conditions = [];
    if (options.includeTrashed !== true) conditions.push(isNull(creators.trashedAt));
    if (options.kind !== undefined) conditions.push(eq(creators.kind, options.kind));
    if (options.disambiguationStatus !== undefined) {
      conditions.push(eq(creators.disambiguationStatus, options.disambiguationStatus));
    }
    if (options.prefix !== undefined && options.prefix.trim() !== '') {
      const prefix = normalise(options.prefix).replaceAll('%', '\\%').replaceAll('_', '\\_');
      conditions.push(sql`${creators.sortName} like ${`${prefix}%`} escape '\\'`);
    }

    const query = this.db
      .select()
      .from(creators)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(creators.sortName), asc(creators.id));

    return options.limit === undefined ? query.all() : query.limit(resolveLimit(options.limit)).all();
  }

  update(id: string, patch: UpdateCreatorInput, actor: Actor): CreatorRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(creators).where(eq(creators.id, id)).get();
      if (current === undefined) throw new NotFoundError('creator', id);
      if (current.trashedAt !== null) {
        throw new ConflictError(`Creator '${id}' is in the trash. Restore it before editing it.`, {
          creatorId: id,
        });
      }

      const kind = patch.kind ?? current.kind;
      const familyName = patch.familyName !== undefined ? trimOrNull(patch.familyName) : current.familyName;
      const givenName = patch.givenName !== undefined ? trimOrNull(patch.givenName) : current.givenName;
      const literalName =
        patch.literalName !== undefined ? trimOrNull(patch.literalName) : current.literalName;

      if (kind === 'organisation' && literalName === null) {
        throw new ValidationError('An organisation needs a literal name (§5.1).');
      }
      if (literalName === null && familyName === null) {
        throw new ValidationError('A creator needs either a family name or a literal name (§5.1).');
      }

      const orcid = patch.orcid !== undefined ? normaliseOrcid(patch.orcid) : current.orcid;
      if (orcid !== null && orcid !== current.orcid) {
        const clash = tx
          .select()
          .from(creators)
          .where(and(eq(creators.orcid, orcid), isNull(creators.trashedAt)))
          .get();
        if (clash !== undefined && clash.id !== id) {
          throw new ConflictError(`ORCID ${orcid} already belongs to '${clash.displayName}'.`, {
            creatorId: clash.id,
            orcid,
          });
        }
      }

      const now = nowTimestamp();
      const next = {
        kind,
        familyName,
        givenName,
        namePrefix: patch.namePrefix !== undefined ? trimOrNull(patch.namePrefix) : current.namePrefix,
        nameSuffix: patch.nameSuffix !== undefined ? trimOrNull(patch.nameSuffix) : current.nameSuffix,
        literalName,
        displayName:
          patch.displayName ?? renderDisplayName({ literalName, familyName, givenName, namePrefix: current.namePrefix, nameSuffix: current.nameSuffix }),
        sortName: renderSortName({ literalName, familyName, givenName }),
        initials: patch.initials !== undefined ? patch.initials : renderInitials(givenName),
        nameVariants:
          patch.nameVariants === undefined ? current.nameVariants : JSON.stringify(patch.nameVariants),
        orcid,
        openalexAuthorId:
          patch.openalexAuthorId !== undefined
            ? trimOrNull(patch.openalexAuthorId)
            : current.openalexAuthorId,
        ror: patch.ror !== undefined ? trimOrNull(patch.ror) : current.ror,
        updatedAt: now,
      };

      tx.update(creators).set(next).where(eq(creators.id, id)).run();

      const delta = diffFields(current as unknown as Record<string, unknown>, {
        displayName: next.displayName,
        sortName: next.sortName,
        orcid: next.orcid,
        kind: next.kind,
      });
      this.audit.record(
        {
          actor,
          action: 'creator.updated',
          entityType: 'creator',
          entityId: id,
          before: delta.before,
          after: delta.after,
        },
        tx,
      );

      for (const row of tx
        .select({ itemId: itemCreators.itemId })
        .from(itemCreators)
        .where(eq(itemCreators.creatorId, id))
        .all()) {
        this.search?.indexItem(row.itemId, tx);
      }

      return { ...current, ...next };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Appearances on items                                                                        */
  /* ---------------------------------------------------------------------------------------- */

  /** The author list of an item, in `ordinal` order, joined to the creators behind it. */
  forItem(itemId: string): ItemCreatorRecord[] {
    return this.db
      .select({ appearance: itemCreators, creator: creators })
      .from(itemCreators)
      .innerJoin(creators, eq(creators.id, itemCreators.creatorId))
      .where(eq(itemCreators.itemId, itemId))
      .orderBy(asc(itemCreators.ordinal))
      .all();
  }

  /**
   * Replace an item's whole author list (IC1).
   *
   * A wholesale rewrite rather than a patch, because `ordinal` must be dense from zero and the only
   * way to guarantee that while honouring an arbitrary reorder is to write the block out again.
   */
  setItemCreators(itemId: string, entries: readonly ItemCreatorInput[], actor: Actor): ItemCreatorRecord[] {
    return this.db.transaction((tx) => {
      const item = tx.select().from(items).where(eq(items.id, itemId)).get();
      if (item === undefined) throw new NotFoundError('item', itemId);

      const seen = new Set<string>();
      for (const entry of entries) {
        const role = entry.role ?? 'author';
        const key = `${entry.creatorId}:${role}`;
        if (seen.has(key)) {
          throw new InvariantError(
            'IC2',
            `Creator '${entry.creatorId}' appears twice as '${role}' on item '${itemId}'. The same ` +
              'person may hold two different roles, but not the same one twice.',
            { itemId, creatorId: entry.creatorId, role },
          );
        }
        seen.add(key);

        const creator = tx.select().from(creators).where(eq(creators.id, entry.creatorId)).get();
        if (creator === undefined) throw new NotFoundError('creator', entry.creatorId);
        if (creator.trashedAt !== null) {
          throw new ConflictError(`Creator '${entry.creatorId}' is in the trash.`, {
            creatorId: entry.creatorId,
          });
        }
      }

      const before = tx.select().from(itemCreators).where(eq(itemCreators.itemId, itemId)).all();
      tx.delete(itemCreators).where(eq(itemCreators.itemId, itemId)).run();

      const now = nowTimestamp();
      entries.forEach((entry, ordinal) => {
        tx.insert(itemCreators)
          .values({
            itemId,
            ordinal,
            creatorId: entry.creatorId,
            role: entry.role ?? 'author',
            rawName: entry.rawName ?? null,
            affiliationRaw: entry.affiliationRaw ?? null,
            affiliationRor: entry.affiliationRor ?? null,
            affiliationCreatorId: entry.affiliationCreatorId ?? null,
            countryCode: entry.countryCode ?? null,
            isCorresponding: entry.isCorresponding ?? false,
            contributionRoles:
              entry.contributionRoles === undefined || entry.contributionRoles === null
                ? null
                : JSON.stringify(entry.contributionRoles),
            createdAt: now,
          })
          .run();
      });

      this.audit.record(
        {
          actor,
          action: 'item.creators_set',
          entityType: 'item',
          entityId: itemId,
          before: { count: before.length, creatorIds: before.map((row) => row.creatorId) },
          after: { count: entries.length, creatorIds: entries.map((entry) => entry.creatorId) },
        },
        tx,
      );

      this.search?.indexItem(itemId, tx);

      return tx
        .select({ appearance: itemCreators, creator: creators })
        .from(itemCreators)
        .innerJoin(creators, eq(creators.id, itemCreators.creatorId))
        .where(eq(itemCreators.itemId, itemId))
        .orderBy(asc(itemCreators.ordinal))
        .all();
    });
  }

  /** Append one appearance at the end of the list, keeping `ordinal` dense (IC1). */
  addToItem(itemId: string, entry: ItemCreatorInput, actor: Actor): ItemCreatorRecord[] {
    const existing = this.forItem(itemId).map((record) => ({
      creatorId: record.appearance.creatorId,
      role: record.appearance.role,
      rawName: record.appearance.rawName,
      affiliationRaw: record.appearance.affiliationRaw,
      affiliationRor: record.appearance.affiliationRor,
      affiliationCreatorId: record.appearance.affiliationCreatorId,
      countryCode: record.appearance.countryCode,
      isCorresponding: record.appearance.isCorresponding,
      contributionRoles: null,
    }));
    return this.setItemCreators(itemId, [...existing, entry], actor);
  }

  /**
   * Everything by this creator — a page of items, newest first.
   *
   * `ix_item_creators_creator_id` is the index that makes this the cheap query it looks like.
   */
  listWorks(
    creatorId: string,
    options: { limit?: number; cursor?: string; order?: 'asc' | 'desc'; role?: CreatorRole; includeTrashed?: boolean } = {},
  ): Page<ItemRow> {
    const limit = resolveLimit(options.limit);
    const order = options.order ?? 'desc';

    const conditions = [
      eq(itemCreators.creatorId, creatorId),
      sql`${items.libraryState} <> 'merged'`,
    ];
    if (options.role !== undefined) conditions.push(eq(itemCreators.role, options.role));
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
      .selectDistinct({ item: items })
      .from(itemCreators)
      .innerJoin(items, eq(items.id, itemCreators.itemId))
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
  /* Merge (CR1, CR2)                                                                            */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Fold one creator into another.
   *
   * CR2 is the rule that matters: **two creators with different non-null ORCIDs are never merged.**
   * Not "merged with a warning", not "merged if configuration allows" — refused, because an ORCID
   * identifies a person and two different ones mean the caller is wrong about at least one of them.
   * P3 sends the conflict to the review queue rather than letting an automated run decide.
   *
   * Everything else is bookkeeping: every appearance moves to the winner, an appearance the winner
   * already had in the same role is dropped rather than duplicated (IC2), the loser's name forms are
   * folded into the winner's `name_variants` so the old spelling stays findable, and the loser is
   * marked `merged` and trashed (CR1) with a reversible record.
   */
  merge(loserId: string, winnerId: string, actor: Actor): { winner: CreatorRow; movedAppearances: number } {
    if (loserId === winnerId) {
      throw new ValidationError('A creator cannot be merged into itself.', { creatorId: loserId });
    }

    return this.db.transaction((tx) => {
      const loser = tx.select().from(creators).where(eq(creators.id, loserId)).get();
      if (loser === undefined) throw new NotFoundError('creator', loserId);
      const winner = tx.select().from(creators).where(eq(creators.id, winnerId)).get();
      if (winner === undefined) throw new NotFoundError('creator', winnerId);
      if (loser.trashedAt !== null) {
        throw new ConflictError(`Creator '${loserId}' is already in the trash.`, { creatorId: loserId });
      }
      if (winner.trashedAt !== null) {
        throw new ConflictError(`Creator '${winnerId}' is in the trash and cannot win a merge.`, {
          creatorId: winnerId,
        });
      }

      if (loser.orcid !== null && winner.orcid !== null && loser.orcid !== winner.orcid) {
        throw new InvariantError(
          'CR2',
          `'${loser.displayName}' (${loser.orcid}) and '${winner.displayName}' (${winner.orcid}) ` +
            'have different ORCIDs, so they are not the same person. The conflict belongs in the ' +
            'review queue (P3), not in a merge.',
          { loserId, winnerId, loserOrcid: loser.orcid, winnerOrcid: winner.orcid },
        );
      }

      const now = nowTimestamp();
      const appearances = tx.select().from(itemCreators).where(eq(itemCreators.creatorId, loserId)).all();

      const moved: Array<{ itemId: string; ordinal: number; role: string }> = [];
      const dropped: Array<{ itemId: string; ordinal: number; role: string }> = [];
      const touchedItems = new Set<string>();

      for (const appearance of appearances) {
        touchedItems.add(appearance.itemId);
        const clash = tx
          .select({ ordinal: itemCreators.ordinal })
          .from(itemCreators)
          .where(
            and(
              eq(itemCreators.itemId, appearance.itemId),
              eq(itemCreators.creatorId, winnerId),
              eq(itemCreators.role, appearance.role),
            ),
          )
          .get();

        if (clash === undefined) {
          tx.update(itemCreators)
            .set({ creatorId: winnerId })
            .where(
              and(eq(itemCreators.itemId, appearance.itemId), eq(itemCreators.ordinal, appearance.ordinal)),
            )
            .run();
          moved.push({ itemId: appearance.itemId, ordinal: appearance.ordinal, role: appearance.role });
        } else {
          tx.delete(itemCreators)
            .where(
              and(eq(itemCreators.itemId, appearance.itemId), eq(itemCreators.ordinal, appearance.ordinal)),
            )
            .run();
          dropped.push({
            itemId: appearance.itemId,
            ordinal: appearance.ordinal,
            role: appearance.role,
          });
        }
      }

      // IC1: dropping an appearance leaves a hole, so any item that lost one is re-densified.
      for (const itemId of touchedItems) {
        if (!dropped.some((entry) => entry.itemId === itemId)) continue;
        this.densify(tx, itemId);
      }

      const variants = mergeNameVariants(winner, loser);
      tx.update(creators)
        .set({
          nameVariants: JSON.stringify(variants),
          orcid: winner.orcid ?? loser.orcid,
          openalexAuthorId: winner.openalexAuthorId ?? loser.openalexAuthorId,
          updatedAt: now,
        })
        .where(eq(creators.id, winnerId))
        .run();

      tx.update(creators)
        .set({
          disambiguationStatus: 'merged',
          mergedIntoCreatorId: winnerId,
          trashedAt: now,
          updatedAt: now,
        })
        .where(eq(creators.id, loserId))
        .run();

      openTrashRecord(tx, {
        entityType: 'creator',
        entityId: loserId,
        groupId: newId(),
        trashedAt: now,
        trashedByUserId: actor.userId ?? null,
        reason: 'merge',
        reasonDetail: `merged into creator ${winnerId}`,
        mergeRecord: {
          winnerCreatorId: winnerId,
          moved,
          dropped,
          winnerNameVariantsBefore: winner.nameVariants,
          winnerOrcidBefore: winner.orcid,
        },
        restorePayload: { appearances, winnerCreatorId: winnerId },
      });

      this.audit.record(
        {
          actor,
          action: 'creator.merged',
          entityType: 'creator',
          entityId: loserId,
          before: { displayName: loser.displayName, appearances: appearances.length },
          after: { winnerCreatorId: winnerId, moved: moved.length, dropped: dropped.length },
          reason: 'merge (CR1)',
        },
        tx,
      );

      for (const itemId of touchedItems) this.search?.indexItem(itemId, tx);

      const refreshed = tx.select().from(creators).where(eq(creators.id, winnerId)).get() as CreatorRow;
      return { winner: refreshed, movedAppearances: moved.length };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Trash and restore (P5)                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Trash a creator.
   *
   * Refused while the creator still appears on a live item: unlike a tag, an appearance carries the
   * item's author order, and silently removing one would change what the item says its authors are.
   * Detach the appearances first, or merge instead.
   */
  trash(id: string, actor: Actor, options: TrashOptions = {}): CreatorRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(creators).where(eq(creators.id, id)).get();
      if (current === undefined) throw new NotFoundError('creator', id);
      if (current.trashedAt !== null) return current;

      const appearances = tx
        .select({ itemId: itemCreators.itemId })
        .from(itemCreators)
        .innerJoin(items, eq(items.id, itemCreators.itemId))
        .where(and(eq(itemCreators.creatorId, id), isNull(items.trashedAt)))
        .all();
      if (appearances.length > 0) {
        throw new ConflictError(
          `'${current.displayName}' still appears on ${appearances.length} live item(s). Detach ` +
            'those appearances or merge this creator into another; trashing would silently change ' +
            'what those items say their authors are.',
          { creatorId: id, itemIds: appearances.map((row) => row.itemId) },
        );
      }

      const now = nowTimestamp();
      tx.update(creators).set({ trashedAt: now, updatedAt: now }).where(eq(creators.id, id)).run();

      openTrashRecord(tx, {
        entityType: 'creator',
        entityId: id,
        groupId: newId(),
        trashedAt: now,
        trashedByUserId: actor.userId ?? null,
        reason: options.reason ?? 'user',
        reasonDetail: options.reasonDetail ?? null,
        restorePayload: { displayName: current.displayName },
      });

      this.audit.record(
        {
          actor,
          action: 'creator.trashed',
          entityType: 'creator',
          entityId: id,
          before: { trashedAt: null },
          after: { trashedAt: now },
          reason: options.reason ?? 'user',
        },
        tx,
      );

      return { ...current, trashedAt: now, updatedAt: now };
    });
  }

  /** Put a creator back. A merged creator is un-merged: CR1 ties the two states together. */
  restore(id: string, actor: Actor): CreatorRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(creators).where(eq(creators.id, id)).get();
      if (current === undefined) throw new NotFoundError('creator', id);

      const record = findOpenTrashRecord(tx, 'creator', id);
      if (record === undefined) {
        if (current.trashedAt === null) return current;
        throw new ConflictError(
          `Creator '${id}' is trashed but has no open trash record, which breaks invariant T1.`,
          { creatorId: id },
        );
      }

      const now = nowTimestamp();
      let restoredAppearances = 0;

      if (record.reason === 'merge') {
        // Reversing a merge puts the appearances back where they were, ordinal for ordinal.
        const payload = readRestorePayload(record);
        const appearances = Array.isArray(payload['appearances']) ? payload['appearances'] : [];
        const touched = new Set<string>();

        for (const entry of appearances) {
          if (typeof entry !== 'object' || entry === null) continue;
          const appearance = entry as Record<string, unknown>;
          const itemId = appearance['itemId'];
          const ordinal = appearance['ordinal'];
          if (typeof itemId !== 'string' || typeof ordinal !== 'number') continue;

          const item = tx.select({ id: items.id }).from(items).where(eq(items.id, itemId)).get();
          if (item === undefined) continue;

          tx.delete(itemCreators)
            .where(and(eq(itemCreators.itemId, itemId), eq(itemCreators.ordinal, ordinal)))
            .run();
          tx.insert(itemCreators)
            .values({
              itemId,
              ordinal,
              creatorId: id,
              role: (appearance['role'] as ItemCreatorRow['role']) ?? 'author',
              rawName: typeof appearance['rawName'] === 'string' ? appearance['rawName'] : null,
              affiliationRaw:
                typeof appearance['affiliationRaw'] === 'string' ? appearance['affiliationRaw'] : null,
              affiliationRor:
                typeof appearance['affiliationRor'] === 'string' ? appearance['affiliationRor'] : null,
              affiliationCreatorId: null,
              countryCode:
                typeof appearance['countryCode'] === 'string' ? appearance['countryCode'] : null,
              isCorresponding: appearance['isCorresponding'] === true,
              contributionRoles: null,
              createdAt: typeof appearance['createdAt'] === 'string' ? appearance['createdAt'] : now,
            })
            .run();
          restoredAppearances += 1;
          touched.add(itemId);
        }

        for (const itemId of touched) {
          this.densify(tx, itemId);
          this.search?.indexItem(itemId, tx);
        }
      }

      tx.update(creators)
        .set({
          trashedAt: null,
          updatedAt: now,
          disambiguationStatus: current.mergedIntoCreatorId === null ? current.disambiguationStatus : 'unreviewed',
          mergedIntoCreatorId: null,
        })
        .where(eq(creators.id, id))
        .run();
      closeTrashRecord(tx, record.id, now, actor.userId ?? null);

      this.audit.record(
        {
          actor,
          action: 'creator.restored',
          entityType: 'creator',
          entityId: id,
          before: { trashedAt: current.trashedAt, mergedIntoCreatorId: current.mergedIntoCreatorId },
          after: { trashedAt: null, restoredAppearances },
          reason: record.reason,
        },
        tx,
      );

      return tx.select().from(creators).where(eq(creators.id, id)).get() as CreatorRow;
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Internals                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  /** Rewrite an item's ordinals so they are dense from zero again (IC1). */
  private densify(tx: Pick<RecueilDatabase, 'select' | 'delete' | 'insert'>, itemId: string): void {
    const rows = tx
      .select()
      .from(itemCreators)
      .where(eq(itemCreators.itemId, itemId))
      .orderBy(asc(itemCreators.ordinal))
      .all();
    if (rows.every((row, index) => row.ordinal === index)) return;

    tx.delete(itemCreators).where(eq(itemCreators.itemId, itemId)).run();
    rows.forEach((row, index) => {
      tx.insert(itemCreators)
        .values({ ...row, ordinal: index })
        .run();
    });
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Name rendering                                                                                  */
/* -------------------------------------------------------------------------------------------- */

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** Rendered once, on write (§5.1) — a list view must not assemble a name per row. */
export const renderDisplayName = (parts: {
  literalName?: string | null;
  familyName?: string | null;
  givenName?: string | null;
  namePrefix?: string | null;
  nameSuffix?: string | null;
}): string => {
  if (parts.literalName !== null && parts.literalName !== undefined && parts.literalName !== '') {
    return parts.literalName;
  }
  const family = [parts.namePrefix, parts.familyName].filter(isPresent).join(' ');
  const rendered = [parts.givenName, family].filter(isPresent).join(' ');
  const withSuffix = [rendered, parts.nameSuffix].filter(isPresent).join(', ');
  return withSuffix === '' ? 'Unknown' : withSuffix;
};

/** `family, given`, normalised: the dedup blocking key and the browsing index (§5.1). */
export const renderSortName = (parts: {
  literalName?: string | null;
  familyName?: string | null;
  givenName?: string | null;
}): string => {
  if (parts.literalName !== null && parts.literalName !== undefined && parts.literalName !== '') {
    return normalise(parts.literalName);
  }
  const family = parts.familyName ?? '';
  const given = parts.givenName ?? '';
  return normalise(given === '' ? family : `${family}, ${given}`);
};

/** bibliometrix `AU` uses the abbreviated form; `AF` uses the display name (§5.1). */
export const renderInitials = (givenName: string | null | undefined): string | null => {
  if (givenName === null || givenName === undefined) return null;
  const initials = givenName
    .split(/[\s.-]+/u)
    .filter((part) => part !== '')
    .map((part) => `${(part[0] as string).toUpperCase()}.`)
    .join('');
  return initials === '' ? null : initials;
};

/** ORCID as stored: the bare 16 digits with hyphens, uppercase X (§5.1). */
export const normaliseOrcid = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const digits = value.replace(/^https?:\/\/(?:www\.|sandbox\.)?orcid\.org\//iu, '').replace(/[^0-9Xx]/gu, '');
  if (digits.length !== 16) {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  const upper = digits.toUpperCase();
  return `${upper.slice(0, 4)}-${upper.slice(4, 8)}-${upper.slice(8, 12)}-${upper.slice(12, 16)}`;
};

const isPresent = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value !== '';

/** The loser's name forms folded into the winner's, so the old spelling stays findable. */
const mergeNameVariants = (winner: CreatorRow, loser: CreatorRow): Array<Record<string, unknown>> => {
  const parse = (json: string): Array<Record<string, unknown>> => {
    try {
      const value: unknown = JSON.parse(json);
      return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  };

  const out = parse(winner.nameVariants);
  const known = new Set(out.map((entry) => String(entry['form'] ?? '')));

  for (const entry of [...parse(loser.nameVariants), { form: loser.displayName, source: 'merge', count: 1 }]) {
    const form = String(entry['form'] ?? '');
    if (form === '' || known.has(form)) continue;
    known.add(form);
    out.push(entry);
  }
  return out;
};
