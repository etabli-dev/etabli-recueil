/**
 * Networks out: GraphML (Gephi, igraph, tidygraph), GEXF (Gephi) and VOSviewer's JSON format.
 *
 * Every export carries the provenance the map needs (P4): the edge source and, as a graph-level
 * attribute, when it was produced. Node attributes are the ones a bibliometric map colours and
 * sizes by: type, year, venue, citation count.
 */
import type { Network, Recueil } from '@recueil/core';
import { schema } from '@recueil/core';
import { eq, inArray } from 'drizzle-orm';

export interface ExportNode {
  id: string;
  label: string;
  type: string;
  year: number | null;
  venue: string | null;
  doi: string | null;
  citedBy: number | null;
  inLibrary: boolean;
}

export interface ExportEdge {
  source: string;
  target: string;
  type: string;
  directed: boolean;
  weight: number;
  provenance: string;
}

export interface ExportNetwork {
  nodes: ExportNode[];
  edges: ExportEdge[];
  generatedAt: string;
  description: string;
}

/** Decorate a graph network with the attributes maps use. */
export const describeNetwork = (recueil: Recueil, network: Network, description: string): ExportNetwork => {
  const itemIds = network.nodes.map((node) => node.itemId).filter((id): id is string => id !== null);
  const shadowIds = network.nodes.map((node) => node.shadowWorkId).filter((id): id is string => id !== null);
  const bibs = new Map(
    (itemIds.length === 0 ? [] : recueil.db.select().from(schema.itemBibliographic).where(inArray(schema.itemBibliographic.itemId, itemIds)).all()).map((row) => [
      row.itemId,
      row,
    ]),
  );
  const shadows = new Map(
    (shadowIds.length === 0 ? [] : recueil.db.select().from(schema.shadowWorks).where(inArray(schema.shadowWorks.id, shadowIds)).all()).map((row) => [row.id, row]),
  );
  const nodes: ExportNode[] = network.nodes.map((node) => {
    if (node.itemId !== null) {
      const bib = bibs.get(node.itemId);
      const cited = recueil.db.select().from(schema.itemMetrics).where(eq(schema.itemMetrics.itemId, node.itemId)).all().filter((m) => m.metric === 'cited_by_count');
      return {
        id: node.id,
        label: node.label,
        type: 'item',
        year: bib?.issuedYear ?? null,
        venue: bib?.containerTitle ?? null,
        doi: bib?.doi ?? null,
        citedBy: cited.length === 0 ? null : Math.max(...cited.map((m) => m.metricValue)),
        inLibrary: true,
      };
    }
    const shadow = node.shadowWorkId === null ? undefined : shadows.get(node.shadowWorkId);
    return {
      id: node.id,
      label: node.label,
      type: node.nodeType,
      year: shadow?.issuedYear ?? null,
      venue: shadow?.containerTitle ?? null,
      doi: shadow?.doi ?? null,
      citedBy: shadow?.citedByCount ?? null,
      inLibrary: false,
    };
  });
  const edges: ExportEdge[] = network.edges.map((edge) => ({
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    type: edge.edgeType,
    directed: edge.directed,
    weight: edge.normalisedWeight ?? edge.weight,
    provenance: edge.provenanceSource,
  }));
  return { nodes, edges, generatedAt: new Date().toISOString(), description };
};

const xml = (text: string): string =>
  text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');

export const toGraphml = (network: ExportNetwork): string => {
  const directed = network.edges.every((edge) => edge.directed);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="label" for="node" attr.name="label" attr.type="string"/>',
    '  <key id="type" for="node" attr.name="type" attr.type="string"/>',
    '  <key id="year" for="node" attr.name="year" attr.type="int"/>',
    '  <key id="venue" for="node" attr.name="venue" attr.type="string"/>',
    '  <key id="doi" for="node" attr.name="doi" attr.type="string"/>',
    '  <key id="cited_by" for="node" attr.name="cited_by" attr.type="double"/>',
    '  <key id="in_library" for="node" attr.name="in_library" attr.type="boolean"/>',
    '  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>',
    '  <key id="edge_type" for="edge" attr.name="edge_type" attr.type="string"/>',
    '  <key id="provenance" for="edge" attr.name="provenance" attr.type="string"/>',
    `  <graph id="recueil" edgedefault="${directed ? 'directed' : 'undirected'}">`,
    `    <desc>${xml(network.description)} — generated ${network.generatedAt}</desc>`,
  ];
  for (const node of network.nodes) {
    lines.push(`    <node id="${xml(node.id)}">`);
    lines.push(`      <data key="label">${xml(node.label)}</data>`, `      <data key="type">${node.type}</data>`, `      <data key="in_library">${node.inLibrary}</data>`);
    if (node.year !== null) lines.push(`      <data key="year">${node.year}</data>`);
    if (node.venue !== null) lines.push(`      <data key="venue">${xml(node.venue)}</data>`);
    if (node.doi !== null) lines.push(`      <data key="doi">${xml(node.doi)}</data>`);
    if (node.citedBy !== null) lines.push(`      <data key="cited_by">${node.citedBy}</data>`);
    lines.push('    </node>');
  }
  network.edges.forEach((edge, index) => {
    lines.push(
      `    <edge id="e${index}" source="${xml(edge.source)}" target="${xml(edge.target)}"${edge.directed === directed ? '' : ` directed="${edge.directed}"`}>`,
      `      <data key="weight">${edge.weight}</data>`,
      `      <data key="edge_type">${edge.type}</data>`,
      `      <data key="provenance">${xml(edge.provenance)}</data>`,
      '    </edge>',
    );
  });
  lines.push('  </graph>', '</graphml>', '');
  return lines.join('\n');
};

