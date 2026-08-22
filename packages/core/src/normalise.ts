/**
 * Normalisation of the `*_normalised` mirror columns.
 *
 * `spec/data-model.md` §1.1: SQLite `LIKE` folds ASCII case and Postgres does not, and `COLLATE
 * NOCASE` has no Postgres counterpart, so every uniqueness or lookup rule that should ignore case
 * gets a stored, application-maintained column instead of an expression index. This module is the
 * definition of "normalised": NFKC, casefolded, whitespace collapsed.
 */

/** The normalisation used by every `*_normalised` column. */
export const normalise = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

/**
 * The `COALESCE(col, '')` mirror of a nullable column (§1.1). `NULL`s are distinct in a unique
 * index in both dialects, so a rule like "one row per (parent, name), roots included" is written
 * over the mirror rather than over the nullable column it shadows.
 */
export const scopeKey = (value: string | null | undefined): string => value ?? '';

/** A DOI as stored: lowercased, with any resolver prefix stripped (§3.5, invariant B1). */
export const normaliseDoi = (value: string): string =>
  value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:/iu, '')
    .toLowerCase();
