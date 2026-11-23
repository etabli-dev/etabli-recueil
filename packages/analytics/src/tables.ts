/**
 * The analytics tables (CONCEPT §5.8, ADR-0008): works, creators, works_creators, terms,
 * works_terms, edges and metrics, flat and stable, for R, Python and DuckDB.
 *
 * ADR-0008 names Parquet as the bundle format. This first cut serves each table as CSV (RFC 4180,
 * UTF-8) — readable everywhere without a native dependency — with the column layout the Parquet
 * bundle will keep, so switching the encoding later changes no consumer.
 */
import type { Recueil } from '@recueil/core';
import { schema } from '@recueil/core';
import { and, isNull, ne } from 'drizzle-orm';

export type AnalyticsTable = 'works' | 'creators' | 'works_creators' | 'terms' | 'works_terms' | 'edges' | 'metrics';

type Row = Record<string, string | number | boolean | null>;

export const analyticsTables = (recueil: Recueil, table: AnalyticsTable): Row[] => {
  const db = recueil.db;
  const live = db
    .select({ id: schema.items.id, publicId: schema.items.publicId, itemType: schema.items.itemType, title: schema.items.title, dateAdded: schema.items.dateAdded })
    .from(schema.items)
    .where(and(isNull(schema.items.trashedAt), ne(schema.items.libraryState, 'merged')))
    .all();
  const liveIds = new Set(live.map((row) => row.id));
  switch (table) {
    case 'works': {
      const bibs = new Map(db.select().from(schema.itemBibliographic).all().map((row) => [row.itemId, row]));
      return live.map((item) => {
        const bib = bibs.get(item.id);
        return {
          work_id: item.id,
          public_id: item.publicId,
          item_type: item.itemType,
          title: bib?.title ?? item.title,
          container_title: bib?.containerTitle ?? null,
          issued_year: bib?.issuedYear ?? null,
          doi: bib?.doi ?? null,
          pmid: bib?.pmid ?? null,
          openalex_id: bib?.openalexId ?? null,
          citation_key: bib?.citationKey ?? null,
          retraction_status: bib?.retractionStatus ?? null,
          date_added: item.dateAdded,
        };
      });
    }
    case 'creators':
      return db.select().from(schema.creators).where(isNull(schema.creators.trashedAt)).all().map((row) => ({
        creator_id: row.id,
        kind: row.kind,
        family_name: row.familyName,
        given_name: row.givenName,
        literal_name: row.literalName,
        display_name: row.displayName,
        orcid: row.orcid,
      }));
    case 'works_creators':
      return db
        .select()
        .from(schema.itemCreators)
        .all()
        .filter((row) => liveIds.has(row.itemId))
        .map((row) => ({ work_id: row.itemId, creator_id: row.creatorId, role: row.role, position: row.ordinal, raw_name: row.rawName }));
    case 'terms':
      return db.select().from(schema.terms).all().map((row) => ({ term_id: row.id, scheme: row.scheme, code: row.code, label: row.label, parent_id: row.parentId, preferred_term_id: row.preferredTermId }));
    case 'works_terms': {
      const fromTerms = db
        .select()
        .from(schema.itemTerms)
        .all()
        .filter((row) => liveIds.has(row.itemId))
        .map((row) => ({ work_id: row.itemId, term_id: row.termId, source: row.source, weight: row.weight, is_major_topic: row.isMajorTopic }));
      // Tags are the vocabulary most libraries actually have; they appear as the `tag` scheme.
      const tags = new Map(db.select().from(schema.tags).all().map((row) => [row.id, row]));
      const fromTags = db
        .select()
        .from(schema.itemTags)
        .all()
        .filter((row) => liveIds.has(row.itemId) && tags.get(row.tagId)?.trashedAt === null)
        .map((row) => ({ work_id: row.itemId, term_id: `tag:${tags.get(row.tagId)!.name}`, source: 'tag', weight: null, is_major_topic: false }));
      return [...fromTerms, ...fromTags];
    }
    case 'edges': {
      const nodes = new Map(db.select().from(schema.graphNodes).all().map((row) => [row.id, row]));
      return db
        .select()
        .from(schema.graphEdges)
        .all()
        .map((edge) => {
          const source = nodes.get(edge.sourceNodeId);
          const target = nodes.get(edge.targetNodeId);
          return {
            edge_type: edge.edgeType,
            source_work_id: source?.itemId ?? null,
            source_shadow_id: source?.shadowWorkId ?? null,
            target_work_id: target?.itemId ?? null,
            target_shadow_id: target?.shadowWorkId ?? null,
            directed: edge.directed,
            weight: edge.weight,
            normalised_weight: edge.normalisedWeight,
            provenance: edge.provenanceSource,
            fetched_at: edge.provenanceFetchedAt,
          };
        });
    }
    case 'metrics':
      return db
        .select()
        .from(schema.itemMetrics)
        .all()
        .filter((row) => liveIds.has(row.itemId))
        .map((row) => ({ work_id: row.itemId, metric: row.metric, value: row.metricValue, source: row.source, observed_at: row.observedAt }));
  }
};

const cell = (value: Row[string]): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
};

/** RFC 4180 CSV with a header row; the empty table still has its header. */
export const toCsv = (rows: readonly Row[], columns?: readonly string[]): string => {
  const header = columns ?? (rows[0] === undefined ? [] : Object.keys(rows[0]));
  return `${[header.join(','), ...rows.map((row) => header.map((column) => cell(row[column] ?? null)).join(','))].join('\r\n')}\r\n`;
};
