/**
 * Timestamps.
 *
 * `spec/data-model.md` §1.1: a `TIMESTAMP` is stored in SQLite as TEXT in exactly one form —
 * `YYYY-MM-DDTHH:MM:SS.sssZ`, fixed width, always `Z`, always three fractional digits — so that
 * lexicographic order equals chronological order and a cursor can be a plain string comparison.
 * `Date.prototype.toISOString` produces precisely that form.
 *
 * §1.8: `created_at`/`updated_at` are set by the application, not by a database default, so that an
 * importer can preserve the original timestamps of the library it is reading.
 */

/** The current instant in the one permitted form. */
export const nowTimestamp = (): string => new Date().toISOString();

/** An arbitrary instant in the one permitted form. */
export const toTimestamp = (value: Date | number | string): string => new Date(value).toISOString();

/** A complete calendar date, `YYYY-MM-DD` (§1.1). */
export const toCalendarDate = (value: Date | number | string): string =>
  new Date(value).toISOString().slice(0, 10);
