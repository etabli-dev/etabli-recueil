/**
 * A small force-directed layout (Fruchterman–Reingold with cooling), deterministic for a given
 * input: positions start on a circle in node order and every step is pure arithmetic, so the same
 * network always draws the same map — which a figure in a paper needs.
 *
 * Quadratic in the number of nodes, which is fine for a personal library's citation network (a
 * few thousand nodes). Larger maps are the case for a WebGL renderer (CONCEPT §5.8, Sigma.js).
 */
export interface LayoutNode {
  id: string;
}
export interface LayoutEdge {
  source: string;
  target: string;
  weight?: number;
}
export interface Point {
  x: number;
  y: number;
}

export const layout = (
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: { width?: number; height?: number; iterations?: number } = {},
): Map<string, Point> => {
  const width = options.width ?? 1000;
  const height = options.height ?? 700;
  const iterations = options.iterations ?? (nodes.length > 1500 ? 60 : 200);
  const n = nodes.length;
  const positions = new Map<string, Point>();
  if (n === 0) return positions;
  const radius = Math.min(width, height) * 0.4;
  nodes.forEach((node, index) => {
    const angle = (2 * Math.PI * index) / n;
    positions.set(node.id, { x: width / 2 + radius * Math.cos(angle), y: height / 2 + radius * Math.sin(angle) });
  });
  if (n === 1) return positions;
  const k = Math.sqrt((width * height) / n);
  const ids = nodes.map((node) => node.id);
  const links = edges.filter((edge) => positions.has(edge.source) && positions.has(edge.target) && edge.source !== edge.target);
  let temperature = width / 10;
  for (let step = 0; step < iterations; step += 1) {
    const shift = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < n; i += 1) {
      const a = positions.get(ids[i]!)!;
      for (let j = i + 1; j < n; j += 1) {
        const b = positions.get(ids[j]!)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = 0.01 * (i - j);
          dy = 0.01;
          distance = Math.hypot(dx, dy);
        }
        const force = (k * k) / distance;
        const sa = shift.get(ids[i]!)!;
        const sb = shift.get(ids[j]!)!;
        sa.x += (dx / distance) * force;
        sa.y += (dy / distance) * force;
        sb.x -= (dx / distance) * force;
        sb.y -= (dy / distance) * force;
      }
    }
    for (const edge of links) {
      const a = positions.get(edge.source)!;
      const b = positions.get(edge.target)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const force = ((distance * distance) / k) * Math.min(3, edge.weight ?? 1);
      const sa = shift.get(edge.source)!;
      const sb = shift.get(edge.target)!;
      sa.x -= (dx / distance) * force;
      sa.y -= (dy / distance) * force;
      sb.x += (dx / distance) * force;
      sb.y += (dy / distance) * force;
    }
    for (const id of ids) {
      const point = positions.get(id)!;
      const delta = shift.get(id)!;
      const length = Math.max(0.01, Math.hypot(delta.x, delta.y));
      point.x = Math.min(width - 10, Math.max(10, point.x + (delta.x / length) * Math.min(length, temperature)));
      point.y = Math.min(height - 10, Math.max(10, point.y + (delta.y / length) * Math.min(length, temperature)));
    }
    temperature *= 0.97;
  }
  return positions;
};
