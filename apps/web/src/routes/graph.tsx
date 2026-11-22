/**
 * The citation map (CONCEPT §5.8, Phase 5 exit: "local citation network of the own library
 * rendered in-app").
 *
 * Library items are filled circles, cited works outside the library are hollow; a node's size is
 * its citation count. The coverage statistics — how many items have reference data, from which
 * sources, fetched when — sit beside the map, because a map without them misleads (P4).
 */
import { useEffect, useMemo, useState } from 'react';

import { useApiClient } from '../api/context.js';
import type { GraphCoverage, GraphNetwork } from '../api/client.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { layout } from '../graph/layout.js';

const NETWORKS = [
  { value: 'local', label: 'Library items citing each other' },
  { value: 'citations', label: 'Everything the library cites' },
  { value: 'co-citation', label: 'Co-citation' },
  { value: 'coupling', label: 'Bibliographic coupling' },
] as const;
type NetworkName = (typeof NETWORKS)[number]['value'];

const WIDTH = 1000;
const HEIGHT = 680;

export const GraphRoute = (): JSX.Element => {
  const client = useApiClient();
  const [name, setName] = useState<NetworkName>('local');
  const [network, setNetwork] = useState<GraphNetwork | null>(null);
  const [coverage, setCoverage] = useState<GraphCoverage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setNetwork(null);
    setError(null);
    setSelected(null);
    Promise.all([client.getNetwork(name, controller.signal), client.getGraphCoverage(controller.signal)]).then(
      ([net, cov]) => {
        setNetwork(net);
        setCoverage(cov);
      },
      (cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause);
      },
    );
    return () => controller.abort();
  }, [client, name]);

  const positions = useMemo(() => (network === null ? new Map() : layout(network.nodes, network.edges, { width: WIDTH, height: HEIGHT })), [network]);
  const maxCited = useMemo(() => Math.max(1, ...(network?.nodes ?? []).map((node) => node.citedBy ?? 0)), [network]);
  const detail = network?.nodes.find((node) => node.id === selected) ?? null;

  return (
    <div className="graph">
      <header className="graph__toolbar">
        <h2 className="section__title">Citation map</h2>
        <label className="field__label" htmlFor="graph-network">
          Network
        </label>
        <select id="graph-network" className="field__input" value={name} onChange={(event) => setName(event.target.value as NetworkName)}>
          {NETWORKS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button--small"
          disabled={network === null || network.nodes.length === 0}
          onClick={() => {
            if (network === null) return;
            const nameForFigure = globalThis.prompt?.('Name of the figure', `${NETWORKS.find((n) => n.value === name)?.label ?? name}`);
            if (!nameForFigure) return;
            // The figure starts where the map is now: these positions become its layout. The
            // server builds the nodes from the same graph, so the node ids match.
            const positionsNow = Object.fromEntries([...positions].map(([id, point]) => [id, { x: Math.round(point.x), y: Math.round(point.y) }]));
            void client.createCuratedNetwork({ name: nameForFigure, fromGraph: name }).then(
              (created) => client.saveCuratedNetwork(created.id, { ...created.document, layout: { algorithm: 'force', positions: positionsNow } }, created.version, 'positions from the citation map'),
              setError,
            );
          }}
        >
          Save as figure
        </button>
        <a className="button button--small" href={client.url('/graph/network', { network: name, format: 'vosviewer' })} download={`${name}.vosviewer.json`}>
          VOSviewer
        </a>
        <a className="button button--small" href={client.url('/graph/network', { network: name, format: 'gexf' })} download={`${name}.gexf`}>
          Gephi
        </a>
      </header>
      <div className="graph__body">
        <div className="graph__canvas">
          {error !== null ? <ErrorState label="Could not load the network" error={error} /> : null}
          {network === null && error === null ? <LoadingState label="Building the map…" /> : null}
          {network !== null && network.nodes.length === 0 ? (
            <p className="section__note">No citations yet. Run <code>recueil graph collect</code> to fetch reference lists.</p>
          ) : null}
          {network !== null && network.nodes.length > 0 ? (
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="graph__svg" role="img" aria-label={`${network.description}: ${network.nodes.length} works, ${network.edges.length} links`}>
              <g className="graph__edges">
                {network.edges.map((edge, index) => {
                  const a = positions.get(edge.source);
                  const b = positions.get(edge.target);
                  if (a === undefined || b === undefined) return null;
                  return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={Math.min(4, 0.5 + edge.weight)} />;
                })}
              </g>
              <g className="graph__nodes">
                {network.nodes.map((node) => {
                  const point = positions.get(node.id);
                  if (point === undefined) return null;
                  const r = 4 + 10 * Math.sqrt((node.citedBy ?? 0) / maxCited);
                  return (
                    <circle
                      key={node.id}
                      cx={point.x}
                      cy={point.y}
                      r={r}
                      className={`graph__node${node.inLibrary ? ' graph__node--library' : ''}${selected === node.id ? ' graph__node--selected' : ''}`}
                      onClick={() => setSelected(node.id)}
                    >
                      <title>{`${node.label}${node.year === null ? '' : ` (${node.year})`}`}</title>
                    </circle>
                  );
                })}
              </g>
            </svg>
          ) : null}
        </div>
        <aside className="graph__side">
          {coverage === null ? null : (
            <section aria-label="Coverage">
              <h3 className="section__title">Coverage</h3>
              <p>
                {coverage.withReferences} of {coverage.items} items have reference data.
              </p>
              <ul>
                {coverage.bySource.map((source) => (
                  <li key={source.source}>
                    {source.source}: {source.items} items, {source.edges} citations
                    {source.lastFetchedAt === null ? '' : `, fetched ${source.lastFetchedAt.slice(0, 10)}`}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail === null ? null : (
            <section aria-label="Selected work">
              <h3 className="section__title">{detail.label}</h3>
              <p>
                {[detail.year, detail.venue].filter((part) => part !== null).join(' · ')}
                {detail.inLibrary ? ' · in the library' : ' · not in the library'}
              </p>
              {detail.doi === null ? null : (
                <a href={`https://doi.org/${detail.doi}`} target="_blank" rel="noreferrer">
                  doi:{detail.doi}
                </a>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
};
