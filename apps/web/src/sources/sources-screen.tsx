/**
 * The sources screen: what is configured, whether it is reachable, and what it last did.
 *
 * Four questions, and the screen answers exactly those: what sources exist, does this one connect,
 * what did the last run do, and what is still waiting. The fourth decides whether M2 is working,
 * and it is the one an interface most easily lies about — so the rule here is that **every number
 * comes from the server**, and each is shown with the record it came from:
 *
 *   - the connection test lists the individual checks it ran, and its `ok` is their conjunction
 *     rather than a separate opinion, so a green result names its own evidence;
 *   - the last run is the job row for `lastRunJobId`, with its state, its progress and its error —
 *     not a tally the screen kept of runs it watched start;
 *   - the backlog is the count of review entries the run raised, queried from the review queue by
 *     `jobId`, which is the other side of the comparison rather than the run's own log.
 *
 * "Test the connection" is a probe, not a run: it resolves, lists or logs in and stops, so pressing
 * it on a live mailbox marks nothing read and consumes nothing.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { MAX_PAGE_SIZE } from '../api/client.js';
import { useApiClient } from '../api/context.js';
import {
  queryKeys,
  useCreateIngestionSource,
  useDeleteIngestionSource,
  useIngestionJob,
  useIngestionSources,
  useRunIngestionSource,
  useTestIngestionSource,
  useUpdateIngestionSource,
} from '../api/queries.js';
import { pipelineJobIdOf } from '../api/ingestion.js';
import type {
  IngestionJobDetail,
  IngestionSource,
  ReviewEntry,
  TestConnectionResult,
} from '../api/ingestion.js';
import type { Page } from '@recueil/schemas';
import { Pane } from '../components/panel.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { SourceForm } from './source-form.js';

export interface SourcesScreenProps {
  selectedSourceId: string | null;
  onSelect: (id: string | null) => void;
}

export const SourcesScreen = ({ selectedSourceId, onSelect }: SourcesScreenProps): JSX.Element => {
  const sources = useIngestionSources();
  const [adding, setAdding] = useState(false);
  const create = useCreateIngestionSource();

  const list = sources.data?.data ?? [];
  const selected = list.find((source) => source.id === selectedSourceId) ?? null;

  return (
    <div className="sources">
      <Pane
        id="sources-list"
        title="Sources"
        toolbar={
          <button
            type="button"
            className="button button--small"
            onClick={() => {
              setAdding(true);
              onSelect(null);
            }}
          >
            Add a source
          </button>
        }
      >
        {sources.isPending ? (
          <LoadingState label="Loading the sources…" />
        ) : sources.isError ? (
          <ErrorState label="Could not load the sources" error={sources.error} onRetry={() => void sources.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            title="No sources configured"
            description="A watched folder, a WebDAV share or a mailbox. All three feed the same pipeline, so what a rule can do to one it can do to all."
          />
        ) : (
          <ul className="source-list" role="listbox" aria-label="Configured sources">
            {list.map((source) => (
              <li key={source.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={source.id === selectedSourceId}
                  className="source-row"
                  data-source={source.id}
                  data-selected={source.id === selectedSourceId ? 'true' : 'false'}
                  onClick={() => {
                    setAdding(false);
                    onSelect(source.id);
                  }}
                >
                  <span className="source-row__name">{source.name}</span>
                  <span className="badge badge--quiet">{source.kind}</span>
                  {source.enabled ? null : <span className="badge badge--warn">disabled</span>}
                  {source.lastError === null ? null : <span className="badge badge--error">last run failed</span>}
                  <span className="source-row__where">{describeWhere(source)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Pane>

      <Pane id="sources-detail" title={adding ? 'New source' : selected?.name ?? 'No source selected'}>
        {adding ? (
          <>
            {create.isError ? <ErrorState label="The source was not created" error={create.error} /> : null}
            <SourceForm
              busy={create.isPending}
              onCancel={() => setAdding(false)}
              onSubmit={(body) =>
                create.mutate(body, {
                  onSuccess: (created) => {
                    setAdding(false);
                    onSelect(created.id);
                  },
                })
              }
            />
          </>
        ) : selected === null ? (
          <EmptyState
            title="Nothing selected"
            description="Choose a source to see whether it connects, what it last did and what is still waiting."
          />
        ) : (
          <SourceDetail source={selected} onDeleted={() => onSelect(null)} />
        )}
      </Pane>
    </div>
  );
};

const describeWhere = (source: IngestionSource): string => {
  switch (source.config.kind) {
    case 'folder':
      return source.config.root;
    case 'webdav':
      return source.config.url;
    default:
      return `${source.config.host}/${source.config.mailbox ?? 'INBOX'}`;
  }
};

/* -------------------------------------------------------------------------------------------- */

