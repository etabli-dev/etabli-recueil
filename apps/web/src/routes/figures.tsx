/**
 * Figures: curated networks (CONCEPT §5.9, ADR-0013).
 *
 * Pick a figure, drag its nodes where they belong (they are pinned where you drop them), and save:
 * every save is a new version. Freeze the version a paper uses — it then keeps the metadata it
 * showed, whatever happens to the library later. Export a draft SVG, TikZ, or GraphML with the
 * positions for ggraph, which is the route to camera-ready artwork.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { useApiClient } from '../api/context.js';
import type { CuratedNetworkWire } from '../api/client.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { layout } from '../graph/layout.js';

const WIDTH = 1000;
const HEIGHT = 680;

export const FiguresRoute = (): JSX.Element => {
  const client = useApiClient();
  const [list, setList] = useState<{ id: string; name: string }[] | null>(null);
  const [current, setCurrent] = useState<CuratedNetworkWire | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number; pinned?: boolean }>>({});
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dragging = useRef<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    client.listCuratedNetworks().then((page) => setList(page.data), setError);
  }, [client]);

  const open = (id: string): void => {
    setError(null);
    client.getCuratedNetwork(id).then((network) => {
      setCurrent(network);
      // Unplaced nodes get the force layout once; from then on positions are the figure's own.
      const placed = network.document.layout.positions;
      const missing = network.document.nodes.filter((node) => placed[node.id] === undefined && node.kind !== 'group');
      const auto = missing.length === 0 ? new Map() : layout(network.document.nodes.filter((n) => n.kind !== 'group'), network.document.edges, { width: WIDTH, height: HEIGHT });
      const next = { ...placed };
      for (const node of missing) {
        const point = auto.get(node.id);
        if (point !== undefined) next[node.id] = { x: Math.round(point.x), y: Math.round(point.y) };
      }
      setPositions(next);
      setDirty(missing.length > 0);
    }, setError);
  };

  const labelOf = (node: CuratedNetworkWire['document']['nodes'][number]): string => {
    if (current === null) return node.id;
    if (node.kind !== 'item') return node.label ?? node.id;
    const item = current.items[node.itemId ?? ''];
    if (item === undefined) return `missing ${node.itemId}`;
    return node.label ?? ([item.firstAuthor, item.year].filter((p) => p !== null).join(' ') || item.title || node.itemId || node.id);
  };

  const toSvgPoint = (event: React.PointerEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (svg === null) return null;
    const box = svg.getBoundingClientRect();
    return { x: Math.round(((event.clientX - box.left) / box.width) * WIDTH), y: Math.round(((event.clientY - box.top) / box.height) * HEIGHT) };
  };

  const save = async (): Promise<void> => {
    if (current === null) return;
    try {
      const document = { ...current.document, layout: { ...current.document.layout, algorithm: 'manual', positions } };
      const saved = await client.saveCuratedNetwork(current.id, document, current.version, 'arranged in the web app');
      setCurrent(saved);
      setDirty(false);
    } catch (cause) {
      setError(cause);
    }
  };

  const nodes = useMemo(() => (current === null ? [] : current.document.nodes.filter((node) => node.kind !== 'group')), [current]);

  return (
    <div className="graph">
      <header className="graph__toolbar">
        <h2 className="section__title">Figures</h2>
        <select className="field__input" aria-label="Figure" value={current?.id ?? ''} onChange={(event) => open(event.target.value)}>
          <option value="">Choose a figure…</option>
          {(list ?? []).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        {current === null ? null : (
          <>
            <span className="section__note">
              Version {current.version}
              {current.isFrozen ? ' (frozen)' : ''}
            </span>
            <button type="button" className="button button--small" disabled={!dirty} onClick={() => void save()}>
              Save version
            </button>
            <button
              type="button"
              className="button button--small"
              disabled={dirty || current.isFrozen}
              onClick={() => void client.freezeCuratedNetwork(current.id).then(setCurrent, setError)}
            >
              Freeze
            </button>
            <a className="button button--small" href={client.curatedExportUrl(current.id, 'svg', current.version)} download>
              SVG (draft)
            </a>
            <a className="button button--small" href={client.curatedExportUrl(current.id, 'tikz', current.version)} download>
              TikZ
            </a>
            <a className="button button--small" href={client.curatedExportUrl(current.id, 'graphml', current.version)} download>
              GraphML for ggraph
            </a>
          </>
        )}
      </header>
      {error === null ? null : <ErrorState label="Figures" error={error} />}
      {list === null ? <LoadingState label="Loading figures…" /> : null}
      {list !== null && list.length === 0 ? <p className="section__note">No figures yet: open the citation map and choose “Save as figure”.</p> : null}
      {current === null ? null : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="graph__svg"
          role="img"
          aria-label={`${current.name}: ${nodes.length} nodes`}
          onPointerMove={(event) => {
            if (dragging.current === null) return;
            const point = toSvgPoint(event);
            if (point === null) return;
            setPositions((previous) => ({ ...previous, [dragging.current!]: { ...point, pinned: true } }));
            setDirty(true);
          }}
          onPointerUp={() => {
            dragging.current = null;
          }}
        >
          <g className="graph__edges">
            {current.document.edges.map((edge) => {
              const a = positions[edge.source];
              const b = positions[edge.target];
              if (a === undefined || b === undefined) return null;
              return <line key={edge.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeDasharray={edge.kind === 'manual' ? '4 2' : undefined} />;
            })}
          </g>
          <g className="graph__nodes">
            {nodes.map((node) => {
              const point = positions[node.id];
              if (point === undefined) return null;
              return (
                <g key={node.id}>
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r={7}
                    className={`graph__node${node.kind === 'item' ? ' graph__node--library' : ''}`}
                    onPointerDown={(event) => {
                      if (current.isFrozen) return;
                      (event.target as Element).setPointerCapture?.(event.pointerId);
                      dragging.current = node.id;
                    }}
                  />
                  <text x={point.x + 10} y={point.y + 4} className="graph__label">
                    {labelOf(node)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
};
