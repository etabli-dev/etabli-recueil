/**
 * The handful of reads and one write that `packages/core` does not expose as a service method.
 *
 * The rule this file lives by: **no business logic here**. Everything below is either a projection
 * the services have no reason to offer — "the tags of this item, with the timestamp from the join
 * row", "enough of a hundred items to render a list" — or, in the one case of `reorderAttachments`,
 * a positional write that the attachment table supports and no service method covers.
 *
 * Anything that decides something belongs in `packages/core`, which is another agent's file and the
 * right home for it. If a rule ever needs to be added to one of these, the function should move
 * rather than grow.
 */
import { schema } from '@recueil/core';
import type { AuditService, Actor, RecueilDatabase } from '@recueil/core';
import { NotFoundError, nowTimestamp } from '@recueil/core';
import type { ItemSummary, ItemTag } from '@recueil/schemas';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

/* -------------------------------------------------------------------------------------------- */
/* Item expansions                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * The tags on one item, in the `ItemTag` shape — which carries `addedAt` and the reason the tag is
 * there (P4, "why is this tagged"). `TagService.forItem` returns the tag rows and the assignment
 * metadata but not the join's timestamp, and the contract asks for it.
 */
export const itemTagsFor = (db: RecueilDatabase, itemId: string): ItemTag[] =>
  db
    .select({
      tagId: schema.tags.id,
      name: schema.tags.name,
      colour: schema.tags.colour,
      source: schema.itemTags.source,
      ruleRef: schema.itemTags.ruleRef,
      confidence: schema.itemTags.confidence,
      addedAt: schema.itemTags.addedAt,
    })
    .from(schema.itemTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.itemTags.tagId))
    .where(and(eq(schema.itemTags.itemId, itemId), isNull(schema.tags.trashedAt)))
    .orderBy(asc(schema.tags.position), asc(schema.tags.nameNormalised))
    .all();

/** The attachments of one item, in position order (§3.8). */
export const attachmentsFor = (
  db: RecueilDatabase,
  itemId: string,
  options: { includeTrashed?: boolean } = {},
): schema.AttachmentRow[] =>
  db
    .select()
    .from(schema.attachments)
    .where(
      options.includeTrashed === true
        ? eq(schema.attachments.itemId, itemId)
        : and(eq(schema.attachments.itemId, itemId), isNull(schema.attachments.trashedAt)),
    )
    .orderBy(asc(schema.attachments.position), asc(schema.attachments.id))
    .all();

export const attachmentById = (db: RecueilDatabase, id: string): schema.AttachmentRow => {
  const row = db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).get();
  if (row === undefined) throw new NotFoundError('attachment', id);
  return row;
};

/** Live notes on one item, ids only — the item response carries ids and the note routes the bodies. */
export const noteIdsFor = (db: RecueilDatabase, itemId: string): string[] =>
  db
    .select({ id: schema.notes.id })
    .from(schema.notes)
    .where(and(eq(schema.notes.itemId, itemId), isNull(schema.notes.trashedAt)))
    .orderBy(asc(schema.notes.createdAt))
    .all()
    .map((row) => row.id);

/** The collections one item is filed in. */
export const collectionIdsFor = (db: RecueilDatabase, itemId: string): string[] =>
  db
    .select({ collectionId: schema.collectionItems.collectionId })
    .from(schema.collectionItems)
    .innerJoin(schema.collections, eq(schema.collections.id, schema.collectionItems.collectionId))
    .where(and(eq(schema.collectionItems.itemId, itemId), isNull(schema.collections.trashedAt)))
    .all()
    .map((row) => row.collectionId);

/* -------------------------------------------------------------------------------------------- */
/* List rendering                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * Render "Ravaud et al." — the string a library row shows instead of an author list.
 *
 * One author is the name; two are joined; three or more are the first and `et al.`. That is the
 * convention every reference manager uses and the one CONCEPT.md's own example follows
 * (`ItemSummary.creatorSummary`).
 */
export const renderCreatorSummary = (names: readonly string[]): string | null => {
  if (names.length === 0) return null;
  const [first, second] = names;
  if (names.length === 1) return first as string;
  if (names.length === 2) return `${first as string} and ${second as string}`;
  return `${first as string} et al.`;
};

/**
 * The extra columns a list row needs, for a whole page at once.
 *
 * Three queries for a page of any size rather than three per row: a hundred-row page that issued
 * three hundred statements would be the single slowest thing in the API.
 */
