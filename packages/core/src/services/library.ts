/**
 * The library service: items and their two facets (§3.4, §3.5, §3.7).
 *
 * Five rules run through every method here, and they are the reason this is a service rather than
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
 * - **Every facet field write records provenance, and a manual lock refuses an automated one**
 *   (P4, §3.6). There is no path into `item_bibliographic` or `item_office` from outside this
 *   service that does not go through `applyFacet`, which is what makes CONCEPT §5.4's "manual edits
 *   locked per field and never overwritten" a property of the data rather than a promise.
 */
import { SLUG_PATTERN } from '@recueil/schemas';
import { and, asc, count, desc, eq, inArray, isNull, lt, gt, or, sql } from 'drizzle-orm';

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
} from '../db/schema.js';
import type { FieldProvenanceRow, ItemBibliographicRow, ItemOfficeRow, ItemRow } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError, VersionConflictError } from '../errors.js';
import { newId, newPublicId } from '../ids.js';
import { normalise, normaliseDoi } from '../normalise.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import { AuditService, diffFields } from './audit.js';
import type { Page } from './cursor.js';
import { decodeCursor, encodeCursor, resolveLimit } from './cursor.js';
import { ProvenanceService, manualStamp } from './provenance.js';
import type { ProvenanceStamp, SkippedField } from './provenance.js';
import type { LibrarySearch } from './search.js';
import type { TrashOptions } from './trash-record.js';
import {
  closeTrashRecord,
  findOpenTrashRecord,
  findTrashGroup,
  openTrashRecord,
} from './trash-record.js';

export type { TrashOptions } from './trash-record.js';

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
  /** Where the facet values came from. Defaults to `manual`, which locks them (P4-1). */
  provenance?: ProvenanceStamp;
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

export interface UpdateItemOptions {
  expectedVersion?: number;
  /** Where the facet values came from. Defaults to `manual`, which locks them (P4-1). */
  provenance?: ProvenanceStamp;
}

/** An item with its facets. The shape `GET /items/{id}` renders. */
export interface ItemRecord {
  item: ItemRow;
  bibliographic: ItemBibliographicRow | null;
  office: ItemOfficeRow | null;
}

/**
 * The outcome of a facet write, including what the locks refused (P4-4).
 *
 * A bulk enrichment run reads `skipped` and reports it. A run that overwrites nothing and says
 * nothing is a bug, so the count is in the return value rather than only in the log.
 */
export interface FacetWriteResult {
  record: ItemRecord;
  /** The field paths actually written. */
  applied: string[];
  /** The field paths a manual lock refused, and who holds each lock. */
  skipped: SkippedField[];
}

export interface ListItemsOptions {
  limit?: number;
  cursor?: string;
  /** `desc` (newest first) is the default a library list view wants. */
  order?: 'asc' | 'desc';
  itemType?: string;
  ownerUserId?: string;
  /** Only items filed in this collection. */
  collectionId?: string;
  /** Only items carrying this tag. */
  tagId?: string;
  /** Full-text query, in Recueil's own syntax (`search-query.ts`). */
  text?: string;
  /** Trashed items are excluded unless asked for; merge losers never appear at all (I2). */
  includeTrashed?: boolean;
}

export type CountItemsOptions = Omit<ListItemsOptions, 'limit' | 'cursor' | 'order'>;

/**
 * The ceiling on a text filter's candidate set.
 *
 * `listItems({ text })` is a SQL query with a full-text predicate folded in, so the matching ids
 * have to be materialised. Five hundred is the same ceiling `SearchService` puts on a page, and a
 * caller who wants the long tail of a broad query wants `SearchService.search` and its cursor, not
 * a library list view.
 *
 * When the ceiling is reached the page says so — `page.textFilterTruncated` — because a caller has
 * no other way to tell "these are all the matches" from "these are the best five hundred".
 */
export const TEXT_FILTER_CANDIDATES = 500;

export class LibraryService {
  private readonly provenance: ProvenanceService;

