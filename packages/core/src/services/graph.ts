/**
 * The bibliometric graph (CONCEPT §5.8, `spec/data-model.md` §5.5–5.8).
 *
 * - **Shadow works** are the works the library cites but has not chosen. They are stored once, by
 *   DOI or by `(source, source_id)`, counted every time they turn up, and matched to a library item
 *   whenever one carries the same DOI or PMID (SW3) — that match is what makes the *local* citation
 *   network, which library items cite which.
 * - **Nodes** are one per entity (GN1). A cited work that is in the library is the item's node; one
 *   that is not is its shadow work's node; promotion rewrites the node in place, so no edge moves.
 * - **Asserted edges** (`cites`) are kept per source (GE3): OpenAlex and Crossref saying the same
 *   thing are two rows, which is what the coverage statistics beside a map count.
 * - **Derived edges** (`co_cited`, `coupled`) belong to a run and are replaced wholesale by the next
 *   run with the same parameters (GE2). Undirected edges are stored in canonical order (GE1).
 */
import { createHash } from 'node:crypto';

import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { edgeEvidence, graphEdges, graphNodes, itemBibliographic, items, shadowWorks } from '../db/schema.js';
import type { GraphEdgeRow, GraphNodeRow, ShadowWorkRow } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../ids.js';
import { normalise } from '../normalise.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { LibraryService } from './library.js';

export interface WorkStubInput {
  source: string;
  sourceId: string;
  doi?: string | null;
  pmid?: string | null;
  arxivId?: string | null;
  openalexId?: string | null;
  title?: string | null;
  containerTitle?: string | null;
  issuedYear?: number | null;
  authors?: { family?: string; given?: string; orcid?: string }[];
  raw?: unknown;
  rawReference?: string | null;
  citedByCount?: number | null;
}

export interface EdgeProvenance {
  source: string;
  fetchedAt?: string;
  confidence?: number | null;
}

export interface Network {
  nodes: GraphNodeRow[];
  edges: GraphEdgeRow[];
}

export interface Coverage {
  items: number;
  withReferences: number;
  bySource: { source: string; items: number; edges: number; lastFetchedAt: string | null }[];
}

const titleKey = (title: string | null | undefined): string | null => {
  if (title === null || title === undefined) return null;
  const key = normalise(title)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return key === '' ? null : key;
};

const lowerDoi = (doi: string | null | undefined): string | null => {
  if (doi === null || doi === undefined) return null;
  const value = doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//u, '').replace(/^doi:\s*/u, '');
  return /^10\.\d{4,9}\/\S+$/u.test(value) ? value : null;
};