const SourceDetail = ({ source, onDeleted }: { source: IngestionSource; onDeleted: () => void }): JSX.Element => {
  const client = useApiClient();
  const test = useTestIngestionSource();
  const run = useRunIngestionSource();
  const update = useUpdateIngestionSource(source.id);
  const remove = useDeleteIngestionSource();
  const [editing, setEditing] = useState(false);

  const job = useIngestionJob(source.lastRunJobId);

  /**
   * The backlog: the review entries this source's last run raised and nobody has decided.
   *
   * Queried from the review queue — the other side of the comparison — rather than read out of the
   * run's own report. A count taken from the importer's log cannot fail, and is worse than no count
   * because it reads as evidence.
   *
   * The key is the *pipeline* job, not the source run: entries are stamped with the `ingest.run`
   * id, and filtering by the `ingest.source` id silently answers zero. `pipelineJobIdOf` explains
   * the two-job shape; until the run reports one there is nothing to ask about, which is a
   * different state from "asked, and the answer was none".
   *
   * The page is asked for at `MAX_PAGE_SIZE` and no more. A backlog larger than one page is
   * reported as "at least this many" off `page.hasMore` rather than by asking for a bigger page:
   * the ceiling is enforced on the response as well as the request, so exceeding it does not
   * truncate the answer, it replaces it with a 500.
   */
  const pipelineJobId = pipelineJobIdOf(job.data);

  const backlog = useQuery<Page<ReviewEntry>>({
    queryKey: [...queryKeys.reviewQueue(), 'for-job', pipelineJobId ?? ''],
    queryFn: ({ signal }) =>
      client.listReviewEntries(
        { status: 'open', jobId: pipelineJobId as string, limit: MAX_PAGE_SIZE },
        signal,
      ),
    enabled: pipelineJobId !== null,
  });

  if (editing) {
    return (
      <>
        {update.isError ? <ErrorState label="The change was not saved" error={update.error} /> : null}
        <SourceForm
          source={source}
          busy={update.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={(body) => update.mutate(body, { onSuccess: () => setEditing(false) })}
        />
      </>
    );
  }

  return (
    <div className="source-detail" data-testid="source-detail" data-source={source.id}>
      <div className="source-detail__actions">
        <button type="button" className="button" onClick={() => test.mutate(source.id)} disabled={test.isPending}>
          {test.isPending ? 'Testing…' : 'Test the connection'}
        </button>
        <button type="button" className="button" onClick={() => run.mutate(source.id)} disabled={run.isPending}>
          {run.isPending ? 'Starting…' : 'Run now'}
        </button>
        <button type="button" className="button" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={() => remove.mutate(source.id, { onSuccess: onDeleted })}
          disabled={remove.isPending}
        >
          Remove
        </button>
      </div>

      {test.isError ? <ErrorState label="The test failed to run" error={test.error} /> : null}
      {test.data === undefined ? null : <TestReport result={test.data} />}

      {run.isError ? <ErrorState label="The run was not started" error={run.error} /> : null}
      {run.data === undefined ? null : (
        <p className="source-detail__run-started" role="status">
          Run <code>{run.data.runLabel}</code> started as job <code>{run.data.jobId}</code> at{' '}
          {run.data.startedAt}. The counts below are the server’s, and refresh on their own.
        </p>
      )}

      {remove.isError ? <ErrorState label="The source was not removed" error={remove.error} /> : null}

      <section aria-label="Last run">
        <h3 className="section__title">Last run</h3>
        {source.lastRunJobId === null ? (
          <p className="section__note">This source has not run yet.</p>
        ) : job.isPending ? (
          <LoadingState label="Reading the run…" />
        ) : job.isError ? (
          <ErrorState label="Could not read the run" error={job.error} onRetry={() => void job.refetch()} />
        ) : (
          <LastRun detail={job.data} lastRunAt={source.lastRunAt} />
        )}
        {source.lastError === null ? null : (
          <p className="state__problem-title" role="alert" data-testid="source-last-error">
            The last run recorded: {source.lastError}
          </p>
        )}
      </section>

      <section aria-label="Backlog">
        <h3 className="section__title">Backlog</h3>
        {source.lastRunJobId === null ? (
          <p className="section__note">Nothing has run, so nothing is waiting.</p>
        ) : job.isPending ? (
          <LoadingState label="Reading the run…" />
        ) : job.isError ? (
          <ErrorState label="Could not read the run" error={job.error} onRetry={() => void job.refetch()} />
        ) : pipelineJobId === null ? (
          // No pipeline job to ask about. Said plainly rather than shown as a zero, because the two
          // are different claims: this one is "the run put nothing through the pipeline", which is
          // what an empty folder looks like, and a zero would assert that the queue was asked.
          <p className="section__note" data-testid="backlog-none">
            {job.data.job.finishedAt === null
              ? 'The run has not reached the pipeline yet, so there is nothing to count.'
              : 'The run offered nothing to the pipeline, so it raised nothing to review.'}
          </p>
        ) : backlog.isPending ? (
          <LoadingState label="Counting what is waiting…" />
        ) : backlog.isError ? (
          <ErrorState label="Could not count the backlog" error={backlog.error} />
        ) : (
          <p data-testid="backlog-open">
            <strong>{backlog.data.data.length}</strong> open review entr
            {backlog.data.data.length === 1 ? 'y' : 'ies'} from the last run
            {backlog.data.page.hasMore ? ' (at least: the page was full)' : ''}.
            <span className="field__hint">
              {' '}
              Counted by asking the review queue for this run’s open entries, not by adding up what
              the run said it did.
            </span>
          </p>
        )}
      </section>

      <details className="source-detail__config">
        <summary>Configuration</summary>
        <dl className="source-detail__facts">
          <dt>Recorded as</dt>
          <dd>
            <code>{source.sourceKind}</code>
          </dd>
          <dt>After ingesting</dt>
          <dd>
            {source.consume.mode}
            {source.consume.mode === 'move' ? ` → ${source.consume.to ?? ''}` : ''}
          </dd>
          <dt>Credentials held</dt>
          <dd>{source.secretNames.length === 0 ? 'none' : source.secretNames.join(', ')}</dd>
          <dt>Version</dt>
          <dd>{source.version}</dd>
        </dl>
        <pre>{JSON.stringify(source.config, null, 2)}</pre>
      </details>
    </div>
  );
};

/**
 * The connection test, one row per check.
 *
 * `ok` is rendered as the conjunction it is: the rows are shown whether it passed or failed, so a
 * green badge is never the only thing on screen.
 */
const TestReport = ({ result }: { result: TestConnectionResult }): JSX.Element => (
  <div className="source-detail__test" data-testid="test-result" data-ok={result.ok ? 'true' : 'false'} role="status">
    <p className="source-health">
      <span className={`badge badge--${result.ok ? 'ok' : 'error'}`}>{result.ok ? 'reachable' : 'not reachable'}</span>
      <span>{result.detail}</span>
      <span className="source-health__at">
        checked {result.checkedAt} in {result.durationMs} ms
      </span>
    </p>
    <ul className="source-checks" data-testid="test-checks">
      {result.checks.map((check) => (
        <li key={check.check} data-check={check.check} data-ok={check.ok ? 'true' : 'false'}>
          <span aria-hidden="true">{check.ok ? '✓' : '✗'}</span> <code>{check.check}</code> {check.detail}
        </li>
      ))}
    </ul>
    <p className="field__hint">
      A test polls and stops: nothing was ingested, nothing was marked read and nothing was moved.
    </p>
  </div>
);

const LastRun = ({ detail, lastRunAt }: { detail: IngestionJobDetail; lastRunAt: string | null }): JSX.Element => {
  const { job } = detail;
  const failures = detail.log.filter((line) => line.level === 'error');
  return (
    <div data-testid="last-run" data-state={job.state}>
      <p>
        <span className={`badge badge--${job.state === 'succeeded' ? 'ok' : job.state === 'failed' || job.state === 'dead' ? 'error' : 'warn'}`}>
          {job.state}
        </span>{' '}
        started {job.startedAt ?? lastRunAt ?? 'not recorded'}
        {job.finishedAt === null ? ', still running' : `, finished ${job.finishedAt}`}.
      </p>
      <dl className="source-detail__facts">
        <dt>Candidates</dt>
        <dd data-testid="run-progress">
          {job.progress.done} of {job.progress.total ?? '?'}
        </dd>
        <dt>Attempts</dt>
        <dd>
          {job.attempts} of {job.maxAttempts}
        </dd>
        <dt>Raised for review</dt>
        <dd data-testid="run-review-entries">{detail.reviewEntryIds.length}</dd>
      </dl>
      <p className="field__hint">
        “{job.state}” is the job row’s own state. <code>waiting_review</code> is not a failure: the
        run raised entries and will not proceed until they are resolved (IK6).
      </p>
      {job.error === null ? null : (
        <p className="state__problem-title" role="alert">
          <code>{job.error.code}</code> {job.error.message}
        </p>
      )}
      {failures.length === 0 ? (
        <p className="section__note">
          No error was logged. That is the absence of an error row, not a claim that every document
          arrived — the candidate count above is where that is answered.
        </p>
      ) : (
        <ul className="source-failures" data-testid="source-failures">
          {failures.map((line) => (
            <li key={line.id}>
              <span className="source-failures__at">{line.loggedAt}</span>
              <span>{line.message}</span>
              {line.subjectId === null ? null : <code className="source-failures__ref">{line.subjectId}</code>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
