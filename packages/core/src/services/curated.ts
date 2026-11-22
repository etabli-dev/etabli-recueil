/**
 * Curated networks: the figure for a publication, as a versioned document (CONCEPT §5.9,
 * `spec/data-model.md` §7, ADR-0013).
 *
 * - The document is JSON — nodes that reference items (so corrections to the library propagate),
 *   free nodes and groups, manual or inherited edges, the layout, the style and the annotations.
 * - Every save is a new version; the head moves. A frozen version is never written again (CN1).
 * - Freezing embeds the item metadata the figure shows, so a published figure can be rebuilt
 *   exactly years later; live versions read the library at render time (CN3).
 * - A node whose item has gone is shown as dangling, never dropped (CN2).
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { curatedNetworkVersions, curatedNetworks, itemBibliographic, items } from '../db/schema.js';
import type { CuratedNetworkRow, CuratedNetworkVersionRow } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError, VersionConflictError } from '../errors.js';
import { newId, newPublicId } from '../ids.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { CreatorService } from './creators.js';
import type { Network } from './graph.js';

export interface CuratedNode {
  id: string;
  kind: 'item' | 'free' | 'group';
  itemId?: string;
  label?: string;
  groupId?: string;
}

export interface CuratedEdge {
  id: string;
  source: string;
  target: string;
  kind: 'manual' | 'inherited';
  edgeType?: string;
  weight?: number;
  provenance?: string;
}

export interface CuratedDocument {
  schema: 'recueil.curated-network/1';
  nodes: CuratedNode[];
  edges: CuratedEdge[];
  layout: {
    algorithm: string;
    parameters?: Record<string, unknown>;
    positions: Record<string, { x: number; y: number; pinned?: boolean }>;
    timeline?: { field: 'year' } | null;
  };
  style: {
    colourBy?: 'kind' | 'year' | 'venue' | 'group' | null;
    sizeBy?: 'citedBy' | 'degree' | null;
    overrides?: Record<string, { colour?: string; shape?: string; size?: number }>;
  };
  annotations: { id: string; kind: 'label' | 'callout' | 'hull' | 'legend' | 'text'; text?: string; x?: number; y?: number; nodeIds?: string[] }[];
}

export interface ItemSnapshotForFigure {
  itemId: string;
  title: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  firstAuthor: string | null;
  state: 'live' | 'trashed' | 'missing';
}

export interface ResolvedNetwork {
  network: CuratedNetworkRow;
  version: CuratedNetworkVersionRow;
  document: CuratedDocument;
  items: Record<string, ItemSnapshotForFigure>;
}

export const emptyDocument = (): CuratedDocument => ({
  schema: 'recueil.curated-network/1',
  nodes: [],
  edges: [],
  layout: { algorithm: 'force', positions: {} },
  style: { colourBy: 'kind', sizeBy: 'degree' },
  annotations: [],
});

/** Structural checks: ids unique, edges and groups point at nodes that exist, numbers finite. */
export const validateDocument = (value: unknown): CuratedDocument => {
  const doc = value as CuratedDocument;
  if (doc === null || typeof doc !== 'object' || doc.schema !== 'recueil.curated-network/1') {
    throw new ValidationError('A curated network document has `schema: "recueil.curated-network/1"`.');
  }
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges) || !Array.isArray(doc.annotations)) {
    throw new ValidationError('A curated network document has `nodes`, `edges` and `annotations` lists.');
  }
  if (doc.nodes.length > 20_000 || doc.edges.length > 100_000) throw new ValidationError('A curated network is at most 20 000 nodes and 100 000 edges.');
  const ids = new Set<string>();
  for (const node of doc.nodes) {
    if (typeof node.id !== 'string' || node.id === '' || ids.has(node.id)) throw new ValidationError(`Node ids must be unique strings (\`${String(node.id)}\`).`);
    ids.add(node.id);
    if (!['item', 'free', 'group'].includes(node.kind)) throw new ValidationError(`Node \`${node.id}\` has an unknown kind.`);
    if (node.kind === 'item' && typeof node.itemId !== 'string') throw new ValidationError(`Item node \`${node.id}\` names no item.`);
  }
  for (const node of doc.nodes) {
    if (node.groupId !== undefined && !doc.nodes.some((other) => other.id === node.groupId && other.kind === 'group')) {
      throw new ValidationError(`Node \`${node.id}\` is in a group that does not exist.`);
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of doc.edges) {
    if (edgeIds.has(edge.id)) throw new ValidationError(`Edge ids must be unique (\`${edge.id}\`).`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new ValidationError(`Edge \`${edge.id}\` joins a node that does not exist.`);
  }
  if (doc.layout === null || typeof doc.layout !== 'object' || typeof doc.layout.positions !== 'object') {
    throw new ValidationError('A curated network document has `layout.positions`.');
  }
  for (const [id, point] of Object.entries(doc.layout.positions)) {
    if (!ids.has(id)) throw new ValidationError(`A position is given for \`${id}\`, which is not a node.`);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new ValidationError(`The position of \`${id}\` is not a number.`);
  }
  return doc;
};

export class CuratedNetworkService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly creators: CreatorService,
    private readonly ownerUserId: string,
  ) {}

  /** A document from a graph network: library items as item nodes, cited works as free nodes. */
  documentFromGraph(network: Network): CuratedDocument {
    const doc = emptyDocument();
    for (const node of network.nodes) {
      doc.nodes.push(node.itemId !== null ? { id: node.id, kind: 'item', itemId: node.itemId } : { id: node.id, kind: 'free', label: node.label });
    }
    network.edges.forEach((edge, index) => {
      doc.edges.push({
        id: `e${index}`,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        kind: 'inherited',
        edgeType: edge.edgeType,
        weight: edge.normalisedWeight ?? edge.weight,
        provenance: edge.provenanceSource,
      });
    });
    return doc;
  }

  create(input: { name: string; description?: string | null; document?: CuratedDocument }, actor: Actor): ResolvedNetwork {
    const name = input.name.trim();
    if (name === '') throw new ValidationError('A curated network needs a name.');
    const document = validateDocument(input.document ?? emptyDocument());
    return this.db.transaction(() => {
      const now = nowTimestamp();
      const network: CuratedNetworkRow = {
        id: newId(),
        publicId: newPublicId(),
        name,
        description: input.description ?? null,
        ownerUserId: actor.userId ?? this.ownerUserId,
        reviewId: null,
        currentVersionId: null,
        createdAt: now,
        updatedAt: now,
        trashedAt: null,
      };
      this.db.insert(curatedNetworks).values(network).run();
      this.insertVersion(network.id, 1, null, document, 'created', actor);
      return this.resolve(network.id);
    });
  }

  private insertVersion(networkId: string, version: number, parent: string | null, document: CuratedDocument, message: string | null, actor: Actor): CuratedNetworkVersionRow {
    const row: CuratedNetworkVersionRow = {
      id: newId(),
      networkId,
      version,
      parentVersionId: parent,
      document: JSON.stringify(document),
      isFrozen: false,
      frozenAt: null,
      frozenSnapshot: null,
      message,
      createdByUserId: actor.userId ?? null,
      createdAt: nowTimestamp(),
    };
    this.db.insert(curatedNetworkVersions).values(row).run();
    this.db.update(curatedNetworks).set({ currentVersionId: row.id, updatedAt: row.createdAt }).where(eq(curatedNetworks.id, networkId)).run();
    return row;
  }

  get(networkId: string): CuratedNetworkRow {
    const row = this.db.select().from(curatedNetworks).where(eq(curatedNetworks.id, networkId)).get();
    if (row === undefined || row.trashedAt !== null) throw new NotFoundError('curated_network', networkId);
    return row;
  }

  list(): CuratedNetworkRow[] {
    return this.db.select().from(curatedNetworks).where(isNull(curatedNetworks.trashedAt)).orderBy(desc(curatedNetworks.updatedAt)).all();
  }

  versions(networkId: string): CuratedNetworkVersionRow[] {
    this.get(networkId);
    return this.db.select().from(curatedNetworkVersions).where(eq(curatedNetworkVersions.networkId, networkId)).orderBy(desc(curatedNetworkVersions.version)).all();
  }

  private version(networkId: string, version?: number): CuratedNetworkVersionRow {
    const network = this.get(networkId);
    const row =
      version === undefined
        ? this.db.select().from(curatedNetworkVersions).where(eq(curatedNetworkVersions.id, network.currentVersionId ?? '')).get()
        : this.db
            .select()
            .from(curatedNetworkVersions)
            .where(and(eq(curatedNetworkVersions.networkId, networkId), eq(curatedNetworkVersions.version, version)))
            .get();
    if (row === undefined) throw new NotFoundError('curated_network_version', `${networkId}@${version ?? 'head'}`);
    return row;
  }

  /** Save a new version on top of the head. `expectedVersion` guards against a concurrent edit (P1). */
  save(networkId: string, document: CuratedDocument, actor: Actor, options: { message?: string; expectedVersion?: number } = {}): ResolvedNetwork {
    validateDocument(document);
    return this.db.transaction(() => {
      const head = this.version(networkId);
      if (options.expectedVersion !== undefined && options.expectedVersion !== head.version) {
        throw new VersionConflictError('curated_network', networkId, options.expectedVersion, head.version);
      }
      this.insertVersion(networkId, head.version + 1, head.id, document, options.message ?? null, actor);
      return this.resolve(networkId);
    });
  }

  private snapshotItems(itemIds: readonly string[]): Record<string, ItemSnapshotForFigure> {
    const out: Record<string, ItemSnapshotForFigure> = {};
    const unique = [...new Set(itemIds)];
    if (unique.length === 0) return out;
    const rows = new Map(this.db.select().from(items).where(inArray(items.id, unique)).all().map((row) => [row.id, row]));
    const bibs = new Map(this.db.select().from(itemBibliographic).where(inArray(itemBibliographic.itemId, unique)).all().map((row) => [row.itemId, row]));
    for (const itemId of unique) {
      const item = rows.get(itemId);
      const bib = bibs.get(itemId);
      const first = item === undefined ? undefined : this.creators.forItem(itemId)[0]?.creator;
      out[itemId] = {
        itemId,
        title: bib?.title ?? item?.title ?? null,
        year: bib?.issuedYear ?? null,
        venue: bib?.containerTitle ?? null,
        doi: bib?.doi ?? null,
        firstAuthor: first?.familyName ?? first?.literalName ?? null,
        state: item === undefined ? 'missing' : item.trashedAt !== null ? 'trashed' : 'live',
      };
    }
    return out;
  }

  /** Freeze a version (the head by default): its document and the metadata it shows are fixed. */
  freeze(networkId: string, actor: Actor, version?: number): ResolvedNetwork {
    return this.db.transaction(() => {
      const row = this.version(networkId, version);
      if (row.isFrozen) return this.resolve(networkId, row.version);
      const document = JSON.parse(row.document) as CuratedDocument;
      const snapshot = this.snapshotItems(document.nodes.filter((n) => n.kind === 'item').map((n) => n.itemId!));
      this.db
        .update(curatedNetworkVersions)
        .set({ isFrozen: true, frozenAt: nowTimestamp(), frozenSnapshot: JSON.stringify(snapshot) })
        .where(eq(curatedNetworkVersions.id, row.id))
        .run();
      void actor;
      return this.resolve(networkId, row.version);
    });
  }

  /** The document with its item metadata: live for a live version, the snapshot for a frozen one. */
  resolve(networkId: string, version?: number): ResolvedNetwork {
    const network = this.get(networkId);
    const row = this.version(networkId, version);
    const document = JSON.parse(row.document) as CuratedDocument;
    const items_ = row.isFrozen
      ? (JSON.parse(row.frozenSnapshot ?? '{}') as Record<string, ItemSnapshotForFigure>)
      : this.snapshotItems(document.nodes.filter((n) => n.kind === 'item').map((n) => n.itemId!));
    return { network, version: row, document, items: items_ };
  }

  rename(networkId: string, name: string): CuratedNetworkRow {
    if (name.trim() === '') throw new ValidationError('A curated network needs a name.');
    this.get(networkId);
    this.db.update(curatedNetworks).set({ name: name.trim(), updatedAt: nowTimestamp() }).where(eq(curatedNetworks.id, networkId)).run();
    return this.get(networkId);
  }

  trash(networkId: string): void {
    const row = this.get(networkId);
    if (row.trashedAt !== null) throw new ConflictError('Already in the trash.', { networkId });
    this.db.update(curatedNetworks).set({ trashedAt: nowTimestamp() }).where(eq(curatedNetworks.id, networkId)).run();
  }
}
