/**
 * Full-text search (ADR-0011, `spec/data-model.md` §9).
 *
 * SQLite FTS5 is the always-available index; Meilisearch is an optional sidecar for larger
 * libraries, behind this same interface. That is why nothing above this module knows what `MATCH`
 * is: callers pass Recueil's own query syntax (`search-query.ts`), get back entity references and
 * a relevance score, and stay portable across the two backends.
 *
 * ## What is indexed
 *
 * One logical document per indexed entity, three entity types in Phase 1:
 *
 * | Entity | Built from |
 * |---|---|
 * | `item` | `items`, `item_bibliographic`, `item_office`, `item_creators` ⋈ `creators`, `item_tags` ⋈ `tags` |
 * | `note` | `notes.content_markdown` and its title |
 * | `document` | the extracted text of a document, which is deliberately not a column on `documents` (§9) |
 *
 * A hit on a note or on a document's text resolves back to the items it belongs to, so a search for
 * a phrase a user only ever wrote in a note still returns the paper.
 *
 * ## How it stays in sync
 *
 * By service-level writes, not by triggers. The indexed document for an item is an aggregate over
 * six tables; a trigger per source table would fire six times for one logical change, in an order
 * SQLite does not promise, and each firing would have to re-aggregate the other five anyway. So
 * every service that changes something an item's document is built from calls `indexItem` inside
 * its own transaction, and the index commits or rolls back with the write that caused it.
 *
 * `rebuild()` exists because the index is derived data: it can be dropped and rebuilt from the
 * tables at any time, and a bug in a sync call is therefore an inconvenience rather than a
 * corruption.
 *
 * ## The Postgres guard
 *
 * FTS5 is a SQLite virtual table and has no Postgres counterpart — a Postgres deployment gets a
 * `tsvector` index from its own migration series (§9, ADR-0015). So this module runs **no** SQL at
 * import time, and every method first asks `available`, which probes for the index once and caches
 * the answer. On a backend without it, writes are no-ops and `search` throws a clear error rather
 * than a driver-level one from three frames down.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import {
  attachments,
  creators,
  itemBibliographic,
  itemCreators,
  itemOffice,
  itemTags,
  items,
  notes,
  tags,
} from '../db/schema.js';
import { ConflictError } from '../errors.js';
import { nowTimestamp } from '../time.js';
import { compileSearchQuery } from './search-query.js';

export type SearchEntityType = 'item' | 'note' | 'document';

/** Anything that can run raw SQL: the database, or a transaction on it. */
export type SearchExecutor = Pick<RecueilDatabase, 'run' | 'all' | 'get' | 'select'>;

/**
 * The narrow face of the index that the other services hold.
 *
 * They depend on this interface and not on `SearchService`, so that a library constructed without
 * an index — a migration tool, a test that does not care — passes `undefined` and every call site
 * stays a plain optional-chaining call rather than a conditional.
 */
export interface SearchIndexer {
  indexItem(itemId: string, executor?: SearchExecutor): void;
  indexNote(noteId: string, executor?: SearchExecutor): void;
  removeEntity(entityType: SearchEntityType, entityId: string, executor?: SearchExecutor): void;
}

/**
 * The face of the index that `LibraryService` holds: the writer, plus the one read it needs.
 *
 * `listItems({ text })` is a SQL query with a full-text predicate folded into it, not a search
 * result page, so what it wants from the index is an ordered list of item ids and nothing else.
 */
export interface LibrarySearch extends SearchIndexer {
  readonly available: boolean;
  itemIdsMatching(query: string, limit?: number): string[];
}

export interface SearchHit {
  entityType: SearchEntityType;
  entityId: string;
  /** The item this hit belongs to, when the entity is not itself an item. */
  itemId: string | null;
  /** BM25, lower is better. Exposed as-is: it is a rank, not a percentage. */
  score: number;
  /** A fragment of the matching field, with the matched words marked by `«` and `»`. */
  snippet: string | null;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  /** Restrict to one kind of indexed entity. */
  entityType?: SearchEntityType;
}

