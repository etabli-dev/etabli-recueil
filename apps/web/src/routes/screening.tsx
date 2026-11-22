/**
 * Systematic review screening (CONCEPT §5.10 item 4, `spec/systematic-review.md` §3).
 *
 * Keyboard-driven, one record at a time: `i` include, `e` exclude, `m` maybe, `1`–`9` pick an
 * exclusion reason, `u` undo the last decision, `j`/`k` move. Every decision is a new row on the
 * server, so undo restores, never erases. The PRISMA counts beside the record are the live query.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApiClient } from '../api/context.js';
import type { PrismaWire, ReviewRecordWire, ReviewWire } from '../api/client.js';
import { ErrorState, LoadingState } from '../components/states.js';

type Stage = 'title_abstract' | 'full_text';

const PRISMA_ROWS: [string, string][] = [
  ['records_identified_databases', 'Identified (databases)'],
  ['records_identified_registers', 'Identified (registers)'],
  ['records_removed_duplicates', 'Duplicates removed'],
  ['records_screened', 'Screened'],
  ['records_excluded', 'Excluded at title/abstract'],
  ['reports_sought', 'Sought for retrieval'],
  ['reports_not_retrieved', 'Not retrieved'],
  ['reports_assessed', 'Assessed at full text'],
  ['reports_excluded', 'Excluded at full text'],
  ['studies_included', 'Studies included'],
];

/** Which reasons a stage offers; exported for the test. */
export const reasonsFor = (review: ReviewWire, stage: Stage): ReviewWire['exclusionReasons'] => review.exclusionReasons.filter((reason) => reason.stage === 'any' || reason.stage === stage);

/** The key a press means, or null; exported for the test. */
export const keyAction = (key: string, reasons: number): { kind: 'include' | 'exclude' | 'maybe' | 'undo' | 'next' | 'previous' } | { kind: 'reason'; index: number } | null => {
  switch (key) {
    case 'i':
      return { kind: 'include' };
    case 'e':
      return { kind: 'exclude' };
    case 'm':
      return { kind: 'maybe' };
    case 'u':
      return { kind: 'undo' };
    case 'j':
      return { kind: 'next' };
    case 'k':
      return { kind: 'previous' };
    default: {
      const n = Number(key);
      return Number.isInteger(n) && n >= 1 && n <= Math.min(9, reasons) ? { kind: 'reason', index: n - 1 } : null;
    }
  }
};

