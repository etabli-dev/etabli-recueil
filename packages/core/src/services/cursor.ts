/**
 * Cursor pagination.
 *
 * Offsets lie when the underlying set changes under you, and a library is exactly the kind of set
 * that changes while you page through it — an ingestion run is inserting rows the whole time. So a
 * page is continued by an opaque token holding the sort key and the id of the last row seen, and
 * the next page is "everything after that pair" (`@recueil/schemas`, `CursorSchema`).
 *
 * The token is base64url of a tiny JSON object, which keeps it inside the `[A-Za-z0-9_-]` shape the
 * contract promises. It is opaque by contract, not by encryption: a client that unpacks one and
 * relies on its innards will break, and that is the client's fault.
 */
import { ValidationError } from '../errors.js';

export interface CursorPayload {
  /** The sort key of the last row on the previous page. */
  k: string;
  /** Its id, which breaks ties and makes the order total. */
  i: string;
}

export const encodeCursor = (payload: CursorPayload): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

export const decodeCursor = (cursor: string): CursorPayload => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('Malformed cursor. Pass back the token you were given, verbatim.', {
      cursor,
    });
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as CursorPayload).k !== 'string' ||
    typeof (parsed as CursorPayload).i !== 'string'
  ) {
    throw new ValidationError('Malformed cursor. Pass back the token you were given, verbatim.', {
      cursor,
    });
  }

  return parsed as CursorPayload;
};

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  /**
   * True when a text filter matched more rows than it was allowed to materialise, so this page is
   * drawn from the best-ranked `TEXT_FILTER_CANDIDATES` matches rather than from all of them.
   *
   * A caller cannot otherwise tell truncation from exhaustion: `hasMore: false` on the last page of
   * a truncated candidate set looks exactly like the end of the results, and "these are all of
   * them" is a different statement from "these are the best five hundred". Absent when no text
   * filter was applied.
   */
  textFilterTruncated?: boolean;
}

export interface Page<TRow> {
  data: TRow[];
  page: PageInfo;
}

/** Clamp a caller's page size to the contract's range. */
export const resolveLimit = (limit: number | undefined): number => {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(`Page size must be a positive integer, got ${String(limit)}.`);
  }
  return Math.min(limit, MAX_PAGE_SIZE);
};