export interface SearchResult {
  hits: SearchHit[];
  /** The compiled backend expression, for a caller that wants to explain a result set. */
  expression: string;
}

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;

/**
 * The columns of `search_index`, in declaration order, with the weights `bm25()` gives them.
 *
 * A title match beats a body match beats a match in the extracted text of a fifty-page PDF, which
 * is what a reader means by relevance in a reference library.
 */
const BM25_WEIGHTS = [8.0, 4.0, 2.0, 6.0, 3.0, 1.5, 1.0] as const;

export class SearchService implements SearchIndexer {
  private probed: boolean | null = null;

  constructor(private readonly db: RecueilDatabase) {}

  /**
   * Is there an FTS5 index behind this database?
   *
   * Probed once, lazily, and cached: the answer cannot change under a running process, because the
   * only thing that creates the index is a migration, and migrations run before the services do.
   */
  get available(): boolean {
    if (this.probed !== null) return this.probed;
    this.probed = false;
    try {
      const row = this.db.get<{ n: number }>(
        sql`select count(*) as n from sqlite_master where name in ('search_index', 'search_entries')`,
      );
      this.probed = (row?.n ?? 0) === 2;
    } catch {
      // A non-SQLite driver, or a database without the search migration. Either way: no index.
      this.probed = false;
    }
    return this.probed;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Writing the index                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  /** Build and store the indexed document for one item. A trashed item is removed instead. */
  indexItem(itemId: string, executor: SearchExecutor = this.db): void {
    if (!this.available) return;

    const item = executor.select().from(items).where(eq(items.id, itemId)).get();
    if (item === undefined || item.trashedAt !== null) {
      this.removeEntity('item', itemId, executor);
      return;
    }

    const bibliographic =
      executor.select().from(itemBibliographic).where(eq(itemBibliographic.itemId, itemId)).get() ??
      null;
    const office =
      executor.select().from(itemOffice).where(eq(itemOffice.itemId, itemId)).get() ?? null;

    const people = executor
      .select({
        displayName: creators.displayName,
        sortName: creators.sortName,
        nameVariants: creators.nameVariants,
        rawName: itemCreators.rawName,
        affiliation: itemCreators.affiliationRaw,
      })
      .from(itemCreators)
      .innerJoin(creators, eq(creators.id, itemCreators.creatorId))
      .where(eq(itemCreators.itemId, itemId))
      .all();

    const tagNames = executor
      .select({ name: tags.name })
      .from(itemTags)
      .innerJoin(tags, eq(tags.id, itemTags.tagId))
      .where(and(eq(itemTags.itemId, itemId), isNull(tags.trashedAt)))
      .all()
      .map((row) => row.name);

    this.write(executor, 'item', itemId, null, {
      title: join([item.title, bibliographic?.title, bibliographic?.subtitle, bibliographic?.shortTitle]),
      creators: join([
        ...people.flatMap((person) => [
          person.displayName,
          person.sortName,
          person.rawName,
          person.affiliation,
          ...nameVariantForms(person.nameVariants),
        ]),
      ]),
      container: join([
        bibliographic?.containerTitle,
        bibliographic?.containerShort,
        bibliographic?.collectionTitle,
        bibliographic?.publisher,
        bibliographic?.publisherPlace,
      ]),
      identifiers: join([
        item.publicId,
        bibliographic?.doi,
        bibliographic?.pmid,
        bibliographic?.pmcid,
        bibliographic?.arxivId,
        bibliographic?.isbn,
        bibliographic?.issn,
        bibliographic?.eissn,
        bibliographic?.openalexId,
        bibliographic?.semanticScholarId,
        bibliographic?.handle,
        bibliographic?.citationKey,
        office?.referenceNumber,
        office?.asn === null || office?.asn === undefined ? null : String(office.asn),
      ]),
      tags: join(tagNames),
      body: join([
        bibliographic?.abstract,
        item.extra,
        office?.correspondent,
        office?.officeDocumentType,
      ]),
      text: '',
    });
  }

  /** Build and store the indexed document for one note. A trashed note is removed instead. */
  indexNote(noteId: string, executor: SearchExecutor = this.db): void {
    if (!this.available) return;

    const note = executor.select().from(notes).where(eq(notes.id, noteId)).get();
    if (note === undefined || note.trashedAt !== null) {
      this.removeEntity('note', noteId, executor);
      return;
    }

    this.write(executor, 'note', noteId, note.itemId, {
      title: note.title ?? '',
      creators: '',
      container: '',
      identifiers: note.publicId,
      tags: '',
      body: note.contentMarkdown,
      text: '',
    });
  }

  /**
   * Store the extracted text of a document (§9).
   *
   * The text is not a column on `documents` — a large text column on a hot table hurts every query
   * that touches the row — so the index is where it lives, and `documents.text_char_count` is the
   * queryable summary of it.
   */
  indexDocumentText(documentId: string, text: string, executor: SearchExecutor = this.db): void {
    if (!this.available) return;
    this.write(executor, 'document', documentId, null, {
      title: '',
      creators: '',
      container: '',
      identifiers: '',
      tags: '',
      body: '',
      text,
    });
  }

  /** Drop an entity from the index. Safe to call for something that was never indexed. */
  removeEntity(
    entityType: SearchEntityType,
    entityId: string,
    executor: SearchExecutor = this.db,
  ): void {
    if (!this.available) return;
    const existing = executor.get<{ id: number }>(
      sql`select id from search_entries where entity_type = ${entityType} and entity_id = ${entityId}`,
    );
    if (existing === undefined) return;
    executor.run(sql`delete from search_index where rowid = ${existing.id}`);
    executor.run(sql`delete from search_entries where id = ${existing.id}`);
  }

  /**
   * Rebuild the whole index from the tables.
   *
   * The index is derived data, so this is always safe and is the repair for any drift. It is also
   * what a deployment runs after the search migration lands on a library that already has content.
   */
  rebuild(): { items: number; notes: number } {
    if (!this.available) {
      throw new ConflictError(
        'No full-text index on this database. FTS5 is a SQLite feature (ADR-0011); a Postgres ' +
          'deployment builds its index from its own migration series.',
      );
    }

    return this.db.transaction((tx) => {
      tx.run(sql`delete from search_index`);
      tx.run(sql`delete from search_entries`);

      const liveItems = tx.select({ id: items.id }).from(items).where(isNull(items.trashedAt)).all();
      for (const row of liveItems) this.indexItem(row.id, tx);

      const liveNotes = tx.select({ id: notes.id }).from(notes).where(isNull(notes.trashedAt)).all();
      for (const row of liveNotes) this.indexNote(row.id, tx);

      return { items: liveItems.length, notes: liveNotes.length };
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Reading the index                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  /** Run a query. The syntax is Recueil's, documented in `search-query.ts`. */
  search(query: string, options: SearchOptions = {}): SearchResult {
    if (!this.available) {
      throw new ConflictError(
        'No full-text index on this database. FTS5 is a SQLite feature (ADR-0011); a Postgres ' +
          'deployment builds its index from its own migration series.',
      );
    }

    const expression = compileSearchQuery(query);
    if (expression === null) return { hits: [], expression: '' };

    const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);
    const weights = BM25_WEIGHTS.join(', ');

    const rows = this.db.all<{
      entity_type: SearchEntityType;
      entity_id: string;
      item_id: string | null;
      score: number;
      snippet: string | null;
    }>(sql`
      select e.entity_type as entity_type,
             e.entity_id   as entity_id,
             e.item_id     as item_id,
             bm25(search_index, ${sql.raw(weights)}) as score,
             snippet(search_index, -1, '«', '»', '…', 24) as snippet
        from search_index
        join search_entries e on e.id = search_index.rowid
       where search_index match ${expression}
         ${options.entityType === undefined ? sql`` : sql`and e.entity_type = ${options.entityType}`}
       order by score
       limit ${limit} offset ${offset}
    `);

    return {
      expression,
      hits: rows.map((row) => ({
        entityType: row.entity_type,
        entityId: row.entity_id,
        itemId: row.item_id,
        score: row.score,
        snippet: row.snippet,
      })),
    };
  }

  /**
   * The live item ids a query matches, best first.
   *
   * This is the projection `LibraryService.listItems({ text })` needs: a hit on a note or on a
   * document's extracted text is resolved to the item it belongs to, deduplicated, and handed back
   * as a plain id list that a SQL predicate can be built from.
   */
  itemIdsMatching(query: string, limit = MAX_SEARCH_LIMIT): string[] {
    const { hits } = this.search(query, { limit });

    const ordered: string[] = [];
    const seen = new Set<string>();
    const documentHits: string[] = [];

    for (const hit of hits) {
      if (hit.entityType === 'item') {
        if (!seen.has(hit.entityId)) {
          seen.add(hit.entityId);
          ordered.push(hit.entityId);
        }
        continue;
      }
      if (hit.itemId !== null) {
        if (!seen.has(hit.itemId)) {
          seen.add(hit.itemId);
          ordered.push(hit.itemId);
        }
        continue;
      }
      if (hit.entityType === 'document') documentHits.push(hit.entityId);
    }

    // A document belongs to no item of its own; it is reachable from every item that attaches it.
    if (documentHits.length > 0) {
      const reachable = this.db
        .select({ itemId: attachments.itemId })
        .from(attachments)
        .where(and(inArray(attachments.documentId, documentHits), isNull(attachments.trashedAt)))
        .all();
      for (const row of reachable) {
        if (seen.has(row.itemId)) continue;
        seen.add(row.itemId);
        ordered.push(row.itemId);
      }
    }

    return ordered;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Internals                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Replace the indexed document for one entity.
   *
   * Delete-then-insert rather than an FTS5 `UPDATE`, because the two objects have to stay in step:
   * `search_entries` owns the rowid, and reusing it keeps a re-index from churning the index's
   * internal b-tree with a fresh rowid every time an item is touched.
   */
  private write(
    executor: SearchExecutor,
    entityType: SearchEntityType,
    entityId: string,
    itemId: string | null,
    fields: {
      title: string;
      creators: string;
      container: string;
      identifiers: string;
      tags: string;
      body: string;
      text: string;
    },
  ): void {
    const now = nowTimestamp();
    const existing = executor.get<{ id: number }>(
      sql`select id from search_entries where entity_type = ${entityType} and entity_id = ${entityId}`,
    );

    let rowid: number;
    if (existing === undefined) {
      const inserted = executor.get<{ id: number }>(sql`
        insert into search_entries (entity_type, entity_id, item_id, indexed_at)
        values (${entityType}, ${entityId}, ${itemId}, ${now})
        returning id
      `);
      if (inserted === undefined) {
        throw new ConflictError('The search index refused an entry.', { entityType, entityId });
      }
      rowid = inserted.id;
    } else {
      rowid = existing.id;
      executor.run(
        sql`update search_entries set item_id = ${itemId}, indexed_at = ${now} where id = ${rowid}`,
      );
      executor.run(sql`delete from search_index where rowid = ${rowid}`);
    }

    executor.run(sql`
      insert into search_index (rowid, title, creators, container, identifiers, tags, body, text)
      values (${rowid}, ${fields.title}, ${fields.creators}, ${fields.container},
              ${fields.identifiers}, ${fields.tags}, ${fields.body}, ${fields.text})
    `);
  }
}

/** Join the parts of one indexed field, dropping the absent ones. */
const join = (parts: readonly (string | null | undefined)[]): string =>
  parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(' \n');

/** The `form` of each entry in `creators.name_variants`, defensively. */
const nameVariantForms = (json: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        typeof entry === 'object' && entry !== null && typeof (entry as { form?: unknown }).form === 'string'
          ? ((entry as { form: string }).form)
          : null,
      )
      .filter((form): form is string => form !== null);
  } catch {
    return [];
  }
};
