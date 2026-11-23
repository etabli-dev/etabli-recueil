/**
 * Curated networks out (CONCEPT §5.9, ADR-0013): SVG (draft quality, labelled as such), TikZ for
 * LaTeX, and GraphML/GEXF/JSON with the layout positions — the route to camera-ready artwork is
 * tidygraph and ggraph, through the R client.
 */
import type { ResolvedNetwork } from '@recueil/core';

import type { ExportNetwork } from './network.js';

interface Placed {
  id: string;
  label: string;
  kind: string;
  x: number;
  y: number;
  dangling: boolean;
}

const labelOf = (resolved: ResolvedNetwork, node: ResolvedNetwork['document']['nodes'][number]): { label: string; dangling: boolean } => {
  if (node.kind !== 'item') return { label: node.label ?? node.id, dangling: false };
  const item = resolved.items[node.itemId!];
  if (item === undefined || item.state === 'missing') return { label: node.label ?? `missing item ${node.itemId}`, dangling: true };
  const parts = [item.firstAuthor, item.year].filter((part) => part !== null);
  const label = node.label ?? (parts.length > 0 ? parts.join(' ') : (item.title ?? node.itemId!));
  return { label: item.state === 'trashed' ? `${label} (trashed)` : label, dangling: item.state !== 'live' };
};

/** Positions from the document, or a circle for nodes that have none. */
export const placeNodes = (resolved: ResolvedNetwork, width = 800, height = 600): Placed[] => {
  const nodes = resolved.document.nodes.filter((node) => node.kind !== 'group');
  const positions = resolved.document.layout.positions;
  const unplaced = nodes.filter((node) => positions[node.id] === undefined);
  return nodes.map((node) => {
    const { label, dangling } = labelOf(resolved, node);
    const given = positions[node.id];
    if (given !== undefined) return { id: node.id, label, kind: node.kind, x: given.x, y: given.y, dangling };
    const index = unplaced.indexOf(node);
    const angle = (2 * Math.PI * index) / Math.max(1, unplaced.length);
    return { id: node.id, label, kind: node.kind, x: width / 2 + 0.4 * width * Math.cos(angle), y: height / 2 + 0.4 * height * Math.sin(angle), dangling };
  });
};

const esc = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

export const curatedToSvg = (resolved: ResolvedNetwork): string => {
  const placed = placeNodes(resolved);
  const byId = new Map(placed.map((node) => [node.id, node]));
  const xs = placed.map((n) => n.x);
  const ys = placed.map((n) => n.y);
  const minX = Math.min(0, ...xs) - 60;
  const minY = Math.min(0, ...ys) - 40;
  const width = Math.max(...xs, 0) - minX + 160;
  const height = Math.max(...ys, 0) - minY + 60;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" font-family="sans-serif" font-size="11">`,
    `  <title>${esc(resolved.network.name)} — version ${resolved.version.version}${resolved.version.isFrozen ? ' (frozen)' : ''}</title>`,
    `  <desc>Draft rendering from Recueil (ADR-0013). For publication, export to tidygraph and render with ggraph.</desc>`,
    '  <g stroke="#888" stroke-opacity="0.6">',
  ];
  for (const edge of resolved.document.edges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (a === undefined || b === undefined) continue;
    lines.push(`    <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${Math.min(4, 0.6 + (edge.weight ?? 1))}"${edge.kind === 'manual' ? ' stroke-dasharray="4 2"' : ''}/>`);
  }
  lines.push('  </g>', '  <g>');
  for (const node of placed) {
    const override = resolved.document.style.overrides?.[node.id];
    const fill = override?.colour ?? (node.kind === 'item' ? '#3c5aa0' : '#ffffff');
    lines.push(
      `    <circle cx="${node.x}" cy="${node.y}" r="${override?.size ?? 6}" fill="${esc(fill)}" stroke="#3c5aa0" stroke-width="1.5"${node.dangling ? ' stroke-dasharray="2 2"' : ''}/>`,
      `    <text x="${node.x + 9}" y="${node.y + 4}">${esc(node.label)}</text>`,
    );
  }
  lines.push('  </g>');
  for (const annotation of resolved.document.annotations) {
    if (annotation.text !== undefined && annotation.x !== undefined && annotation.y !== undefined) {
      lines.push(`  <text x="${annotation.x}" y="${annotation.y}" font-style="italic">${esc(annotation.text)}</text>`);
    }
  }
  lines.push('</svg>', '');
  return lines.join('\n');
};

const tex = (text: string): string => text.replace(/([\\{}&%$#_^~])/gu, (char) => (char === '\\' ? '\\textbackslash{}' : char === '~' ? '\\textasciitilde{}' : char === '^' ? '\\textasciicircum{}' : `\\${char}`));

/** A standalone TikZ picture; coordinates scaled to centimetres, y flipped to TikZ's upward axis. */
export const curatedToTikz = (resolved: ResolvedNetwork, scale = 0.02): string => {
  const placed = placeNodes(resolved);
  const lines = [
    `% ${resolved.network.name} — version ${resolved.version.version}${resolved.version.isFrozen ? ' (frozen)' : ''}, from Recueil`,
    '\\begin{tikzpicture}[item/.style={circle,draw=blue!60!black,fill=blue!60!black,inner sep=1.6pt},free/.style={circle,draw=blue!60!black,fill=white,inner sep=1.6pt},lbl/.style={font=\\scriptsize,anchor=west}]',
  ];
  for (const node of placed) {
    const x = (node.x * scale).toFixed(2);
    const y = (-node.y * scale).toFixed(2);
    lines.push(`  \\node[${node.kind === 'item' ? 'item' : 'free'}${node.dangling ? ',dashed' : ''}] (${node.id.replace(/[^A-Za-z0-9]/gu, '')}) at (${x},${y}) {};`);
    lines.push(`  \\node[lbl] at (${(node.x * scale + 0.15).toFixed(2)},${y}) {${tex(node.label)}};`);
  }
  for (const edge of resolved.document.edges) {
    const style = edge.kind === 'manual' ? 'dashed,gray' : 'gray';
    lines.push(`  \\draw[${style}${edge.edgeType === 'cites' ? ',->' : ''}] (${edge.source.replace(/[^A-Za-z0-9]/gu, '')}) -- (${edge.target.replace(/[^A-Za-z0-9]/gu, '')});`);
  }
  lines.push('\\end{tikzpicture}', '');
  return lines.join('\n');
};

/** The curated network as an export network, so the GraphML/GEXF/VOSviewer writers apply. */
export const curatedToNetwork = (resolved: ResolvedNetwork): ExportNetwork & { positions: Record<string, { x: number; y: number }> } => {
  const placed = placeNodes(resolved);
  return {
    nodes: placed.map((node) => {
      const nodeDef = resolved.document.nodes.find((n) => n.id === node.id)!;
      const item = nodeDef.itemId === undefined ? undefined : resolved.items[nodeDef.itemId];
      return { id: node.id, label: node.label, type: node.kind, year: item?.year ?? null, venue: item?.venue ?? null, doi: item?.doi ?? null, citedBy: null, inLibrary: node.kind === 'item' && !node.dangling };
    }),
    edges: resolved.document.edges.map((edge) => ({ source: edge.source, target: edge.target, type: edge.edgeType ?? edge.kind, directed: edge.edgeType === 'cites', weight: edge.weight ?? 1, provenance: edge.provenance ?? edge.kind })),
    generatedAt: new Date().toISOString(),
    description: `${resolved.network.name}, version ${resolved.version.version}`,
    positions: Object.fromEntries(placed.map((node) => [node.id, { x: node.x, y: node.y }])),
  };
};
