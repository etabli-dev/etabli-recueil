/**
 * Paperless dates onto the two forms `spec/data-model.md` §1.1 allows.
 *
 * A `TIMESTAMP` is `YYYY-MM-DDTHH:MM:SS.sssZ` — fixed width, always UTC, always three fractional
 * digits — and a `DATE` is `YYYY-MM-DD`. Paperless sends neither shape exactly: Django serialises
 * datetimes with an offset (`2024-03-01T09:12:44.512345+01:00`) and dates as bare `YYYY-MM-DD`,
 * and API version 9 changed `created` from a datetime to a date, so a server that has been upgraded
 * in place can still be holding either.
 *
 * The rule for `document_date` is the one that matters and it is not obvious: **a date that arrives
 * as a local-time datetime keeps its local calendar day.** `2024-03-01T00:30:00+01:00` is the first
 * of March to the person who filed it; converting to UTC and taking the first ten characters makes
 * it the twenty-ninth of February. The date printed on a document is a calendar fact in the filer's
 * own timezone, and `document_date` is documented as "the date printed on the document" (§3.7), so
 * the offset is applied before the day is read, never after.
 *
 * `added` and `modified` are instants rather than calendar facts, so they convert to UTC normally.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/u;

/** `YYYY-MM-DD`, or null when the value is absent, empty or not a date at all. */
export const toDocumentDate = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly !== null) return isRealDate(trimmed) ? trimmed : null;

  const parts = DATE_TIME_WITH_OFFSET.exec(trimmed);
  if (parts === null) return null;

  // The calendar day as written, in whatever zone it was written in. The offset is not applied,
  // which is the whole point: the printed date does not move because the reader is elsewhere.
  const day = `${parts[1]}-${parts[2]}-${parts[3]}`;
  return isRealDate(day) ? day : null;
};

/** `YYYY-MM-DDTHH:MM:SS.sssZ`, or null. Genuine instants only: `added`, `modified`, note `created`. */
export const toInstant = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // A bare calendar date is midnight UTC. Django only sends this shape for `DateField`s, which are
  // never instants, but a caller that passes one should get something rather than nothing.
  if (DATE_ONLY.test(trimmed)) {
    return isRealDate(trimmed) ? `${trimmed}T00:00:00.000Z` : null;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
};

/**
 * The document date of one Paperless document.
 *
 * `created` is the field to use; `created_date` is deprecated upstream (`@extend_schema_serializer(
 * deprecate_fields=["created_date"])`) but still serialised at 3.0.5, and older servers sent only
 * `created` as a full datetime. Preferring `created` and falling back to `created_date` reads
 * every one of those shapes without a version switch.
 */
export const documentDateOf = (document: {
  created?: string | null;
  created_date?: string | null;
}): string | null => toDocumentDate(document.created) ?? toDocumentDate(document.created_date);

const isRealDate = (day: string): boolean => {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
};