export class GraphService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly library: LibraryService,
  ) {}

  /* Nodes ---------------------------------------------------------------------------------------- */

  itemNode(itemId: string): GraphNodeRow {
    const existing = this.db.select().from(graphNodes).where(eq(graphNodes.itemId, itemId)).get();
    if (existing !== undefined) return existing;
    const item = this.db.select({ title: items.title }).from(items).where(eq(items.id, itemId)).get();
    if (item === undefined) throw new NotFoundError('item', itemId);
    const now = nowTimestamp();
    const row: GraphNodeRow = {
      id: newId(),
      nodeType: 'item',
      itemId,
      shadowWorkId: null,
      creatorId: null,
      termId: null,
      externalScheme: null,
      externalId: null,
      label: item.title ?? itemId,
      externalIds: '{}',
      firstSeenAt: now,
      updatedAt: now,
    };
    this.db.insert(graphNodes).values(row).run();
    return row;
  }

  private shadowNode(shadow: ShadowWorkRow): GraphNodeRow {
    if (shadow.matchedItemId !== null) return this.itemNode(shadow.matchedItemId);
    if (shadow.promotedItemId !== null) return this.itemNode(shadow.promotedItemId);
    const existing = this.db.select().from(graphNodes).where(eq(graphNodes.shadowWorkId, shadow.id)).get();
    if (existing !== undefined) return existing;
    const now = nowTimestamp();
    const row: GraphNodeRow = {
      id: newId(),
      nodeType: 'shadow_work',
      itemId: null,
      shadowWorkId: shadow.id,
      creatorId: null,
      termId: null,
      externalScheme: null,
      externalId: null,
      label: shadow.title ?? shadow.doi ?? shadow.sourceId,
      externalIds: JSON.stringify({ ...(shadow.doi ? { doi: shadow.doi } : {}), ...(shadow.openalexId ? { openalex: shadow.openalexId } : {}) }),
      firstSeenAt: now,
      updatedAt: now,
    };
    this.db.insert(graphNodes).values(row).run();
    return row;
  }

  /* Shadow works ------------------------------------------------------------------------------------ */

  /** The live library item carrying this DOI or PMID, if any (SW3). */
  private matchItem(doi: string | null, pmid: string | null): string | null {
    if (doi === null && pmid === null) return null;
    const conditions = [];
    if (doi !== null) conditions.push(eq(itemBibliographic.doi, doi));
    if (pmid !== null) conditions.push(eq(itemBibliographic.pmid, pmid));
    const row = this.db
      .select({ itemId: itemBibliographic.itemId })
      .from(itemBibliographic)
      .where(and(or(...conditions), isNull(itemBibliographic.itemTrashedAt)))
      .get();
    return row?.itemId ?? null;
  }

  upsertShadowWork(
    stub: WorkStubInput,
    via: ShadowWorkRow['discoveredVia'],
    options: { fromItemId?: string | null } = {},
  ): ShadowWorkRow {
    const doi = lowerDoi(stub.doi);
    const now = nowTimestamp();
    const existing =
      (doi === null ? undefined : this.db.select().from(shadowWorks).where(eq(shadowWorks.doi, doi)).get()) ??
      this.db
        .select()
        .from(shadowWorks)
        .where(and(eq(shadowWorks.source, stub.source), eq(shadowWorks.sourceId, stub.sourceId)))
        .get();
    const matched = this.matchItem(doi, stub.pmid ?? null);
    if (existing !== undefined) {
      const patch: Partial<ShadowWorkRow> = {
        lastSeenAt: now,
        seenCount: existing.seenCount + 1,
        matchedItemId: matched ?? existing.matchedItemId,
      };
      // Fill what the first sighting lacked; never overwrite.
      if (existing.doi === null && doi !== null) patch.doi = doi;
      if (existing.title === null && stub.title) {
        patch.title = stub.title;
        patch.normalisedTitle = titleKey(stub.title);
      }
      if (existing.issuedYear === null && stub.issuedYear != null) patch.issuedYear = stub.issuedYear;
      if (existing.containerTitle === null && stub.containerTitle) patch.containerTitle = stub.containerTitle;
      if (stub.citedByCount != null) patch.citedByCount = stub.citedByCount;
      this.db.update(shadowWorks).set(patch).where(eq(shadowWorks.id, existing.id)).run();
      return { ...existing, ...patch };
    }
    const row: ShadowWorkRow = {
      id: newId(),
      source: stub.source,
      sourceId: stub.sourceId,
      doi,
      pmid: stub.pmid ?? null,
      arxivId: stub.arxivId ?? null,
      openalexId: stub.openalexId ?? null,
      title: stub.title ?? null,
      normalisedTitle: titleKey(stub.title),
      containerTitle: stub.containerTitle ?? null,
      issuedYear: stub.issuedYear ?? null,
      firstAuthorFamily: stub.authors?.[0]?.family ?? null,
      authors: JSON.stringify((stub.authors ?? []).map((author, position) => ({ ...author, position }))),
      rawRecord: stub.raw === undefined ? null : JSON.stringify(stub.raw),
      rawReferenceString: stub.rawReference ?? null,
      citedByCount: stub.citedByCount ?? null,
      discoveredVia: via,
      discoveredFromItemId: options.fromItemId ?? null,
      discoveredInJobId: null,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
      promotionStatus: 'none',
      promotedItemId: null,
      promotedAt: null,
      matchedItemId: matched,
    };
    this.db.insert(shadowWorks).values(row).run();
    return row;
  }

  /** Re-run the matcher over every unmatched shadow work, after imports have added items. */
  rematch(): number {
    let matched = 0;
    for (const shadow of this.db.select().from(shadowWorks).where(isNull(shadowWorks.matchedItemId)).all()) {
      const itemId = this.matchItem(shadow.doi, shadow.pmid);
      if (itemId === null) continue;
      this.db.transaction((tx) => {
        tx.update(shadowWorks).set({ matchedItemId: itemId }).where(eq(shadowWorks.id, shadow.id)).run();
        this.mergeShadowNodeInto(shadow.id, itemId);
      });
      matched += 1;
    }
    return matched;
  }

  /** A shadow work became (or was found to be) an item: its node becomes the item's (GN1). */
  private mergeShadowNodeInto(shadowWorkId: string, itemId: string): void {
    const shadowNode = this.db.select().from(graphNodes).where(eq(graphNodes.shadowWorkId, shadowWorkId)).get();
    if (shadowNode === undefined) return;
    const itemNode = this.db.select().from(graphNodes).where(eq(graphNodes.itemId, itemId)).get();
    if (itemNode === undefined) {
      this.db
        .update(graphNodes)
        .set({ nodeType: 'item', itemId, shadowWorkId: null, updatedAt: nowTimestamp() })
        .where(eq(graphNodes.id, shadowNode.id))
        .run();
      return;
    }
    // Both exist: move the shadow node's asserted edges onto the item node, dropping duplicates.
    for (const edge of this.db
      .select()
      .from(graphEdges)
      .where(and(or(eq(graphEdges.sourceNodeId, shadowNode.id), eq(graphEdges.targetNodeId, shadowNode.id)), eq(graphEdges.derivation, 'asserted')))
      .all()) {
      const source = edge.sourceNodeId === shadowNode.id ? itemNode.id : edge.sourceNodeId;
      const target = edge.targetNodeId === shadowNode.id ? itemNode.id : edge.targetNodeId;
      if (source !== target) {
        this.insertEdge({ ...edge, sourceNodeId: source, targetNodeId: target });
      }
    }
    this.db.delete(graphNodes).where(eq(graphNodes.id, shadowNode.id)).run();
  }

  promoteShadowWork(shadowWorkId: string, actor: Actor): string {
    const shadow = this.db.select().from(shadowWorks).where(eq(shadowWorks.id, shadowWorkId)).get();
    if (shadow === undefined) throw new NotFoundError('shadow_work', shadowWorkId);
    if (shadow.promotedItemId !== null) return shadow.promotedItemId;
    if (shadow.matchedItemId !== null) throw new ValidationError(`This work is already in the library as item '${shadow.matchedItemId}'.`);
    return this.db.transaction(() => {
      const record = this.library.createItem(
        {
          itemType: 'article',
          title: shadow.title,
          bibliographic: {
            ...(shadow.title ? { title: shadow.title } : {}),
            ...(shadow.doi ? { doi: shadow.doi } : {}),
            ...(shadow.pmid ? { pmid: shadow.pmid } : {}),
            ...(shadow.arxivId ? { arxivId: shadow.arxivId } : {}),
            ...(shadow.openalexId ? { openalexId: shadow.openalexId } : {}),
            ...(shadow.containerTitle ? { containerTitle: shadow.containerTitle } : {}),
            ...(shadow.issuedYear != null ? { issuedYear: shadow.issuedYear } : {}),
          },
          provenance: { source: shadow.source, lock: false },
        },
        actor,
      );
      const itemId = record.item.id;
      this.db
        .update(shadowWorks)
        .set({ promotionStatus: 'promoted', promotedItemId: itemId, promotedAt: nowTimestamp() })
        .where(eq(shadowWorks.id, shadowWorkId))
        .run();
      this.mergeShadowNodeInto(shadowWorkId, itemId);
      return itemId;
    });
  }

  /* Asserted edges ----------------------------------------------------------------------------------- */

  private insertEdge(edge: Omit<GraphEdgeRow, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): GraphEdgeRow | null {
    let { sourceNodeId, targetNodeId } = edge;
    if (sourceNodeId === targetNodeId) return null;
    if (!edge.directed && sourceNodeId > targetNodeId) [sourceNodeId, targetNodeId] = [targetNodeId, sourceNodeId]; // GE1
    const row: GraphEdgeRow = { ...edge, id: newId(), sourceNodeId, targetNodeId, createdAt: nowTimestamp() };
    const inserted = this.db.insert(graphEdges).values(row).onConflictDoNothing().run();
    return inserted.changes > 0 ? row : null;
  }

  /** `citingItemId` cites the work `cited`, according to `provenance.source`. */
  addCitation(citingItemId: string, cited: WorkStubInput, provenance: EdgeProvenance, options: { referenceString?: string } = {}): GraphEdgeRow | null {
    return this.db.transaction(() => {
      const shadow = this.upsertShadowWork(cited, 'reference_list', { fromItemId: citingItemId });
      const source = this.itemNode(citingItemId);
      const target = this.shadowNode(shadow);
      const edge = this.insertEdge({
        edgeType: 'cites',
        sourceNodeId: source.id,
        targetNodeId: target.id,
        directed: true,
        weight: 1,
        normalisedWeight: null,
        normalisation: null,
        occurrences: null,
        scheme: null,
        schemeKey: '',
        provenanceSource: provenance.source,
        provenanceFetchedAt: provenance.fetchedAt ?? nowTimestamp(),
        confidence: provenance.confidence ?? null,
        derivation: 'asserted',
        runId: null,
        runKey: '',
        paramsDigest: null,
      });
      if (edge !== null && options.referenceString !== undefined) {
        this.db
          .insert(edgeEvidence)
          .values({
            id: newId(),
            edgeId: edge.id,
            kind: 'reference_string',
            documentId: null,
            pageIndex: null,
            charStart: null,
            charEnd: null,
            section: null,
            textExcerpt: options.referenceString,
            intent: null,
            intentConfidence: null,
            model: null,
            extractedAt: nowTimestamp(),
          })
          .run();
      }
      return edge;
    });
  }

  /* Reading the graph --------------------------------------------------------------------------------- */

  private nodesFor(ids: Iterable<string>): GraphNodeRow[] {
    const list = [...new Set(ids)];
    const out: GraphNodeRow[] = [];
    for (let index = 0; index < list.length; index += 500) {
      out.push(...this.db.select().from(graphNodes).where(inArray(graphNodes.id, list.slice(index, index + 500))).all());
    }
    return out;
  }

  /** Every `cites` edge, optionally only between library items (the local citation network). */
  citationNetwork(options: { localOnly?: boolean; itemIds?: readonly string[] } = {}): Network {
    let edges = this.db.select().from(graphEdges).where(eq(graphEdges.edgeType, 'cites')).all();
    let nodes = this.nodesFor(edges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]));
    if (options.localOnly === true) {
      const itemNodes = new Set(nodes.filter((node) => node.nodeType === 'item').map((node) => node.id));
      edges = edges.filter((edge) => itemNodes.has(edge.sourceNodeId) && itemNodes.has(edge.targetNodeId));
    }
    if (options.itemIds !== undefined) {
      const wanted = new Set(nodes.filter((node) => node.itemId !== null && options.itemIds!.includes(node.itemId)).map((node) => node.id));
      edges = edges.filter((edge) => wanted.has(edge.sourceNodeId) || wanted.has(edge.targetNodeId));
    }
    // One row per citation, whichever sources reported it, for a map; sources stay in the edges table.
    const seen = new Set<string>();
    edges = edges.filter((edge) => {
      const key = `${edge.sourceNodeId}>${edge.targetNodeId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const used = new Set(edges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]));
    nodes = nodes.filter((node) => used.has(node.id));
    return { nodes, edges };
  }

  coverage(): Coverage {
    const live = this.db.select({ id: items.id }).from(items).where(and(isNull(items.trashedAt), ne(items.libraryState, 'merged'))).all();
    const itemNodes = new Map(
      this.db
        .select({ id: graphNodes.id, itemId: graphNodes.itemId })
        .from(graphNodes)
        .where(eq(graphNodes.nodeType, 'item'))
        .all()
        .map((row) => [row.id, row.itemId]),
    );
    const rows = this.db
      .select({ source: graphEdges.provenanceSource, sourceNodeId: graphEdges.sourceNodeId, fetchedAt: graphEdges.provenanceFetchedAt })
      .from(graphEdges)
      .where(and(eq(graphEdges.edgeType, 'cites'), eq(graphEdges.derivation, 'asserted')))
      .all();
    const bySource = new Map<string, { items: Set<string>; edges: number; last: string | null }>();
    const withRefs = new Set<string>();
    for (const row of rows) {
      const itemId = itemNodes.get(row.sourceNodeId);
      if (itemId === undefined || itemId === null) continue;
      withRefs.add(itemId);
      const entry = bySource.get(row.source) ?? { items: new Set(), edges: 0, last: null };
      entry.items.add(itemId);
      entry.edges += 1;
      if (entry.last === null || row.fetchedAt > entry.last) entry.last = row.fetchedAt;
      bySource.set(row.source, entry);
    }
    return {
      items: live.length,
      withReferences: withRefs.size,
      bySource: [...bySource].map(([source, entry]) => ({ source, items: entry.items.size, edges: entry.edges, lastFetchedAt: entry.last })),
    };
  }

  /* Derived networks (GE2) ---------------------------------------------------------------------------- */

  /**
   * Co-citation (two works cited together by the same item) or bibliographic coupling (two items
   * citing the same work), counted, then normalised. `association_strength` is VOSviewer's default:
   * `w(i,j) / (c(i) · c(j))`; `salton` is the cosine: `w(i,j) / √(c(i) · c(j))`.
   */
  derive(
    kind: 'co_cited' | 'coupled',
    params: { minWeight?: number; normalisation?: 'none' | 'association_strength' | 'salton' } = {},
  ): { runId: string; edges: number } {
    const minWeight = params.minWeight ?? 1;
    const normalisation = params.normalisation ?? 'association_strength';
    const digest = createHash('sha256').update(JSON.stringify({ kind, minWeight, normalisation })).digest('hex').slice(0, 16);
    const cites = this.db
      .select({ s: graphEdges.sourceNodeId, t: graphEdges.targetNodeId })
      .from(graphEdges)
      .where(and(eq(graphEdges.edgeType, 'cites'), eq(graphEdges.derivation, 'asserted')))
      .all();
    // Group by the shared end: for co-citation, by the citing item; for coupling, by the cited work.
    const groups = new Map<string, Set<string>>();
    for (const { s, t } of cites) {
      const [key, member] = kind === 'co_cited' ? [s, t] : [t, s];
      const set = groups.get(key) ?? new Set<string>();
      set.add(member);
      groups.set(key, set);
    }
    const counts = new Map<string, number>();
    const totals = new Map<string, number>();
    for (const members of groups.values()) {
      const list = [...members].sort();
      for (const node of list) totals.set(node, (totals.get(node) ?? 0) + 1);
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const key = `${list[i]}\u0000${list[j]}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    const runId = newId();
    const now = nowTimestamp();
    let written = 0;
    this.db.transaction(() => {
      for (const [key, weight] of counts) {
        if (weight < minWeight) continue;
        const [a, b] = key.split('\u0000') as [string, string];
        const ca = totals.get(a) ?? 1;
        const cb = totals.get(b) ?? 1;
        const normalised = normalisation === 'none' ? weight : normalisation === 'salton' ? weight / Math.sqrt(ca * cb) : weight / (ca * cb);
        const inserted = this.insertEdge({
          edgeType: kind,
          sourceNodeId: a,
          targetNodeId: b,
          directed: false,
          weight,
          normalisedWeight: Number(normalised.toFixed(6)),
          normalisation,
          occurrences: weight,
          scheme: null,
          schemeKey: '',
          provenanceSource: 'derived',
          provenanceFetchedAt: now,
          confidence: null,
          derivation: 'derived',
          runId,
          runKey: runId,
          paramsDigest: digest,
        });
        if (inserted !== null) written += 1;
      }
      // GE2: the previous run with the same parameters is replaced once this one is in.
      this.db
        .delete(graphEdges)
        .where(and(eq(graphEdges.edgeType, kind), eq(graphEdges.paramsDigest, digest), ne(graphEdges.runKey, runId)))
        .run();
    });
    return { runId, edges: written };
  }

  derivedNetwork(kind: 'co_cited' | 'coupled', runId?: string): Network {
    const latest =
      runId ??
      this.db
        .select({ runId: graphEdges.runId })
        .from(graphEdges)
        .where(eq(graphEdges.edgeType, kind))
        .orderBy(sql`${graphEdges.createdAt} desc`)
        .get()?.runId;
    if (latest === undefined || latest === null) return { nodes: [], edges: [] };
    const edges = this.db.select().from(graphEdges).where(and(eq(graphEdges.edgeType, kind), eq(graphEdges.runId, latest))).all();
    return { nodes: this.nodesFor(edges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId])), edges };
  }

  shadowWork(id: string): ShadowWorkRow {
    const row = this.db.select().from(shadowWorks).where(eq(shadowWorks.id, id)).get();
    if (row === undefined) throw new NotFoundError('shadow_work', id);
    return row;
  }

  /** What to read next: the most-cited works not in the library. */
  topShadowWorks(limit = 50): ShadowWorkRow[] {
    return this.db
      .select()
      .from(shadowWorks)
      .where(and(isNull(shadowWorks.matchedItemId), eq(shadowWorks.promotionStatus, 'none')))
      .orderBy(sql`${shadowWorks.seenCount} desc`, sql`${shadowWorks.citedByCount} desc nulls last`)
      .limit(limit)
      .all();
  }
}