  private readonly search?: LibrarySearch;

  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
    /** The account owned records fall back to. In v1 there is exactly one (§1.4). */
    private readonly defaultOwnerUserId: string,
    options: { provenance?: ProvenanceService; search?: LibrarySearch } = {},
  ) {
    // Constructed here when the caller supplies none, rather than left optional: P4-1 says *every*
    // facet write records provenance, and an optional recorder would make that "usually".
    this.provenance = options.provenance ?? new ProvenanceService(db, audit);
    this.search = options.search;
  }

  /** The per-field provenance service, for callers that need the locks directly (P4). */
  get fieldProvenance(): ProvenanceService {
    return this.provenance;
  }

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
    const stamp = input.provenance ?? manualStamp();

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
        // A brand-new item has no locked fields, so nothing can be refused here; the write still
        // goes through the same path, because that is what records the provenance (P4-1).
        bibliographicRow = this.applyBibliographic(tx, id, { ...bibliographic, title }, actor, stamp, now)
          .row;
      }

      let officeRow: ItemOfficeRow | null = null;
      if (input.office !== undefined) {
        officeRow = this.applyOffice(tx, id, input.office, actor, stamp, now).row;
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
            provenanceSource: stamp.source,
          },
        },
        tx,
      );

      this.search?.indexItem(id, tx);

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
   *
   * The four filters compose. `collectionId` and `tagId` are semi-joins, so an item filed twice
   * still appears once; `text` narrows to the ids the full-text index matched, which keeps the
   * cursor working because the ordering stays `(date_modified, id)` rather than becoming relevance.
   * A caller who wants relevance order wants `SearchService.search`.
   */
  listItems(options: ListItemsOptions = {}): Page<ItemRow> {
    const limit = resolveLimit(options.limit);
    const order = options.order ?? 'desc';

    const filter = this.filterConditions(options);
    if (filter === null) {
      return { data: [], page: { nextCursor: null, hasMore: false, limit } };
    }
    const { conditions, textFilterTruncated } = filter;

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
        ...(textFilterTruncated ? { textFilterTruncated: true } : {}),
      },
    };
  }

  /** How many items match. Cheap enough to expose as `page.total`. */
  countItems(options: CountItemsOptions = {}): number {
    const filter = this.filterConditions(options);
    if (filter === null) return 0;

    return (
      this.db
        .select({ value: count() })
        .from(items)
        .where(and(...filter.conditions))
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
   *
   * Facet fields go through the provenance gate. With the default `manual` stamp nothing is
   * refused, because a human's edit outranks any lock; with a resolver's stamp, locked fields are
   * left alone. `updateBibliographic` is the same write with the refusals returned rather than
   * discarded, and is what an enrichment run should call.
   */
  updateItem(
    id: string,
    patch: UpdateItemInput,
    actor: Actor,
    options: UpdateItemOptions = {},
  ): ItemRecord {
    return this.updateItemDetailed(id, patch, actor, options).record;
  }

  /** `updateItem`, with the P4-4 report of what the locks refused. */
  updateItemDetailed(
    id: string,
    patch: UpdateItemInput,
    actor: Actor,
    options: UpdateItemOptions = {},
  ): FacetWriteResult {
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

    const stamp = options.provenance ?? manualStamp();

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

      const applied: string[] = [];
      const changed: string[] = [];
      const skipped: SkippedField[] = [];

      /* Facets first, because the item title mirrors the bibliographic one (I3). */
      let bibliographicRow = currentBibliographic;
      if (patch.bibliographic !== undefined && patch.bibliographic !== null) {
        const outcome = this.applyBibliographic(tx, id, patch.bibliographic, actor, stamp, now);
        bibliographicRow = outcome.row;
        applied.push(...outcome.applied.map((path) => `bibliographic.${path}`));
        changed.push(...outcome.changed.map((path) => `bibliographic.${path}`));
        skipped.push(...outcome.skipped);
      }

      let officeRow = currentOffice;
      if (patch.office !== undefined && patch.office !== null) {
        const correspondent = patch.office.correspondent ?? currentOffice?.correspondent;
        if (correspondent === undefined) {
          throw new ValidationError('The office facet requires a correspondent (§3.7).');
        }
        const outcome = this.applyOffice(
          tx,
          id,
          { ...patch.office, correspondent },
          actor,
          stamp,
          now,
        );
        officeRow = outcome.row;
        applied.push(...outcome.applied.map((path) => `office.${path}`));
        changed.push(...outcome.changed.map((path) => `office.${path}`));
        skipped.push(...outcome.skipped);
      }

      const nextTitle =
        bibliographicRow !== null
          ? (bibliographicRow.title ?? (patch.title !== undefined ? patch.title : current.title))
          : patch.title !== undefined
            ? patch.title
            : current.title;

      const columns = {
        itemType: patch.itemType ?? current.itemType,
        title: nextTitle ?? null,
        extra: patch.extra !== undefined ? patch.extra : current.extra,
        sourceSystem: patch.sourceSystem !== undefined ? patch.sourceSystem : current.sourceSystem,
        sourceId: patch.sourceId !== undefined ? patch.sourceId : current.sourceId,
      };
      const delta = diffFields(current as unknown as Record<string, unknown>, columns);

      /*
       * A write that changed nothing does not bump the version.
       *
       * `items.version` is the REST `ETag` and the token every conditional write is checked
       * against (§1.7, P1). Bumping it for a write that set every field to the value it already
       * held invalidates every client's token for nothing — and a re-run of the Zotero importer
       * does exactly that, re-issuing `writeBibliographic` for every item it has already seen.
       * Idempotence (P9) is not only "does not create a second row"; it is also "does not look
       * like an edit to anybody watching".
       *
       * The row is still returned, the provenance stamps are still applied — a resolver confirming
       * a value it agrees with is a fact worth recording — and a refusal by the locks still writes
       * its audit row, because P4-4 says the caller is told what was refused.
       */
      // `diffFields` reports "nothing differs" as `null`, not `undefined`.
      const untouched = changed.length === 0 && delta.before === null;

      const nextItem: ItemRow = untouched
        ? current
        : { ...current, ...columns, version: current.version + 1, dateModified: now };

      if (!untouched) {
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
      }

      if (!untouched || skipped.length > 0) {
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
              ...(applied.length > 0 ? { applied, provenanceSource: stamp.source } : {}),
              ...(skipped.length > 0 ? { skippedLockedFields: skipped } : {}),
            },
            ...(untouched
              ? { reason: 'no field changed; the version and date_modified are unchanged' }
              : {}),
          },
          tx,
        );
      }

      if (!untouched) this.search?.indexItem(id, tx);

      return {
        record: { item: nextItem, bibliographic: bibliographicRow, office: officeRow },
        applied,
        skipped,
      };
    });
  }

  /**
   * Write the bibliographic facet, and nothing else.
   *
   * This is the call an enrichment run makes. Pass the resolver's stamp — `{ source: 'crossref',
   * confidence: 0.9 }` — and every field a human has locked is left alone and reported in
   * `skipped`, while the rest are written with their provenance (P4-2, P4-4).
   */
  writeBibliographic(
    itemId: string,
    values: BibliographicInput,
    actor: Actor,
    options: UpdateItemOptions = {},
  ): FacetWriteResult {
    return this.updateItemDetailed(itemId, { bibliographic: values }, actor, options);
  }

  /** The same for the office facet. */
  writeOffice(
    itemId: string,
    values: Partial<OfficeInput> & { correspondent?: string },
    actor: Actor,
    options: UpdateItemOptions = {},
  ): FacetWriteResult {
    return this.updateItemDetailed(itemId, { office: values }, actor, options);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Provenance (P4)                                                                             */
  /* ---------------------------------------------------------------------------------------- */

  /** Every current provenance row for an item's bibliographic facet, keyed by field path. */
  bibliographicProvenance(itemId: string): Record<string, FieldProvenanceRow> {
    return this.provenance.map('item_bibliographic', itemId);
  }

  /** The same for the office facet. */
  officeProvenance(itemId: string): Record<string, FieldProvenanceRow> {
    return this.provenance.map('item_office', itemId);
  }

  /** The bibliographic fields locked against resolver writes (P4-2). */
  lockedBibliographicFields(itemId: string): string[] {
    return this.provenance.lockedFields('item_bibliographic', itemId);
  }

  /** Lock a bibliographic field without changing its value. */
  lockBibliographicField(itemId: string, fieldPath: string, actor: Actor): FieldProvenanceRow {
    return this.provenance.lock('item_bibliographic', itemId, fieldPath, actor);
  }

  /** Unlock a bibliographic field. An explicit user action, audited (P4-3). */
  unlockBibliographicField(itemId: string, fieldPath: string, actor: Actor): FieldProvenanceRow {
    return this.provenance.unlock('item_bibliographic', itemId, fieldPath, actor);
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
        openTrashRecord(tx, {
          entityType: 'attachment',
          entityId: child.id,
          groupId,
          trashedAt: now,
          reason: 'cascade',
          reasonDetail: `item ${id} trashed`,
          trashedByUserId,
          restorePayload: { parentItemId: id },
        });
      }
      for (const child of childNotes) {
        tx.update(notes).set({ trashedAt: now, updatedAt: now }).where(eq(notes.id, child.id)).run();
        openTrashRecord(tx, {
          entityType: 'note',
          entityId: child.id,
          groupId,
          trashedAt: now,
          reason: 'cascade',
          reasonDetail: `item ${id} trashed`,
          trashedByUserId,
          restorePayload: { parentItemId: id },
        });
        this.search?.removeEntity('note', child.id, tx);
      }
      for (const child of childAnnotations) {
        tx.update(annotations)
          .set({ trashedAt: now, updatedAt: now })
          .where(eq(annotations.id, child.id))
          .run();
        openTrashRecord(tx, {
          entityType: 'annotation',
          entityId: child.id,
          groupId,
          trashedAt: now,
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

      openTrashRecord(tx, {
        entityType: 'item',
        entityId: id,
        groupId,
        trashedAt: now,
        reason,
        reasonDetail: options.reasonDetail ?? null,
        trashedByUserId,
        mergeTargetItemId: options.mergeTargetItemId ?? null,
        mergeRecord: options.mergeRecord ?? null,
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

      this.search?.removeEntity('item', id, tx);

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

      const record = findOpenTrashRecord(tx, 'item', id);

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
      const siblings = group === null ? [record] : findTrashGroup(tx, group);

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
            this.search?.indexNote(row.entityId, tx);
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

        closeTrashRecord(tx, row.id, now, actor.userId ?? null);
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

      this.search?.indexItem(id, tx);

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

  /**
   * The shared `WHERE` of `listItems` and `countItems`.
   *
   * Returns `null` — meaning "no row can match" — when a text filter matched nothing at all, so
   * that the caller short-circuits instead of building `id IN ()`, which SQLite will not parse.
   */
  private filterConditions(
    options: ListItemsOptions,
  ): { conditions: ReturnType<typeof and>[]; textFilterTruncated: boolean } | null {
    const conditions: ReturnType<typeof and>[] = [sql`${items.libraryState} <> 'merged'`];
    let textFilterTruncated = false;
    if (options.includeTrashed !== true) conditions.push(isNull(items.trashedAt));
    if (options.itemType !== undefined) conditions.push(eq(items.itemType, options.itemType));
    if (options.ownerUserId !== undefined) conditions.push(eq(items.ownerUserId, options.ownerUserId));

    if (options.collectionId !== undefined) {
      conditions.push(
        inArray(
          items.id,
          this.db
            .select({ id: collectionItems.itemId })
            .from(collectionItems)
            .where(eq(collectionItems.collectionId, options.collectionId)),
        ),
      );
    }

    if (options.tagId !== undefined) {
      conditions.push(
        inArray(
          items.id,
          this.db
            .select({ id: itemTags.itemId })
            .from(itemTags)
            .where(eq(itemTags.tagId, options.tagId)),
        ),
      );
    }

    if (options.text !== undefined && options.text.trim() !== '') {
      const matched = this.textFilterIds(options.text);
      if (matched.length === 0) return null;
      // Materialising exactly the ceiling means there were probably more; a caller told only
      // `hasMore: false` would read "these are all of them" off a truncated candidate set.
      textFilterTruncated = matched.length >= TEXT_FILTER_CANDIDATES;
      conditions.push(inArray(items.id, matched));
    }

    return { conditions, textFilterTruncated };
  }

  /**
   * The item ids a text filter matches.
   *
   * The index when there is one; otherwise a `LIKE` over the title, which is a poor search and is
   * meant to be — it exists so that a deployment without FTS5 degrades to something rather than to
   * an exception, and the honest thing is for it to be visibly narrower rather than silently
   * pretending to be full-text.
   */
  private textFilterIds(text: string): string[] {
    if (this.search?.available === true) {
      return this.search.itemIdsMatching(text, TEXT_FILTER_CANDIDATES);
    }

    const pattern = `%${normalise(text).replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    return this.db
      .select({ id: items.id })
      .from(items)
      .where(sql`lower(coalesce(${items.title}, '')) like ${pattern} escape '\\'`)
      .limit(TEXT_FILTER_CANDIDATES)
      .all()
      .map((row) => row.id);
  }

  /**
   * Write bibliographic fields through the provenance gate (P4).
   *
   * The order is: normalise, ask the locks which fields may be written, write those, stamp them.
   * Asking before writing rather than after is what keeps a refused field from ever touching the
   * column — there is no "write then revert", so there is no window in which the wrong value exists.
   */
  private applyBibliographic(
    tx: RecueilTransaction,
    itemId: string,
    input: BibliographicInput,
    actor: Actor,
    stamp: ProvenanceStamp,
    now: string,
  ): { row: ItemBibliographicRow; applied: string[]; changed: string[]; skipped: SkippedField[] } {
    const values = normaliseBibliographic(input);
    const current =
      tx.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, itemId)).get() ?? null;

    const requested = Object.keys(values).filter((key) => values[key as keyof BibliographicInput] !== undefined);
    const { allowed, skipped } = this.provenance.partition(
      'item_bibliographic',
      itemId,
      requested,
      stamp.source,
      tx,
    );

    const writable: Record<string, unknown> = {};
    const previous: Record<string, unknown> = {};
    for (const key of allowed) {
      writable[key] = values[key as keyof BibliographicInput];
      previous[key] = current === null ? null : (current as unknown as Record<string, unknown>)[key];
    }

    if (current === null) {
      tx.insert(itemBibliographic)
        .values({ ...writable, itemId, itemTrashedAt: null, createdAt: now, updatedAt: now })
        .run();
    } else if (allowed.length > 0) {
      tx.update(itemBibliographic)
        .set({ ...writable, updatedAt: now })
        .where(eq(itemBibliographic.itemId, itemId))
        .run();
    }

    if (allowed.length > 0) {
      this.provenance.applyStamps(tx, {
        entityType: 'item_bibliographic',
        entityId: itemId,
        values: writable,
        previous,
        stamp,
        appliedAt: now,
        actor,
      });
    }

    const row = tx
      .select()
      .from(itemBibliographic)
      .where(eq(itemBibliographic.itemId, itemId))
      .get() as ItemBibliographicRow;
    return { row, applied: allowed, changed: changedKeys(allowed, previous, writable, current === null), skipped };
  }

  /** The same gate for the office facet (§3.7). */
  private applyOffice(
    tx: RecueilTransaction,
    itemId: string,
    input: Partial<OfficeInput> & { correspondent: string },
    actor: Actor,
    stamp: ProvenanceStamp,
    now: string,
  ): { row: ItemOfficeRow; applied: string[]; changed: string[]; skipped: SkippedField[] } {
    if (input.correspondent.trim() === '') {
      throw new ValidationError('The office facet requires a correspondent (§3.7).');
    }

    const current = tx.select().from(itemOffice).where(eq(itemOffice.itemId, itemId)).get() ?? null;
    const values: Record<string, unknown> = {
      ...input,
      correspondentNormalised: normalise(input.correspondent),
    };

    const requested = Object.keys(values).filter(
      (key) => values[key] !== undefined && key !== 'correspondentNormalised',
    );
    const { allowed, skipped } = this.provenance.partition(
      'item_office',
      itemId,
      requested,
      stamp.source,
      tx,
    );

    const writable: Record<string, unknown> = {};
    const previous: Record<string, unknown> = {};
    for (const key of allowed) {
      writable[key] = values[key];
      previous[key] = current === null ? null : (current as unknown as Record<string, unknown>)[key];
    }
    // The normalised mirror follows its source column and is not a field of its own (§1.1).
    if (allowed.includes('correspondent')) {
      writable['correspondentNormalised'] = values['correspondentNormalised'];
    }

    if (current === null) {
      tx.insert(itemOffice)
        .values({
          ...writable,
          correspondent: input.correspondent,
          correspondentNormalised: normalise(input.correspondent),
          itemId,
          itemTrashedAt: null,
          createdAt: now,
          updatedAt: now,
        } as typeof itemOffice.$inferInsert)
        .run();
    } else if (allowed.length > 0) {
      tx.update(itemOffice)
        .set({ ...writable, updatedAt: now })
        .where(eq(itemOffice.itemId, itemId))
        .run();
    }

    if (allowed.length > 0) {
      this.provenance.applyStamps(tx, {
        entityType: 'item_office',
        entityId: itemId,
        values: Object.fromEntries(allowed.map((key) => [key, values[key]])),
        previous,
        stamp,
        appliedAt: now,
        actor,
      });
    }

    const row = tx.select().from(itemOffice).where(eq(itemOffice.itemId, itemId)).get() as ItemOfficeRow;
    return { row, applied: allowed, changed: changedKeys(allowed, previous, writable, current === null), skipped };
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

/**
 * Which of the fields the provenance gate allowed actually hold a different value now.
 *
 * "Allowed" and "changed" are not the same set, and treating them as one is what made a re-run of
 * an importer bump `items.version` on every row it touched. That column is the REST `ETag`, so a
 * no-op write invalidated every client's conditional-write token for no reason (P1, §1.7).
 *
 * A facet row that did not exist counts as wholly changed: everything written to it is new.
 */
const changedKeys = (
  allowed: readonly string[],
  previous: Record<string, unknown>,
  writable: Record<string, unknown>,
  isNew: boolean,
): string[] => (isNew ? [...allowed] : allowed.filter((key) => !Object.is(previous[key], writable[key])));

/** The transaction handle Drizzle hands a `db.transaction` callback. */
type RecueilTransaction = Parameters<Parameters<RecueilDatabase['transaction']>[0]>[0];

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