export const summariseItems = (
  db: RecueilDatabase,
  rows: readonly schema.ItemRow[],
): ItemSummary[] => {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const facets = new Map(
    db
      .select({
        itemId: schema.itemBibliographic.itemId,
        issuedYear: schema.itemBibliographic.issuedYear,
        containerTitle: schema.itemBibliographic.containerTitle,
      })
      .from(schema.itemBibliographic)
      .where(inArray(schema.itemBibliographic.itemId, ids))
      .all()
      .map((row) => [row.itemId, row] as const),
  );

  const attachmentCounts = new Map(
    db
      .select({ itemId: schema.attachments.itemId, count: sql<number>`count(*)` })
      .from(schema.attachments)
      .where(and(inArray(schema.attachments.itemId, ids), isNull(schema.attachments.trashedAt)))
      .groupBy(schema.attachments.itemId)
      .all()
      .map((row) => [row.itemId, Number(row.count)] as const),
  );

  const authors = new Map<string, string[]>();
  for (const row of db
    .select({
      itemId: schema.itemCreators.itemId,
      ordinal: schema.itemCreators.ordinal,
      familyName: schema.creators.familyName,
      literalName: schema.creators.literalName,
      displayName: schema.creators.displayName,
    })
    .from(schema.itemCreators)
    .innerJoin(schema.creators, eq(schema.creators.id, schema.itemCreators.creatorId))
    .where(and(inArray(schema.itemCreators.itemId, ids), eq(schema.itemCreators.role, 'author')))
    .orderBy(asc(schema.itemCreators.ordinal))
    .all()) {
    const list = authors.get(row.itemId) ?? [];
    list.push(row.familyName ?? row.literalName ?? row.displayName);
    authors.set(row.itemId, list);
  }

  return rows.map((row) => {
    const facet = facets.get(row.id);
    return {
      id: row.id,
      publicId: row.publicId,
      itemType: row.itemType,
      title: row.title,
      creatorSummary: renderCreatorSummary(authors.get(row.id) ?? []),
      issuedYear: facet?.issuedYear ?? null,
      containerTitle: facet?.containerTitle ?? null,
      attachmentCount: attachmentCounts.get(row.id) ?? 0,
      dateModified: row.dateModified,
    };
  });
};

/* -------------------------------------------------------------------------------------------- */
/* Reordering                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * Rewrite the positions of an item's attachments.
 *
 * The caller sends the ids in the order it wants; positions become 0..n-1 in that order, and any
 * live attachment the caller left out keeps its relative order after the ones named. Dense and
 * total, in one transaction, because a half-applied reorder is a list that renders differently on
 * every refresh.
 *
 * An id belonging to another item is refused rather than ignored: it is far more likely to be a bug
 * in the client than an instruction.
 */
export const reorderAttachments = (
  db: RecueilDatabase,
  audit: AuditService,
  itemId: string,
  orderedIds: readonly string[],
  actor: Actor,
): schema.AttachmentRow[] =>
  db.transaction((tx) => {
    const live = tx
      .select()
      .from(schema.attachments)
      .where(and(eq(schema.attachments.itemId, itemId), isNull(schema.attachments.trashedAt)))
      .orderBy(asc(schema.attachments.position), asc(schema.attachments.id))
      .all();

    const byId = new Map(live.map((row) => [row.id, row] as const));
    const seen = new Set<string>();
    const ordered: schema.AttachmentRow[] = [];

    for (const id of orderedIds) {
      const row = byId.get(id);
      if (row === undefined) {
        throw new NotFoundError('attachment', id);
      }
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(row);
    }
    for (const row of live) {
      if (!seen.has(row.id)) ordered.push(row);
    }

    const now = nowTimestamp();
    const before = live.map((row) => ({ id: row.id, position: row.position }));

    ordered.forEach((row, position) => {
      if (row.position === position) return;
      tx.update(schema.attachments)
        .set({ position, updatedAt: now })
        .where(eq(schema.attachments.id, row.id))
        .run();
    });

    audit.record(
      {
        actor,
        action: 'attachment.reordered',
        entityType: 'item',
        entityId: itemId,
        before: { attachments: before },
        after: { attachments: ordered.map((row, position) => ({ id: row.id, position })) },
      },
      tx,
    );

    return ordered.map((row, position) => ({ ...row, position, updatedAt: now }));
  });
