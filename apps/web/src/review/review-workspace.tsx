/**
 * The review queue workspace — the screen M2 rests on.
 *
 * Phase 2's exit criterion is "scanner → searchable item with zero manual steps", with an
 * auto-accept rate above 90%. The other ten per cent arrive here, and whether that is a triumph or
 * a chore is decided entirely by how long one decision takes. So the layout puts the three things a
 * decision needs side by side and never behind a click: the queue, the reason with what the run
 * recorded, and the document itself.
 *
 * Four properties are deliberate.
 *
 * **Keyboard first.** `a`, `e` and `x` are unmodified letters, and `j`/`k` move.
 *
 * **Undo is a grace period, because the API has no reopen.** `ReviewService.accept` and `reject`
 * both refuse an entry that is not `open`, so a sent decision is final. A keystroke therefore
 * *stages* the decision — the entry leaves the list at once and the request goes out when the
 * window closes — and `u` inside the window cancels it, having sent nothing. Once it is sent, the
 * banner stops offering undo and says what is actually still possible: trashing the item, which is
 * a smaller statement and an honest one. Everything staged is flushed when the screen goes away, so
 * the window is a delay and never a loss.
 *
 * **The trace is what the run recorded, and it says so.** The pipeline keeps the matched rule ids
 * and the conflicts from stage 8, not the whole evaluation; `RunTrace` renders what is there and
 * points at the dry run for the rest, rather than showing a summary that reads like a trace.
 *
 * **Nothing on this screen is a number the client counted.** The document's size and digest come
 * from its row; what an acceptance did comes from the server's answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Document } from '@recueil/schemas';

import { useApiClient } from '../api/context.js';
import {
  queryKeys,
  useIngestionJob,
  useResolveReviewEntry,
  useReviewEntry,
  useReviewQueue,
  useTrashItem,
} from '../api/queries.js';
import { useQuery } from '@tanstack/react-query';
import type {
  ProposedItemPayload,
  ReviewEntry,
  ReviewListQuery,
  ReviewSeverity,
  ReviewStatus,
} from '../api/ingestion.js';
import { EXECUTABLE_ACTIONS } from '../api/ingestion.js';
import { Pane } from '../components/panel.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { useFocusManager } from '../keyboard/focus.js';
import { useShortcuts } from '../keyboard/use-shortcuts.js';
import { formatChord } from '../keyboard/shortcuts.js';
import {
  UNDO_WINDOW_MS,
  describeAfterSending,
  describePending,
  describeSent,
  nextAfterResolution,
  rememberSent,
  stepSelection,
  visibleEntries,
} from './decisions.js';
import type { PendingDecision, SentDecision } from './decisions.js';
import { EditsEditor } from './edits-editor.js';
import { RunTrace } from './run-trace.js';
import { SubjectPreview } from './subject-preview.js';

export interface ReviewWorkspaceState {
  selectedEntryId: string | null;
  status: ReviewStatus;
  severity?: ReviewSeverity | undefined;
  reasonCode?: string | undefined;
}

export interface ReviewWorkspaceProps {
  state: ReviewWorkspaceState;
  onStateChange: (change: Partial<ReviewWorkspaceState>) => void;
  /** How long a decision can be taken back. A parameter so a test can drive it without waiting. */
  undoWindowMs?: number;
}

const PAGE_LIMIT = 50;

