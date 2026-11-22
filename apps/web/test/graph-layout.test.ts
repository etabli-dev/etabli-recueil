import { describe, expect, it } from 'vitest';

import { layout } from '../src/graph/layout.js';

describe('graph layout', () => {
  it('is deterministic and keeps every node inside the frame', () => {
    const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `n${index}` }));
    const edges = nodes.slice(1).map((node) => ({ source: 'n0', target: node.id }));
    const first = layout(nodes, edges, { width: 400, height: 300 });
    const second = layout(nodes, edges, { width: 400, height: 300 });
    expect([...first.entries()]).toEqual([...second.entries()]);
    for (const point of first.values()) {
      expect(point.x).toBeGreaterThanOrEqual(10);
      expect(point.x).toBeLessThanOrEqual(390);
      expect(point.y).toBeGreaterThanOrEqual(10);
      expect(point.y).toBeLessThanOrEqual(290);
    }
  });

  it('pulls linked nodes closer than unlinked ones', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const positions = layout(nodes, [{ source: 'a', target: 'b' }], { width: 500, height: 500 });
    const distance = (x: string, y: string) => Math.hypot(positions.get(x)!.x - positions.get(y)!.x, positions.get(x)!.y - positions.get(y)!.y);
    expect(distance('a', 'b')).toBeLessThan(distance('c', 'd'));
  });
});
