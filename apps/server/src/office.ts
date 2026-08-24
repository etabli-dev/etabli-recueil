/**
 * The office facet's one real constraint: the archive serial number.
 *
 * `spec/data-model.md` §3.7 makes `asn` "unique across live items", and the schema backs it with a
 * partial unique index — `ux_item_office_asn` on `(asn) where asn is not null and item_trashed_at
 * is null`. The index is the constraint; this module is what turns a violation of it into an answer
 * a caller can act on.
 *
 * Both halves are needed and neither is sufficient.
 *
 * **The pre-check** turns "UNIQUE constraint failed: item_office.asn" — which is a 500 and tells a
 * user nothing — into a 409 naming the item that already holds the number. Paperless users renumber
 * by hand constantly, and "ASN 4711 belongs to item 01J… (Stadtwerke invoice)" is the difference
 * between a fix and a support request.
 *
 * **The translation** catches the case the pre-check cannot: two writes racing between the check
 * and the insert. SQLite serialises writers, so the loser gets the constraint error, and it must
 * still be a 409 rather than a 500. A pre-check on its own would be a check that is usually right,
 * which is the worst kind.
 *
 * Trashed items are deliberately outside the constraint (P5): a number freed by trashing an item
 * can be reused, and restoring the trashed item then fails on the index rather than silently
 * producing two live items with one number.
 */
import { ConflictError, schema } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import { and, eq, isNull, ne } from 'drizzle-orm';

/** The message SQLite produces for the partial unique index, in either of its spellings. */
const ASN_CONSTRAINT = /unique constraint failed:.*(?:item_office\.asn|ux_item_office_asn)/iu;

/** The live item holding this ASN, if any. */
export const itemWithAsn = (
  recueil: Recueil,
  asn: number,
  exceptItemId?: string,
): { itemId: string; title: string | null; correspondent: string } | null => {
  const clauses = [eq(schema.itemOffice.asn, asn), isNull(schema.itemOffice.itemTrashedAt)];
  if (exceptItemId !== undefined) clauses.push(ne(schema.itemOffice.itemId, exceptItemId));

  const row = recueil.db
    .select({
      itemId: schema.itemOffice.itemId,
      correspondent: schema.itemOffice.correspondent,
      title: schema.items.title,
    })
    .from(schema.itemOffice)
    .innerJoin(schema.items, eq(schema.items.id, schema.itemOffice.itemId))
    .where(and(...clauses))
    .get();

  return row ?? null;
};

/**
 * Refuse a write that would give a second live item an ASN that is already taken.
 *
 * Called before the write. `exceptItemId` is the item being written, so re-saving an item with the
 * ASN it already has is not a conflict with itself.
 */
export const assertAsnFree = (recueil: Recueil, asn: number | null | undefined, exceptItemId?: string): void => {
  if (asn === null || asn === undefined) return;
  const holder = itemWithAsn(recueil, asn, exceptItemId);
  if (holder === null) return;

  throw new ConflictError(
    `Archive serial number ${String(asn)} already belongs to item '${holder.itemId}'` +
      `${holder.title === null ? '' : ` (${holder.title})`}. An ASN is unique across live items ` +
      '(spec/data-model.md §3.7); trash or renumber that item first.',
    { asn, itemId: holder.itemId, correspondent: holder.correspondent },
  );
};

/**
 * Run a write, turning the ASN index's own refusal into the same 409 the pre-check produces.
 *
 * The pre-check and this are not redundant: the check is what makes the message useful, and this is
 * what makes the guarantee true when two writes race. Anything that is not the ASN index is
 * rethrown untouched — swallowing a constraint error because it happened near an office write is
 * exactly how a data-model invariant becomes folklore.
 */
export const withAsnConflict = <T>(recueil: Recueil, asn: number | null | undefined, run: () => T): T => {
  try {
    return run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!ASN_CONSTRAINT.test(message)) throw error;

    const holder = asn === null || asn === undefined ? null : itemWithAsn(recueil, asn);
    throw new ConflictError(
      asn === null || asn === undefined
        ? 'An archive serial number in this write is already held by another live item ' +
          '(spec/data-model.md §3.7).'
        : `Archive serial number ${String(asn)} is already held by another live item` +
          `${holder === null ? '' : ` ('${holder.itemId}')`} (spec/data-model.md §3.7).`,
      { ...(asn === null || asn === undefined ? {} : { asn }), ...(holder === null ? {} : { itemId: holder.itemId }) },
    );
  }
};

/** The ASN an item currently holds, trashed or not. What a restore is about to re-assert. */
export const asnOfItem = (recueil: Recueil, itemId: string): number | null => {
  const row = recueil.db
    .select({ asn: schema.itemOffice.asn })
    .from(schema.itemOffice)
    .where(eq(schema.itemOffice.itemId, itemId))
    .get();
  return row?.asn ?? null;
};

/** Pull the ASN out of a write body, whichever shape it arrived in. */
export const asnOf = (body: { office?: { asn?: number | null } | null } | { asn?: number | null }): number | null | undefined => {
  if ('office' in body) return body.office?.asn;
  return (body as { asn?: number | null }).asn;
};