export const toGexf = (network: ExportNetwork): string => {
  const directed = network.edges.every((edge) => edge.directed);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gexf xmlns="http://gexf.net/1.3" version="1.3">',
    `  <meta lastmodifieddate="${network.generatedAt.slice(0, 10)}"><creator>Recueil</creator><description>${xml(network.description)}</description></meta>`,
    `  <graph mode="static" defaultedgetype="${directed ? 'directed' : 'undirected'}">`,
    '    <attributes class="node">',
    '      <attribute id="0" title="type" type="string"/>',
    '      <attribute id="1" title="year" type="integer"/>',
    '      <attribute id="2" title="venue" type="string"/>',
    '      <attribute id="3" title="doi" type="string"/>',
    '      <attribute id="4" title="cited_by" type="double"/>',
    '      <attribute id="5" title="in_library" type="boolean"/>',
    '    </attributes>',
    '    <attributes class="edge"><attribute id="0" title="edge_type" type="string"/><attribute id="1" title="provenance" type="string"/></attributes>',
    '    <nodes>',
  ];
  for (const node of network.nodes) {
    const values = [
      `<attvalue for="0" value="${node.type}"/>`,
      node.year === null ? '' : `<attvalue for="1" value="${node.year}"/>`,
      node.venue === null ? '' : `<attvalue for="2" value="${xml(node.venue)}"/>`,
      node.doi === null ? '' : `<attvalue for="3" value="${xml(node.doi)}"/>`,
      node.citedBy === null ? '' : `<attvalue for="4" value="${node.citedBy}"/>`,
      `<attvalue for="5" value="${node.inLibrary}"/>`,
    ].join('');
    lines.push(`      <node id="${xml(node.id)}" label="${xml(node.label)}"><attvalues>${values}</attvalues></node>`);
  }
  lines.push('    </nodes>', '    <edges>');
  network.edges.forEach((edge, index) => {
    lines.push(
      `      <edge id="${index}" source="${xml(edge.source)}" target="${xml(edge.target)}" weight="${edge.weight}"><attvalues><attvalue for="0" value="${edge.type}"/><attvalue for="1" value="${xml(edge.provenance)}"/></attvalues></edge>`,
    );
  });
  lines.push('    </edges>', '  </graph>', '</gexf>', '');
  return lines.join('\n');
};

/** VOSviewer's JSON map and network format (VOSviewer ≥ 1.6.15). */
export const toVosviewerJson = (network: ExportNetwork): string => {
  const index = new Map(network.nodes.map((node, position) => [node.id, position + 1]));
  return `${JSON.stringify(
    {
      network: {
        items: network.nodes.map((node) => ({
          id: index.get(node.id),
          label: node.label,
          ...(node.doi === null ? {} : { url: `https://doi.org/${node.doi}` }),
          weights: { Citations: node.citedBy ?? 0, Links: network.edges.filter((e) => e.source === node.id || e.target === node.id).length },
          scores: { ...(node.year === null ? {} : { 'Avg. pub. year': node.year }), 'In library': node.inLibrary ? 1 : 0 },
        })),
        links: network.edges.map((edge) => ({ source_id: index.get(edge.source), target_id: index.get(edge.target), strength: edge.weight })),
      },
      config: { terminology: { item: 'work', items: 'works', link: 'link', links: 'links' } },
    },
    null,
    2,
  )}\n`;
};
