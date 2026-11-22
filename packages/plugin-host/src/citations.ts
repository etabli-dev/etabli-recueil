/**
 * Edge acquisition (CONCEPT §5.8): reference lists from the resolvers into the graph.
 *
 * For each item with a DOI (or PMID, or OpenAlex id), every enabled resolver that declares
 * `references` is asked for the item's reference list, page by page up to a per-item budget, and
 * each reference becomes a `cites` edge from that source (GE3). The graph matches the cited works
 * to library items by DOI and PMID, which is what makes the local citation network.
 *
 * The run is resumable in the only way that matters: an edge already recorded for a source is not
 * recorded twice (`ux_graph_edges_identity`), so a repeated run adds only what is new.
 */
import type { Recueil, WorkStubInput } from '@recueil/core';
import { canonicalDoi } from '@recueil/plugin-sdk';
import type { Identifier, Page, Resolver, WorkStub } from '@recueil/plugin-sdk';

import type { PluginHost, RegisteredHook } from './host.js';

export interface CollectOptions {
  itemIds?: readonly string[];
  sources?: readonly string[];
  /** References read per item per source. Default 500. */
  maxPerItem?: number;
}

export interface CollectResult {
  items: number;
  withReferences: number;
  edges: number;
  bySource: Record<string, { items: number; edges: number; errors: number }>;
  errors: { itemId: string; source: string; message: string }[];
}

const stubToInput = (stub: WorkStub, source: string): WorkStubInput => {
  const id = (scheme: string) => stub.identifiers.find((identifier) => identifier.scheme === scheme)?.value;
  const doi = id('doi');
  const openalex = id('openalex');
  const raw = (stub.raw ?? null) as { cited_by_count?: number | null; unstructured?: string | null } | null;
  // A stable identity for a reference with no identifier: its text.
  const sourceId = openalex ?? doi ?? id('pmid') ?? `text:${(stub.title ?? raw?.unstructured ?? JSON.stringify(stub)).slice(0, 200).toLowerCase()}`;
  return {
    source,
    sourceId,
    ...(doi === undefined ? {} : { doi }),
    ...(id('pmid') === undefined ? {} : { pmid: id('pmid')! }),
    ...(id('arxiv') === undefined ? {} : { arxivId: id('arxiv')! }),
    ...(openalex === undefined ? {} : { openalexId: openalex }),
    ...(stub.title === undefined ? {} : { title: stub.title }),
    ...(stub.containerTitle === undefined ? {} : { containerTitle: stub.containerTitle }),
    ...(stub.issuedYear === undefined ? {} : { issuedYear: stub.issuedYear }),
    authors: (stub.authors ?? []).map((author) => ({
      ...(author.family === undefined ? {} : { family: author.family }),
      ...(author.given === undefined ? {} : { given: author.given }),
      ...(author.orcid === undefined ? {} : { orcid: author.orcid }),
    })),
    ...(raw?.cited_by_count == null ? {} : { citedByCount: raw.cited_by_count }),
    ...(raw?.unstructured == null ? {} : { rawReference: raw.unstructured }),
    raw: stub.raw ?? null,
  };
};

export class CitationEngine {
  constructor(
    private readonly recueil: Recueil,
    private readonly host: PluginHost,
  ) {}

  private identifiersOf(itemId: string): Identifier[] {
    const bib = this.recueil.library.getItem(itemId).bibliographic;
    const out: Identifier[] = [];
    const doi = canonicalDoi(bib?.doi ?? '');
    if (doi !== null) out.push({ scheme: 'doi', value: doi });
    if (bib?.pmid) out.push({ scheme: 'pmid', value: bib.pmid });
    if (bib?.openalexId) out.push({ scheme: 'openalex', value: bib.openalexId });
    return out;
  }

  async collect(options: CollectOptions = {}): Promise<CollectResult> {
    const resolvers = this.host
      .resolvers()
      .filter((hook) => hook.impl.supports.references && hook.impl.references !== undefined)
      .filter((hook) => options.sources === undefined || options.sources.includes(hook.impl.source));
    const itemIds =
      options.itemIds ??
      this.recueil.library
        .listItems({ limit: 10_000 })
        .data.map((row) => row.id);
    const result: CollectResult = { items: itemIds.length, withReferences: 0, edges: 0, bySource: {}, errors: [] };
    const max = options.maxPerItem ?? 500;

    for (const itemId of itemIds) {
      const identifiers = this.identifiersOf(itemId);
      if (identifiers.length === 0) continue;
      let any = false;
      for (const hook of resolvers) {
        const source = hook.impl.source;
        const stats = (result.bySource[source] ??= { items: 0, edges: 0, errors: 0 });
        const identifier = identifiers.find((id) => id.scheme === 'doi') ?? identifiers[0]!;
        let cursor: string | undefined;
        let read = 0;
        let added = 0;
        try {
          do {
            const page = await this.host.call<Page<WorkStub>>(
              hook as RegisteredHook<Resolver> as RegisteredHook<object>,
              'references',
              [{ identifier, limit: Math.min(50, max - read), ...(cursor === undefined ? {} : { cursor }) }],
              { defaultTimeoutMs: 60_000, ceilingTimeoutMs: 300_000 },
            );
            for (const stub of page.records) {
              const raw = (stub.raw ?? null) as { unstructured?: string | null } | null;
              const edge = this.recueil.graph.addCitation(itemId, stubToInput(stub, source), { source, confidence: 0.9 }, raw?.unstructured ? { referenceString: raw.unstructured } : {});
              if (edge !== null) added += 1;
            }
            read += page.records.length;
            cursor = page.cursor;
          } while (cursor !== undefined && read < max);
        } catch (error) {
          stats.errors += 1;
          result.errors.push({ itemId, source, message: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (read > 0) {
          any = true;
          stats.items += 1;
        }
        stats.edges += added;
        result.edges += added;
      }
      if (any) result.withReferences += 1;
    }
    this.recueil.graph.rematch();
    return result;
  }
}
