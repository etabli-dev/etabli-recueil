/**
 * The sources screen.
 *
 * What is asserted is mostly what the screen refuses to claim. The connection test's rows are shown
 * whether it passed or failed, because `ok` is their conjunction and a badge on its own is an
 * opinion. The backlog is counted by asking the review queue for the run's open entries — the other
 * side of the comparison — and the test proves that request is actually made rather than the number
 * coming from the run's own report. And "no error logged" is not rendered as "everything arrived".
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SourcesScreen } from '../src/sources/sources-screen.js';
import { createFakeServer } from './fake-server.js';
import type { FakeServer, Handler } from './fake-server.js';
import { renderWithApi } from './helpers.js';
import {
  JOB_ID,
  SOURCE_ID,
  folderSource,
  ingestionJob,
  jobDetail,
  page,
  reviewEntry,
  testResult,
} from './ingestion-fixtures.js';

const SOURCES = '/api/v1/ingestion/sources';
const REVIEW = '/api/v1/ingestion/review';

const Harness = ({ initial = null }: { initial?: string | null }): JSX.Element => {
  const [selected, setSelected] = useState<string | null>(initial);
  return <SourcesScreen selectedSourceId={selected} onSelect={setSelected} />;
};

const render = (routes: Record<string, Handler>, initial: string | null = null): { server: FakeServer } => {
  const server = createFakeServer({
    [`GET ${SOURCES}`]: () => page([folderSource()]),
    [`GET /api/v1/ingestion/queue/:id`]: () => jobDetail(),
    [`GET ${REVIEW}`]: () => page([reviewEntry()]),
    ...routes,
  });
  renderWithApi(<Harness initial={initial} />, server);
  return { server };
};

describe('the sources screen', () => {
  it('lists the configured sources with where each reads from', async () => {
    render({});
    expect(await screen.findByText('Scanner drop')).toBeInTheDocument();
    expect(screen.getByText('/srv/consume')).toBeInTheDocument();
  });

  it('marks a source whose last run recorded an error', async () => {
    render({ [`GET ${SOURCES}`]: () => page([folderSource({ lastError: 'ENOENT' })]) });
    expect(await screen.findByText('last run failed')).toBeInTheDocument();
  });

  it('shows the last run from the job row, including that waiting_review is not a failure', async () => {
    render({}, SOURCE_ID);
    const run = await screen.findByTestId('last-run');
    expect(run).toHaveAttribute('data-state', 'waiting_review');
    expect(within(run).getByTestId('run-progress')).toHaveTextContent('7 of 7');
    expect(screen.getByText(/is not a failure: the run raised entries/u)).toBeInTheDocument();
  });

  it('counts the backlog by asking the review queue for this run’s open entries', async () => {
    const { server } = render({}, SOURCE_ID);

    expect(await screen.findByTestId('backlog-open')).toHaveTextContent('1 open review entry');
    const asked = server.requestsTo('GET', REVIEW);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.query.get('jobId')).toBe(JOB_ID);
    expect(asked[0]?.query.get('status')).toBe('open');
    expect(screen.getByText(/not by adding up what the run said it did/u)).toBeInTheDocument();
  });

  it('does not read "no error logged" as "everything arrived"', async () => {
    render({}, SOURCE_ID);
    expect(await screen.findByText(/not a claim that every document arrived/u)).toBeInTheDocument();
  });

  it('shows the errors the run did log', async () => {
    render(
      {
        [`GET /api/v1/ingestion/queue/:id`]: () =>
          jobDetail({
            job: ingestionJob({ state: 'failed', error: { code: 'source_unavailable', message: 'ENOENT' } }),
            log: [
              {
                id: 'log-2',
                loggedAt: '2026-08-22T09:16:00.000Z',
                level: 'error',
                message: 'OCR produced no text for scan-0044.pdf',
                data: null,
                subjectType: 'document',
                subjectId: 'doc-2',
              },
            ],
          }),
      },
      SOURCE_ID,
    );
    expect(await screen.findByTestId('source-failures')).toHaveTextContent('OCR produced no text');
    expect(screen.getByText('source_unavailable')).toBeInTheDocument();
  });

  it('tests the connection and lists every check it ran', async () => {
    const user = userEvent.setup();
    const { server } = render({ [`POST ${SOURCES}/:id/test-connection`]: () => testResult() }, SOURCE_ID);

    await screen.findByTestId('source-detail');
    await user.click(screen.getByRole('button', { name: 'Test the connection' }));

    const result = await screen.findByTestId('test-result');
    expect(result).toHaveAttribute('data-ok', 'true');
    expect(within(result).getByTestId('test-checks')).toHaveTextContent('resolve');
    expect(within(result).getByTestId('test-checks')).toHaveTextContent('directory');
    expect(result).toHaveTextContent('nothing was ingested');
    expect(server.requestsTo('POST', `${SOURCES}/${SOURCE_ID}/test-connection`)).toHaveLength(1);
  });

  it('shows the failing checks behind a failed test rather than only a badge', async () => {
    const user = userEvent.setup();
    render(
      {
        [`POST ${SOURCES}/:id/test-connection`]: () =>
          testResult({
            ok: false,
            checks: [
              { check: 'resolve', ok: true, detail: 'the path resolves' },
              { check: 'directory', ok: false, detail: 'ENOENT: no such directory' },
            ],
            detail: 'directory: ENOENT: no such directory',
          }),
      },
      SOURCE_ID,
    );
    await screen.findByTestId('source-detail');
    await user.click(screen.getByRole('button', { name: 'Test the connection' }));

    const result = await screen.findByTestId('test-result');
    expect(result).toHaveAttribute('data-ok', 'false');
    // Both the summary line and the failing row name it, which is the point: the badge is never
    // the only thing on screen.
    expect(within(result).getAllByText(/ENOENT/u).length).toBeGreaterThanOrEqual(2);
    expect(within(result).getByTestId('test-checks').querySelector('[data-ok="false"]')).toHaveTextContent(
      'directory',
    );
  });

  it('starts a run as a job rather than blocking on it', async () => {
    const user = userEvent.setup();
    render(
      {
        [`POST ${SOURCES}/:id/run`]: () => ({
          sourceId: SOURCE_ID,
          jobId: 'job-9',
          runLabel: '2026-08-22T09:21',
          startedAt: '2026-08-22T09:21:00.000Z',
        }),
      },
      SOURCE_ID,
    );

    await screen.findByTestId('source-detail');
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText(/started as job/u)).toHaveTextContent('job-9');
  });

  it('creates a folder source from the form', async () => {
    const user = userEvent.setup();
    const { server } = render({ [`POST ${SOURCES}`]: () => folderSource() });

    await screen.findByText('Scanner drop');
    await user.click(screen.getByRole('button', { name: 'Add a source' }));
    await user.type(screen.getByLabelText('Name'), 'Inbox');
    await user.type(screen.getByLabelText('Directory'), '/srv/inbox');
    await user.click(screen.getByRole('button', { name: 'Add the source' }));

    await waitFor(() => {
      expect(server.requestsTo('POST', SOURCES)).toHaveLength(1);
    });
    expect(server.requestsTo('POST', SOURCES)[0]?.body).toMatchObject({
      name: 'Inbox',
      config: { kind: 'folder', root: '/srv/inbox' },
    });
  });

  it('refuses an incomplete form locally, without a round trip', async () => {
    const user = userEvent.setup();
    const { server } = render({ [`POST ${SOURCES}`]: () => folderSource() });

    await screen.findByText('Scanner drop');
    await user.click(screen.getByRole('button', { name: 'Add a source' }));
    await user.click(screen.getByRole('button', { name: 'Add the source' }));

    expect(await screen.findByTestId('source-form-issues')).toHaveTextContent('Give the source a name.');
    expect(server.requestsTo('POST', SOURCES)).toHaveLength(0);
  });

  it('never shows a stored password, and says one is stored', async () => {
    const user = userEvent.setup();
    render(
      {
        [`GET ${SOURCES}`]: () =>
          page([
            folderSource({
              kind: 'imap',
              name: 'Scanner mail',
              sourceKind: 'imap',
              secretNames: ['password'],
              config: { kind: 'imap', host: 'mail.example.org', username: 'scans', mailbox: 'INBOX' },
            }),
          ]),
      },
      SOURCE_ID,
    );

    await screen.findByTestId('source-detail');
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    const password = screen.getByLabelText('Password');
    expect(password).toHaveValue('');
    expect(password).toHaveAttribute('placeholder', 'a password is stored');
    expect(screen.getByText(/Leave it blank to keep the stored one/u)).toBeInTheDocument();
  });

  it('shows an empty configuration as a decision to make rather than a blank pane', async () => {
    render({ [`GET ${SOURCES}`]: () => page([]) });
    expect(await screen.findByText('No sources configured')).toBeInTheDocument();
  });
});