export const ReviewWorkspace = ({
  state,
  onStateChange,
  undoWindowMs = UNDO_WINDOW_MS,
}: ReviewWorkspaceProps): JSX.Element => {
  const client = useApiClient();
  const focus = useFocusManager();

  const query = useMemo<ReviewListQuery>(
    () => ({
      status: state.status,
      limit: PAGE_LIMIT,
      ...(state.severity === undefined ? {} : { severity: state.severity }),
      ...(state.reasonCode === undefined || state.reasonCode === '' ? {} : { reasonCode: state.reasonCode }),
    }),
    [state.status, state.severity, state.reasonCode],
  );

  const queue = useReviewQueue(query);
  const resolve = useResolveReviewEntry();
  const trash = useTrashItem();

  const [pending, setPending] = useState<readonly PendingDecision[]>([]);
  const [sent, setSent] = useState<readonly SentDecision[]>([]);
  const [editing, setEditing] = useState(false);

  const entries = useMemo(() => visibleEntries(queue.data?.data ?? [], pending), [queue.data, pending]);
  const selectedId = state.selectedEntryId;
  const detail = useReviewEntry(selectedId);
  const selected = detail.data ?? entries.find((entry) => entry.id === selectedId) ?? null;

  /* The document behind the entry ------------------------------------------------------------- */

  const documentId = selected !== null && selected.subjectType === 'document' ? selected.subjectId : null;
  const document_ = useQuery<Document>({
    queryKey: queryKeys.document(documentId ?? ''),
    queryFn: ({ signal }) => client.getDocument(documentId as string, signal),
    enabled: documentId !== null,
  });

  const job = useIngestionJob(selected?.jobId ?? null);

  /* Sending -------------------------------------------------------------------------------------- */

  // `resolve` is read at timer time rather than captured, so the flush effect does not have to
  // re-register every render — and a decision staged just before unmount is still sent.
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  const send = useCallback((decision: PendingDecision) => {
    resolveRef.current.mutate(
      {
        id: decision.entry.id,
        decision: decision.kind,
        ...(decision.note === undefined ? {} : { note: decision.note }),
        ...(decision.edits === undefined ? {} : { edits: decision.edits }),
      },
      {
        onSuccess: (resolution) => {
          setSent((history) => rememberSent(history, { resolution, sentAt: Date.now() }));
        },
        onSettled: () => {
          setPending((current) => current.filter((staged) => staged.entry.id !== decision.entry.id));
        },
      },
    );
  }, []);

  // One timer per staged decision. Cleared when it is cancelled, and — the part that matters —
  // fired immediately when the component goes away, so closing the tab does not discard a decision
  // the reviewer believes they made.
  useEffect(() => {
    if (pending.length === 0) return undefined;
    const timers = pending.map((decision) =>
      setTimeout(() => send(decision), Math.max(0, decision.stagedAt + undoWindowMs - Date.now())),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [pending, send, undoWindowMs]);

  const pendingRef = useRef<readonly PendingDecision[]>(pending);
  pendingRef.current = pending;
  useEffect(
    () => () => {
      for (const decision of pendingRef.current) send(decision);
    },
    [send],
  );

  /* Deciding ------------------------------------------------------------------------------------- */

  const select = useCallback(
    (id: string | null) => {
      setEditing(false);
      onStateChange({ selectedEntryId: id });
    },
    [onStateChange],
  );

  const stage = useCallback(
    (kind: PendingDecision['kind'], edits?: Record<string, unknown>, note?: string) => {
      if (selected === null) return;
      const entry = selected;
      setEditing(false);
      setPending((current) =>
        current.some((decision) => decision.entry.id === entry.id)
          ? current
          : [...current, { entry, kind, edits, note, stagedAt: Date.now() }],
      );
      select(nextAfterResolution(entries, entry.id));
    },
    [selected, entries, select],
  );

  const cancelLast = useCallback(() => {
    setPending((current) => {
      if (current.length === 0) return current;
      const last = current[current.length - 1] as PendingDecision;
      select(last.entry.id);
      return current.slice(0, -1);
    });
  }, [select]);

  useEffect(() => {
    if (selectedId === null && entries.length > 0) select(entries[0]?.id ?? null);
  }, [selectedId, entries, select]);

  useShortcuts(
    {
      'review-next': () => select(stepSelection(entries, selectedId, 1)),
      'review-previous': () => select(stepSelection(entries, selectedId, -1)),
      'review-accept': () => stage('accept'),
      'review-edit': () => setEditing(true),
      'review-reject': () => stage('reject'),
      'review-undo': cancelLast,
      'review-load-more': () => void queue.refetch(),
      dismiss: () => setEditing(false),
    },
    { scope: 'review', enabled: !editing },
  );

  const lastPending = pending[pending.length - 1] ?? null;
  const lastSent = sent[0] ?? null;

  return (
    <div className="review">
      <Pane
        id="review-queue"
        title="Review queue"
        active={focus.activePane === 'items'}
        ref={focus.registerPane('items')}
        toolbar={
          <QueueFilters
            state={state}
            onStateChange={onStateChange}
            loaded={entries.length}
            hasMore={queue.data?.page.hasMore ?? false}
            staged={pending.length}
          />
        }
      >
        <QueueList entries={entries} selectedId={selectedId} onSelect={select} query={queue} />
      </Pane>

      <Pane
        id="review-entry"
        title={selected === null ? 'No entry selected' : selected.reasonCode}
        active={focus.activePane === 'detail'}
        ref={focus.registerPane('detail')}
      >
        {lastPending === null ? null : (
          <PendingBanner decision={lastPending} onCancel={cancelLast} windowMs={undoWindowMs} />
        )}
        {lastPending === null && lastSent !== null ? (
          <SentBanner
            decision={lastSent}
            onTrash={(itemId) =>
              trash.mutate({ itemId, reason: `reversing the acceptance of review entry ${lastSent.resolution.entry.id}` })
            }
            busy={trash.isPending}
            error={trash.isError ? trash.error : null}
            done={trash.isSuccess}
          />
        ) : null}
        {resolve.isError ? <ErrorState label="The decision was refused" error={resolve.error} /> : null}

        {selectedId === null ? (
          <EmptyState
            title="Nothing to decide"
            description="Choose an entry on the left, or change the filter above it."
          />
        ) : detail.isPending && selected === null ? (
          <LoadingState label="Loading the entry…" />
        ) : detail.isError && selected === null ? (
          <ErrorState label="Could not load the entry" error={detail.error} onRetry={() => void detail.refetch()} />
        ) : selected === null ? null : (
          <EntryDetail
            entry={selected}
            editing={editing}
            busy={resolve.isPending}
            onAccept={() => stage('accept')}
            onReject={() => stage('reject')}
            onEdit={() => setEditing(true)}
            onCancelEdit={() => setEditing(false)}
            onAcceptEdited={(edits, note) => stage('accept', edits, note)}
            job={job}
          />
        )}
      </Pane>

      <Pane
        id="review-preview"
        title="Document"
        active={focus.activePane === 'reader'}
        ref={focus.registerPane('reader')}
      >
        <SubjectPreview
          document={documentId === null ? null : document_.data}
          loading={documentId !== null && document_.isPending}
          contentUrl={documentId === null ? null : client.documentContentUrl(documentId)}
          {...(selected === null || selected.subjectType === 'document'
            ? {}
            : {
                absentReason: `This entry is about a ${selected.subjectType.replace('_', ' ')}, not a file, so there is nothing to preview.`,
              })}
        />
      </Pane>
    </div>
  );
};

/* -------------------------------------------------------------------------------------------- */

const STATUSES: readonly ReviewStatus[] = ['open', 'accepted', 'rejected', 'deferred', 'superseded'];
const SEVERITIES: readonly ReviewSeverity[] = ['blocker', 'warning', 'info'];

interface QueueFiltersProps {
  state: ReviewWorkspaceState;
  onStateChange: (change: Partial<ReviewWorkspaceState>) => void;
  loaded: number;
  /** From the page envelope. `GET /ingestion/review` sends no total, and one is not invented here. */
  hasMore: boolean;
  staged: number;
}

const QueueFilters = ({ state, onStateChange, loaded, hasMore, staged }: QueueFiltersProps): JSX.Element => (
  <>
    <label className="visually-hidden" htmlFor="review-status">
      Status
    </label>
    <select
      id="review-status"
      className="select"
      value={state.status}
      onChange={(event) => onStateChange({ status: event.target.value as ReviewStatus, selectedEntryId: null })}
    >
      {STATUSES.map((status) => (
        <option key={status} value={status}>
          {status}
        </option>
      ))}
    </select>

    <label className="visually-hidden" htmlFor="review-severity">
      Severity
    </label>
    <select
      id="review-severity"
      className="select"
      value={state.severity ?? ''}
      onChange={(event) =>
        onStateChange({
          severity: event.target.value === '' ? undefined : (event.target.value as ReviewSeverity),
          selectedEntryId: null,
        })
      }
    >
      <option value="">any severity</option>
      {SEVERITIES.map((severity) => (
        <option key={severity} value={severity}>
          {severity}
        </option>
      ))}
    </select>

    <span className="item-list__count" data-testid="queue-count">
      {loaded} shown{hasMore ? ', more waiting' : ''}
      {staged === 0 ? '' : `, ${String(staged)} about to be sent`}
    </span>
  </>
);

interface QueueListProps {
  entries: readonly ReviewEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: ReturnType<typeof useReviewQueue>;
}

const QueueList = ({ entries, selectedId, onSelect, query }: QueueListProps): JSX.Element => {
  if (query.isPending) return <LoadingState label="Loading the review queue…" />;
  if (query.isError) {
    return (
      <ErrorState label="Could not load the review queue" error={query.error} onRetry={() => void query.refetch()} />
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nothing waiting"
        description="Every ingested document cleared the confidence gate, or the filter above excludes what is here."
      />
    );
  }

  return (
    <>
      <ul className="review-list" role="listbox" aria-label="Review queue entries">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              role="option"
              aria-selected={entry.id === selectedId}
              className="review-row"
              data-entry={entry.id}
              data-selected={entry.id === selectedId ? 'true' : 'false'}
              data-focus-target={entry.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(entry.id)}
            >
              <span className={`badge badge--${severityTone(entry.severity)}`}>{entry.severity}</span>
              <span className="review-row__reason">{entry.reasonCode}</span>
              <span className="review-row__subject">{proposedTitle(entry) ?? entry.subjectId}</span>
              {entry.confidence === null ? null : (
                <span className="review-row__confidence">{entry.confidence.toFixed(2)}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {query.data?.page.hasMore === true ? (
        <p className="section__note">
          The server sent a full page. Narrow the filter, or refresh with {formatChord('m')} after
          working through these.
        </p>
      ) : null}
    </>
  );
};

const severityTone = (severity: ReviewSeverity): string =>
  severity === 'blocker' ? 'error' : severity === 'warning' ? 'warn' : 'quiet';

/** The proposal's own title field, when it has one. Nothing is invented when it does not. */
const proposedTitle = (entry: ReviewEntry): string | null => {
  const payload = asProposal(entry.proposedPayload);
  const title = payload.fields?.['bibliographic.title'] ?? payload.fields?.['office.correspondent'];
  return typeof title === 'string' && title !== '' ? title : null;
};

export const asProposal = (payload: unknown): ProposedItemPayload =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as ProposedItemPayload)
    : {};

interface EntryDetailProps {
  entry: ReviewEntry;
  editing: boolean;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onAcceptEdited: (edits: Record<string, unknown> | undefined, note: string | undefined) => void;
  job: ReturnType<typeof useIngestionJob>;
}

const EntryDetail = ({
  entry,
  editing,
  busy,
  onAccept,
  onReject,
  onEdit,
  onCancelEdit,
  onAcceptEdited,
  job,
}: EntryDetailProps): JSX.Element => {
  const proposal = asProposal(entry.proposedPayload);
  const action = entry.proposedAction ?? 'none';
  const executable = EXECUTABLE_ACTIONS.includes(action);

  return (
    <div className="review-detail" data-testid="review-detail" data-entry={entry.id}>
      <p className="review-detail__explanation" data-testid="entry-explanation">
        {entry.explanation}
      </p>

      <dl className="review-detail__facts">
        <dt>Reason</dt>
        <dd>
          <code>{entry.reasonCode}</code>
        </dd>
        <dt>Raised by</dt>
        <dd>{entry.sourceStage ?? 'not recorded'}</dd>
        <dt>Proposed action</dt>
        <dd>
          <code>{action}</code>
        </dd>
        <dt>Confidence</dt>
        <dd>{entry.confidence === null ? 'not scored' : entry.confidence.toFixed(2)}</dd>
        <dt>Raised</dt>
        <dd>{entry.createdAt}</dd>
      </dl>

      {executable ? null : (
        <p className="field__error" role="alert" data-testid="entry-inexecutable">
          This build cannot execute <code>{action}</code>. Accepting it would be refused, so the
          honest options are to reject the entry or to resolve the situation directly and let a later
          run supersede it.
        </p>
      )}

      {editing ? (
        <EditsEditor
          proposal={proposal}
          busy={busy}
          onCancel={onCancelEdit}
          onAccept={(edits, note) => onAcceptEdited(edits as Record<string, unknown> | undefined, note)}
        />
      ) : (
        <>
          <div className="review-detail__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={onAccept}
              disabled={busy || !executable}
            >
              Accept <kbd>{formatChord('a')}</kbd>
            </button>
            <button
              type="button"
              className="button"
              onClick={onEdit}
              disabled={busy || !executable || entry.proposedPayload === null}
            >
              Edit and accept <kbd>{formatChord('e')}</kbd>
            </button>
            <button type="button" className="button button--danger" onClick={onReject} disabled={busy}>
              Reject <kbd>{formatChord('x')}</kbd>
            </button>
          </div>

          {entry.proposedPayload === null ? (
            <p className="section__note">
              This entry proposes no payload, so accepting it records the decision and writes nothing.
            </p>
          ) : (
            <details className="review-detail__payload">
              <summary>The payload accepting will execute</summary>
              <pre data-testid="entry-payload">{JSON.stringify(entry.proposedPayload, null, 2)}</pre>
            </details>
          )}
        </>
      )}

      <section className="review-detail__trace" aria-label="Rule trace">
        <h3 className="section__title">What the run recorded</h3>
        <RunTrace
          entry={entry}
          detail={job.data}
          pending={job.isPending && entry.jobId !== null}
          error={job.isError ? job.error : null}
          onRetry={() => void job.refetch()}
        />
      </section>
    </div>
  );
};

interface PendingBannerProps {
  decision: PendingDecision;
  onCancel: () => void;
  windowMs: number;
}

/**
 * The banner while a decision can still be taken back.
 *
 * The countdown is not decoration: the offer expires, and an interface that showed "Undo" for a
 * button that had silently stopped working would be worse than one that never offered it.
 */
const PendingBanner = ({ decision, onCancel, windowMs }: PendingBannerProps): JSX.Element => {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, decision.stagedAt + windowMs - Date.now()),
  );

  useEffect(() => {
    const tick = setInterval(() => {
      setRemaining(Math.max(0, decision.stagedAt + windowMs - Date.now()));
    }, 250);
    return () => clearInterval(tick);
  }, [decision, windowMs]);

  return (
    <div className="review__banner" role="status" data-testid="pending-banner">
      <span className="review__banner-text">{describePending(decision)}</span>
      <button type="button" className="button button--small" onClick={onCancel}>
        Undo ({formatChord('u')})
      </button>
      <span className="review__banner-undo-note" data-testid="pending-remaining">
        Sending in {Math.ceil(remaining / 1000)} s. Nothing has been written yet; undo now and
        nothing will be.
      </span>
    </div>
  );
};

interface SentBannerProps {
  decision: SentDecision;
  onTrash: (itemId: string) => void;
  busy: boolean;
  error: unknown;
  done: boolean;
}

const SentBanner = ({ decision, onTrash, busy, error, done }: SentBannerProps): JSX.Element => {
  const itemId = decision.resolution.itemId;
  return (
    <div className="review__banner" role="status" data-testid="sent-banner">
      <span className="review__banner-text">{describeSent(decision)}</span>
      {itemId === null || done ? null : (
        <button type="button" className="button button--small" onClick={() => onTrash(itemId)} disabled={busy}>
          {busy ? 'Trashing…' : 'Move the item to the trash'}
        </button>
      )}
      <span className="review__banner-undo-note">
        {done ? 'The item is in the trash, where it can be restored.' : describeAfterSending(decision)}
      </span>
      {decision.resolution.warnings.length === 0 ? null : (
        <ul className="state__field-errors" data-testid="sent-warnings">
          {decision.resolution.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {error === null ? null : <ErrorState label="The item was not trashed" error={error} />}
    </div>
  );
};