export const ScreeningRoute = (): JSX.Element => {
  const client = useApiClient();
  const [reviews, setReviews] = useState<ReviewWire[] | null>(null);
  const [review, setReview] = useState<ReviewWire | null>(null);
  const [stage, setStage] = useState<Stage>('title_abstract');
  const [records, setRecords] = useState<ReviewRecordWire[]>([]);
  const [counts, setCounts] = useState<{ total: number; pending: number }>({ total: 0, pending: 0 });
  const [prisma, setPrisma] = useState<PrismaWire | null>(null);
  const [index, setIndex] = useState(0);
  const [excluding, setExcluding] = useState(false);
  const [history, setHistory] = useState<{ recordId: string; stage: Stage }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    client.listReviews().then((page) => {
      setReviews(page.data);
      if (page.data.length > 0) setReview(page.data[0]!);
    }, setError);
  }, [client]);

  const reload = useCallback(
    (keepIndex = false) => {
      if (review === null) return;
      Promise.all([client.reviewWorklist(review.id, stage, 'all'), client.reviewPrisma(review.id)]).then(([list, flow]) => {
        setRecords(list.data);
        setCounts({ total: list.total, pending: list.pending });
        setPrisma(flow);
        if (!keepIndex) {
          const firstPending = list.data.findIndex((record) => (stage === 'title_abstract' ? record.titleAbstract : record.fullText) === null);
          setIndex(firstPending === -1 ? 0 : firstPending);
        }
      }, setError);
    },
    [client, review, stage],
  );

  useEffect(() => reload(), [reload]);
  useEffect(() => {
    shownAt.current = Date.now();
  }, [index, records]);

  const current = records[index];
  const reasons = useMemo(() => (review === null ? [] : reasonsFor(review, stage)), [review, stage]);

  const decide = useCallback(
    (decision: 'include' | 'exclude' | 'maybe', reasonCode?: string) => {
      if (review === null || current === undefined || busy) return;
      setBusy(true);
      setError(null);
      client
        .decideReviewRecord(review.id, current.id, { stage, decision, ...(reasonCode === undefined ? {} : { reasonCode }), durationMs: Date.now() - shownAt.current })
        .then(() => {
          setHistory((past) => [...past, { recordId: current.id, stage }]);
          setExcluding(false);
          setIndex((i) => Math.min(i + 1, Math.max(0, records.length - 1)));
          reload(true);
        }, setError)
        .finally(() => setBusy(false));
    },
    [busy, client, current, records.length, reload, review, stage],
  );

  const undo = useCallback(() => {
    const last = history.at(-1);
    if (review === null || last === undefined || busy) return;
    setBusy(true);
    client
      .undoReviewDecision(review.id, last.recordId, last.stage)
      .then(() => {
        setHistory((past) => past.slice(0, -1));
        const at = records.findIndex((record) => record.id === last.recordId);
        if (at !== -1) setIndex(at);
        reload(true);
      }, setError)
      .finally(() => setBusy(false));
  }, [busy, client, history, records, reload, review]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const action = keyAction(event.key, excluding ? reasons.length : 0);
      if (action === null) return;
      event.preventDefault();
      if (action.kind === 'reason') decide('exclude', reasons[action.index]!.code);
      else if (action.kind === 'exclude') {
        if (reasons.length === 0) decide('exclude');
        else setExcluding(true);
      } else if (action.kind === 'include' || action.kind === 'maybe') decide(action.kind);
      else if (action.kind === 'undo') undo();
      else if (action.kind === 'next') setIndex((i) => Math.min(i + 1, Math.max(0, records.length - 1)));
      else setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, excluding, reasons, records.length, undo]);

  if (reviews === null) return error === null ? <LoadingState label="Loading reviews…" /> : <ErrorState error={error} />;
  if (reviews.length === 0) {
    return (
      <section className="screening empty">
        <h1>Systematic reviews</h1>
        <p>
          No reviews yet. Start one with <code>recueil sr create "&lt;title&gt;"</code> and import a search with <code>recueil sr search</code>, or through the API.
        </p>
      </section>
    );
  }

  const decisionOf = (record: ReviewRecordWire) => (stage === 'title_abstract' ? record.titleAbstract : record.fullText);
  const count = (key: string) => prisma?.cells.find((cell) => cell.stageKey === key && cell.sourceLabel === null && cell.exclusionReasonCode === null)?.count ?? 0;

  return (
    <section className="screening">
      <header className="screening-bar">
        <select aria-label="Review" value={review?.id ?? ''} onChange={(event) => setReview(reviews.find((r) => r.id === event.target.value) ?? null)}>
          {reviews.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </select>
        <div role="tablist" aria-label="Stage">
          {(['title_abstract', 'full_text'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={stage === s} onClick={() => setStage(s)}>
              {s === 'title_abstract' ? 'Title/abstract' : 'Full text'}
            </button>
          ))}
        </div>
        <span className="screening-progress" aria-live="polite">
          {counts.total - counts.pending} of {counts.total} screened
        </span>
        {review !== null ? (
          <span className="screening-exports">
            <a href={client.reviewExportUrl(review.id, 'prisma.svg')}>PRISMA SVG</a> · <a href={client.reviewExportUrl(review.id, 'prisma.csv')}>PRISMA2020 CSV</a> · <a href={client.reviewExportUrl(review.id, 'audit.csv')}>Audit trail</a>
          </span>
        ) : null}
      </header>
      {error !== null ? <ErrorState error={error} /> : null}
      <div className="screening-body">
        <ol className="screening-list" aria-label="Records">
          {records.map((record, i) => {
            const decision = decisionOf(record);
            return (
              <li key={record.id} aria-current={i === index} className={decision === null ? 'pending' : decision.decision}>
                <button onClick={() => setIndex(i)}>
                  <span className="mark">{decision === null ? '·' : decision.decision === 'include' ? '✓' : decision.decision === 'exclude' ? '✗' : '?'}</span> {record.title ?? '(untitled)'}
                </button>
              </li>
            );
          })}
        </ol>
        <article className="screening-record">
          {current === undefined ? (
            <p>{stage === 'full_text' ? 'No records have passed title/abstract screening yet.' : 'No records.'}</p>
          ) : (
            <>
              <h2>{current.title ?? '(untitled)'}</h2>
              <p className="meta">
                {current.authors.slice(0, 6).join(', ')}
                {current.authors.length > 6 ? ' et al.' : ''} · {current.year ?? 'n.d.'} · {current.venue ?? ''}
                {current.doi === null ? null : (
                  <>
                    {' '}
                    · <a href={`https://doi.org/${current.doi}`}>{current.doi}</a>
                  </>
                )}
              </p>
              <p className="sources">Found in: {current.sources.join(', ') || '—'}</p>
              {stage === 'full_text' && current.retrievalStatus !== 'retrieved' ? (
                <p className="retrieval">
                  Full text: {current.retrievalStatus.replace('_', ' ')}.{' '}
                  <button onClick={() => review !== null && client.setReviewRetrieval(review.id, current.id, 'retrieved').then(() => reload(true), setError)}>Mark retrieved</button>{' '}
                  <button onClick={() => review !== null && client.setReviewRetrieval(review.id, current.id, 'not_retrieved').then(() => reload(true), setError)}>Not retrievable</button>
                </p>
              ) : null}
              <div className="abstract">{current.abstract ?? <em>No abstract.</em>}</div>
              <div className="screening-actions">
                <button disabled={busy} onClick={() => decide('include')}>
                  <kbd>i</kbd> Include
                </button>
                <button disabled={busy} onClick={() => (reasons.length === 0 ? decide('exclude') : setExcluding(true))}>
                  <kbd>e</kbd> Exclude
                </button>
                <button disabled={busy} onClick={() => decide('maybe')}>
                  <kbd>m</kbd> Maybe
                </button>
                <button disabled={busy || history.length === 0} onClick={undo}>
                  <kbd>u</kbd> Undo
                </button>
              </div>
              {excluding ? (
                <ol className="screening-reasons" aria-label="Exclusion reason">
                  {reasons.map((reason, i) => (
                    <li key={reason.code}>
                      <button onClick={() => decide('exclude', reason.code)}>
                        <kbd>{i + 1}</kbd> {reason.label}
                      </button>
                    </li>
                  ))}
                  {stage === 'title_abstract' ? (
                    <li>
                      <button onClick={() => decide('exclude')}>No reason</button>
                    </li>
                  ) : null}
                </ol>
              ) : null}
              {decisionOf(current) === null ? null : (
                <p className="current">
                  Current decision: {decisionOf(current)!.decision}
                  {decisionOf(current)!.exclusionReasonCode === null ? '' : ` (${reasons.find((r) => r.code === decisionOf(current)!.exclusionReasonCode)?.label ?? decisionOf(current)!.exclusionReasonCode})`}
                </p>
              )}
            </>
          )}
        </article>
        <aside className="screening-prisma" aria-label="PRISMA 2020 counts">
          <h3>PRISMA 2020 (live)</h3>
          <table>
            <tbody>
              {PRISMA_ROWS.map(([key, label]) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td>{count(key)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </aside>
      </div>
    </section>
  );
};
