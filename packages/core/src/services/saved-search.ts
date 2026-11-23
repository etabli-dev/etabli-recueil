/**
 * Saved searches: the structured query of a smart collection (CONCEPT §5.7, `spec/data-model.md` §4.1).
 *
 * ```json
 * { "text": "hip fracture", "itemTypes": ["article"], "tags": ["geriatrics"], "notTags": ["excluded"],
 *   "collectionId": "…", "yearFrom": 2015, "yearTo": 2024, "hasFile": true,
 *   "retraction": ["retracted"], "failingChecks": ["retraction", "doi_resolves"] }
 * ```
 *
 * Every key is optional and they combine with AND; `tags` means all of them. `text` runs through
 * the full-text index and keeps its ranking; without `text` the result is newest first. The Phase 1
 * form `{"text": "…"}` (or `{"q": "…"}`) is the same query with no filters.
 */
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { attachments, checkResults, collectionItems, itemBibliographic, itemTags, items, tags } from '../db/schema.js';
import { ValidationError } from '../errors.js';
import { normalise } from '../normalise.js';
import type { SearchService } from './search.js';

export interface SavedSearchQuery {
  text?: string;
  itemTypes?: string[];
  tags?: string[];
  notTags?: string[];
  collectionId?: string;
  yearFrom?: number;
  yearTo?: number;
  hasFile?: boolean;
  retraction?: string[];
  failingChecks?: string[];
}

const KEYS = new Set(['text', 'q', 'itemTypes', 'tags', 'notTags', 'collectionId', 'yearFrom', 'yearTo', 'hasFile', 'retraction', 'failingChecks']);

const stringList = (value: unknown, key: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ValidationError(`Saved search: \`${key}\` must be a list of strings.`);
  }
  return value as string[];
};

/** Parse and check a stored query. Unknown keys are refused, so a typo is not a silent no-op. */
export const parseSavedSearch = (raw: unknown): SavedSearchQuery => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ValidationError('A saved search is a JSON object.');
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!KEYS.has(key)) throw new ValidationError(`Saved search: unknown key \`${key}\`.`);
  }
  const text = value['text'] ?? value['q'];
  if (text !== undefined && typeof text !== 'string') throw new ValidationError('Saved search: `text` must be a string.');
  for (const key of ['yearFrom', 'yearTo'] as const) {
    if (value[key] !== undefined && !Number.isInteger(value[key])) throw new ValidationError(`Saved search: \`${key}\` must be a year.`);
  }
  if (value['hasFile'] !== undefined && typeof value['hasFile'] !== 'boolean') throw new ValidationError('Saved search: `hasFile` is true or false.');
  if (value['collectionId'] !== undefined && typeof value['collectionId'] !== 'string') throw new ValidationError('Saved search: `collectionId` is an id.');
  const query: SavedSearchQuery = {};
  if (typeof text === 'string' && text.trim() !== '') query.text = text.trim();
  const lists = ['itemTypes', 'tags', 'notTags', 'retraction', 'failingChecks'] as const;
  for (const key of lists) {
    const list = stringList(value[key], key);
    if (list !== undefined && list.length > 0) query[key] = list;
  }
  if (typeof value['collectionId'] === 'string') query.collectionId = value['collectionId'];
  if (typeof value['yearFrom'] === 'number') query.yearFrom = value['yearFrom'];
  if (typeof value['yearTo'] === 'number') query.yearTo = value['yearTo'];
  if (typeof value['hasFile'] === 'boolean') query.hasFile = value['hasFile'];
  if (Object.keys(query).length === 0) throw new ValidationError('A saved search needs at least `text` or one filter.');
  return query;
};

const tagIds = (db: RecueilDatabase, names: readonly string[]): string[] =>
  db
    .select({ id: tags.id })
    .from(tags)
    .where(and(inArray(tags.nameNormalised, names.map((name) => normalise(name))), isNull(tags.trashedAt)))
    .all()
    .map((row) => row.id);

/** Item ids matching the query: ranked by the index when there is text, newest first otherwise. */
export const evaluateSavedSearch = (
  db: RecueilDatabase,
  search: SearchService | undefined,
  query: SavedSearchQuery,
  limit: number,
): string[] => {
  let candidates: string[] | null = null;
  if (query.text !== undefined) {
    if (search === undefined || !search.available) return [];
    candidates = search.itemIdsMatching(query.text, Math.max(limit * 4, 1000));
    if (candidates.length === 0) return [];
  }

  const conditions = [isNull(items.trashedAt), sql`${items.libraryState} <> 'merged'`];
  if (candidates !== null) conditions.push(inArray(items.id, candidates));
  if (query.itemTypes !== undefined) conditions.push(inArray(items.itemType, query.itemTypes));
  if (query.yearFrom !== undefined) conditions.push(gte(itemBibliographic.issuedYear, query.yearFrom));
  if (query.yearTo !== undefined) conditions.push(lte(itemBibliographic.issuedYear, query.yearTo));
  if (query.retraction !== undefined) conditions.push(inArray(itemBibliographic.retractionStatus, query.retraction as never[]));
  if (query.collectionId !== undefined) {
    conditions.push(
      inArray(
        items.id,
        db.select({ id: collectionItems.itemId }).from(collectionItems).where(eq(collectionItems.collectionId, query.collectionId)),
      ),
    );
  }
  if (query.tags !== undefined) {
    const ids = tagIds(db, query.tags);
    if (ids.length < query.tags.length) return []; // a tag that does not exist matches nothing
    for (const tagId of ids) {
      conditions.push(inArray(items.id, db.select({ id: itemTags.itemId }).from(itemTags).where(eq(itemTags.tagId, tagId))));
    }
  }
  if (query.notTags !== undefined) {
    const ids = tagIds(db, query.notTags);
    if (ids.length > 0) {
      conditions.push(sql`${items.id} not in (select ${itemTags.itemId} from ${itemTags} where ${inArray(itemTags.tagId, ids)})`);
    }
  }
  if (query.hasFile !== undefined) {
    const withFile = db
      .select({ id: attachments.itemId })
      .from(attachments)
      .where(and(isNull(attachments.trashedAt), sql`${attachments.documentId} is not null`));
    conditions.push(query.hasFile ? inArray(items.id, withFile) : sql`${items.id} not in (${withFile})`);
  }
  if (query.failingChecks !== undefined) {
    conditions.push(
      inArray(
        items.id,
        db
          .select({ id: checkResults.itemId })
          .from(checkResults)
          .where(
            and(
              inArray(checkResults.checkId, query.failingChecks),
              eq(checkResults.status, 'fail'),
              isNull(checkResults.acknowledgedAt),
              eq(checkResults.runScopeKey, ''),
            ),
          ),
      ),
    );
  }

  const rows = db
    .select({ id: items.id })
    .from(items)
    .leftJoin(itemBibliographic, eq(itemBibliographic.itemId, items.id))
    .where(and(...conditions))
    .orderBy(desc(items.dateAdded), desc(items.id))
    .limit(candidates === null ? limit : Math.max(limit, candidates.length))
    .all()
    .map((row) => row.id);

  if (candidates === null) return rows.slice(0, limit);
  // Keep the index's ranking.
  const kept = new Set(rows);
  return candidates.filter((id) => kept.has(id)).slice(0, limit);
};
