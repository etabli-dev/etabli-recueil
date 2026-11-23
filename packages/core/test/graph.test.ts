import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let lib: TestLibrary;
beforeEach(() => {
  lib = makeLibrary();
});
afterEach(() => {
  lib.dispose();
});

const item = (title: string, doi: string) =>
  lib.library.createItem({ itemType: 'article', title, bibliographic: { title, doi } }, lib.actor).item.id;

describe('GraphService', () => {
  it('records citations per source, matches library items, and builds the local network', () => {
    const a = item('A', '10.1000/a');
    const b = item('B', '10.1000/b');
    lib.graph.addCitation(a, { source: 'openalex', sourceId: 'W2', doi: '10.1000/B' }, { source: 'openalex' });
    lib.graph.addCitation(a, { source: 'crossref', sourceId: '10.1000/b', doi: '10.1000/b' }, { source: 'crossref' });
    lib.graph.addCitation(a, { source: 'openalex', sourceId: 'W9', doi: '10.1000/external', title: 'Outside' }, { source: 'openalex' });
    // The same citation from the same source again is not a second edge.
    expect(lib.graph.addCitation(a, { source: 'openalex', sourceId: 'W2', doi: '10.1000/b' }, { source: 'openalex' })).toBeNull();

    const local = lib.graph.citationNetwork({ localOnly: true });
    expect(local.edges).toHaveLength(1);
    expect(local.nodes.map((node) => node.itemId).sort()).toEqual([a, b].sort());
    expect(lib.graph.citationNetwork().edges).toHaveLength(2);

    const coverage = lib.graph.coverage();
    expect(coverage.withReferences).toBe(1);
    expect(coverage.bySource.map((s) => [s.source, s.edges]).sort()).toEqual([
      ['crossref', 1],
      ['openalex', 2],
    ]);
    expect(lib.graph.topShadowWorks().map((s) => s.title)).toEqual(['Outside']);
  });

  it('turns a shadow work into the item when the item arrives later', () => {
    const a = item('A', '10.1000/a');
    lib.graph.addCitation(a, { source: 'openalex', sourceId: 'W5', doi: '10.1000/later' }, { source: 'openalex' });
    expect(lib.graph.citationNetwork({ localOnly: true }).edges).toHaveLength(0);
    const later = item('Later', '10.1000/later');
    expect(lib.graph.rematch()).toBe(1);
    const local = lib.graph.citationNetwork({ localOnly: true });
    expect(local.edges).toHaveLength(1);
    expect(local.nodes.map((node) => node.itemId)).toContain(later);
  });

  it('promotes a shadow work and keeps its edges', () => {
    const a = item('A', '10.1000/a');
    lib.graph.addCitation(a, { source: 'openalex', sourceId: 'W7', doi: '10.1000/promote', title: 'Worth reading' }, { source: 'openalex' });
    const [shadow] = lib.graph.topShadowWorks();
    const promoted = lib.graph.promoteShadowWork(shadow!.id, lib.actor);
    expect(lib.library.getItem(promoted).item.title).toBe('Worth reading');
    expect(lib.graph.citationNetwork({ localOnly: true }).edges).toHaveLength(1);
  });

  it('derives co-citation and coupling, replacing the previous run', () => {
    const a = item('A', '10.1000/a');
    const b = item('B', '10.1000/b');
    for (const citing of [a, b]) {
      lib.graph.addCitation(citing, { source: 'openalex', sourceId: 'X', doi: '10.1000/x' }, { source: 'openalex' });
      lib.graph.addCitation(citing, { source: 'openalex', sourceId: 'Y', doi: '10.1000/y' }, { source: 'openalex' });
    }
    const coupled = lib.graph.derive('coupled', { normalisation: 'salton' });
    expect(coupled.edges).toBe(1);
    const [edge] = lib.graph.derivedNetwork('coupled').edges;
    expect(edge?.weight).toBe(2);
    expect(edge?.normalisedWeight).toBe(1);
    expect(edge!.sourceNodeId < edge!.targetNodeId).toBe(true);

    const cocited = lib.graph.derive('co_cited');
    expect(cocited.edges).toBe(1);
    lib.graph.derive('co_cited');
    const all = lib.connection.prepare(`select count(*) as n from graph_edges where edge_type = 'co_cited'`).get() as { n: number };
    expect(all.n).toBe(1);
  });
});
