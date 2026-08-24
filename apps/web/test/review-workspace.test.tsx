/**
 * The review workspace, against the real client and a fake at the `fetch` boundary.
 *
 * The assertions are about the four things M2 rests on: that the reason and what the run recorded
 * are on screen together, that a decision is one keystroke, that undo genuinely takes a decision
 * back — because it is a grace period before the request goes out, the API having no reopen — and
 * that once a decision is sent the interface says what is actually still possible rather than
 * offering an undo that cannot work.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReviewWorkspace } from '../src/review/review-workspace.js';
import type { ReviewWorkspaceState } from '../src/review/review-workspace.js';
import { createFakeServer } from './fake-server.js';
import type { FakeServer, Handler } from './fake-server.js';
import { renderWithApi } from './helpers.js';
import {
  CREATED_ITEM_ID,
  DOCUMENT_ID,
  REVIEW_ENTRY_ID,
  SECOND_ENTRY_ID,
  acceptResult,
  jobDetail,
  page,
  reviewEntry,
  scanDocument,
  secondEntry,
} from './ingestion-fixtures.js';

const QUEUE = '/api/v1/ingestion/review';

/**
 * Short, so a test that waits for the window to close waits for a fraction of a second.
 *
 * Not *very* short: the tests that press `u` have to get there before the window closes, and under
 * a full suite run a keystroke through `userEvent` can take a hundred milliseconds. Half a second is
 * comfortably longer than that and still quick enough to wait out five times.
 */
const WINDOW_MS = 500;

const Harness = ({ initial }: { initial?: Partial<ReviewWorkspaceState> }): JSX.Element => {
  const [state, setState] = useState<ReviewWorkspaceState>({
    selectedEntryId: null,
    status: 'open',
    ...initial,
  });
  return (
    <ReviewWorkspace
      state={state}
      onStateChange={(change) => setState((current) => ({ ...current, ...change }))}
      undoWindowMs={WINDOW_MS}
    />
  );
};

const defaultRoutes = (overrides: Record<string, Handler> = {}): Record<string, Handler> => ({
  [`GET ${QUEUE}`]: () => page([reviewEntry(), secondEntry()]),
  [`GET ${QUEUE}/:id`]: (request) =>
    request.path.endsWith(SECOND_ENTRY_ID) ? secondEntry() : reviewEntry(),
  [`GET /api/v1/documents/:id`]: () => scanDocument(),
  [`GET /api/v1/ingestion/queue/:id`]: () => jobDetail(),
  ...overrides,
});

const render = (routes: Record<string, Handler>, initial?: Partial<ReviewWorkspaceState>): { server: FakeServer } => {
  const server = createFakeServer(routes);
  renderWithApi(<Harness {...(initial === undefined ? {} : { initial })} />, server);
  return { server };
};

/** Wait past the grace period, so the staged decision is actually sent. */
const passTheWindow = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 30));
  });
};

describe('the review queue workspace', () => {
  it('lists the open entries with their reason, severity and confidence', async () => {
    render(defaultRoutes());
    expect(await screen.findByText('low_confidence_metadata')).toBeInTheDocument();
    expect(screen.getByText('near_duplicate_file')).toBeInTheDocument();
    expect(screen.getAllByText('0.60').length).toBeGreaterThan(0);
  });

  it('asks the server for the status the filter names rather than filtering on screen', async () => {
    const { server } = render(defaultRoutes(), { status: 'accepted' });
    await screen.findByText('low_confidence_metadata');
    expect(server.requestsTo('GET', QUEUE)[0]?.query.get('status')).toBe('accepted');
  });

  it('shows the stored explanation and the payload accepting will execute', async () => {
    render(defaultRoutes());
    expect(await screen.findByTestId('entry-explanation')).toHaveTextContent('refused it at 0.60');
    expect(screen.getByTestId('entry-payload')).toHaveTextContent('Acme GmbH');
  });

  it('shows what the run recorded, naming the rules that fired', async () => {
    render(defaultRoutes());
    expect(await screen.findByTestId('run-trace')).toBeInTheDocument();
    expect(screen.getByTestId('trace-matched')).toHaveTextContent('scanner-by-folder');
    expect(screen.getByTestId('trace-conflicts')).toHaveTextContent('office.correspondent');
  });

  it('says where the rest of the trace is rather than pretending it has it', async () => {
    render(
      defaultRoutes({
        [`GET /api/v1/ingestion/queue/:id`]: () =>
          jobDetail({ stages: [{ candidateKey: 'cand-1', stage: 'rules', sha256: null, payload: { matched: [] }, createdAt: '2026-08-22T09:15:00.000Z' }] }),
      }),
    );
    expect(await screen.findByTestId('trace-no-match')).toHaveTextContent(
      'the pipeline stores the ids of the rules that fired, not the whole evaluation',
    );
  });

  it('says so when the entry names no run, without implying no rule matched', async () => {
    render(defaultRoutes(), { selectedEntryId: SECOND_ENTRY_ID });
    expect(await screen.findByTestId('trace-no-job')).toHaveTextContent('raised outside the ingestion pipeline');
  });

  it('previews the document by fetching its row, not by trusting the entry', async () => {
    const { server } = render(defaultRoutes());
    await screen.findByTestId('subject-preview');
    expect(server.requestsTo('GET', `/api/v1/documents/${DOCUMENT_ID}`)).toHaveLength(1);
    expect(screen.getByTestId('preview-pdf')).toHaveAttribute(
      'data',
      `/api/v1/documents/${DOCUMENT_ID}/content`,
    );
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
  });

  it('moves the selection with j and k', async () => {
    const user = userEvent.setup();
    render(defaultRoutes());
    await screen.findByTestId('review-detail');
    await user.keyboard('j');
    await waitFor(() => {
      expect(screen.getByTestId('review-detail')).toHaveAttribute('data-entry', SECOND_ENTRY_ID);
    });
    await user.keyboard('k');
    await waitFor(() => {
      expect(screen.getByTestId('review-detail')).toHaveAttribute('data-entry', REVIEW_ENTRY_ID);
    });
  });

  it('stages an acceptance on one keystroke and sends nothing yet', async () => {
    const user = userEvent.setup();
    const { server } = render(defaultRoutes({ [`POST ${QUEUE}/:id/accept`]: () => acceptResult() }));

    await screen.findByTestId('review-detail');
    await user.keyboard('a');

    expect(await screen.findByTestId('pending-banner')).toHaveTextContent('not sent yet');
    expect(server.requestsTo('POST', `${QUEUE}/${REVIEW_ENTRY_ID}/accept`)).toHaveLength(0);
    // The entry has left the queue and the cursor has moved on.
    await waitFor(() => {
      expect(screen.getByTestId('review-detail')).toHaveAttribute('data-entry', SECOND_ENTRY_ID);
    });
  });

  it('sends the staged acceptance once the window closes', async () => {
    const user = userEvent.setup();
    const { server } = render(defaultRoutes({ [`POST ${QUEUE}/:id/accept`]: () => acceptResult() }));

    await screen.findByTestId('review-detail');
    await user.keyboard('a');
    await passTheWindow();

    await waitFor(() => {
      expect(server.requestsTo('POST', `${QUEUE}/${REVIEW_ENTRY_ID}/accept`)).toHaveLength(1);
    });
    expect(await screen.findByTestId('sent-banner')).toHaveTextContent('It created one item');
  });

  it('undoes a staged decision by never sending it', async () => {
    const user = userEvent.setup();
    const { server } = render(defaultRoutes({ [`POST ${QUEUE}/:id/accept`]: () => acceptResult() }));

    await screen.findByTestId('review-detail');
    await user.keyboard('a');
    await screen.findByTestId('pending-banner');
    await user.keyboard('u');
    await passTheWindow();

    expect(server.requestsTo('POST', `${QUEUE}/${REVIEW_ENTRY_ID}/accept`)).toHaveLength(0);
    expect(screen.queryByTestId('pending-banner')).not.toBeInTheDocument();
    // The entry is back in the queue and selected again.
    await waitFor(() => {
      expect(screen.getByTestId('review-detail')).toHaveAttribute('data-entry', REVIEW_ENTRY_ID);
    });
  });

  it('says how long undo has left, because the offer expires', async () => {
    const user = userEvent.setup();
    render(defaultRoutes({ [`POST ${QUEUE}/:id/accept`]: () => acceptResult() }));
    await screen.findByTestId('review-detail');
    await user.keyboard('a');
    expect(await screen.findByTestId('pending-remaining')).toHaveTextContent('Sending in');
  });

  it('stops offering undo after sending, and offers what is actually possible instead', async () => {
    const user = userEvent.setup();
    render(defaultRoutes({ [`POST ${QUEUE}/:id/accept`]: () => acceptResult() }));

    await screen.findByTestId('review-detail');
    await user.keyboard('a');
    await passTheWindow();

    const banner = await screen.findByTestId('sent-banner');
    expect(banner).toHaveTextContent('stays resolved');
    expect(banner).not.toHaveTextContent(/undo/iu);
    expect(screen.getByRole('button', { name: 'Move the item to the trash' })).toBeInTheDocument();
  });

  it('trashes the item an acceptance created, when asked', async () => {
    const user = userEvent.setup();
    const { server } = render(
      defaultRoutes({
        [`POST ${QUEUE}/:id/accept`]: () => acceptResult(),
        [`POST /api/v1/items/:id/trash`]: () => undefined,
      }),
    );

    await screen.findByTestId('review-detail');
    await user.keyboard('a');
    await passTheWindow();
    await user.click(await screen.findByRole('button', { name: 'Move the item to the trash' }));

    await waitFor(() => {
      expect(server.requestsTo('POST', `/api/v1/items/${CREATED_ITEM_ID}/trash`)).toHaveLength(1);
    });
    expect(await screen.findByText(/in the trash, where it can be restored/u)).toBeInTheDocument();
  });

  it('rejects on one keystroke, and sends after the window', async () => {
    const user = userEvent.setup();
    const { server } = render(
      defaultRoutes({ [`POST ${QUEUE}/:id/reject`]: () => reviewEntry({ status: 'rejected' }) }),
    );

    await screen.findByTestId('review-detail');
    await user.keyboard('x');
    await passTheWindow();

    await waitFor(() => {
      expect(server.requestsTo('POST', `${QUEUE}/${REVIEW_ENTRY_ID}/reject`)).toHaveLength(1);
    });
    expect(await screen.findByTestId('sent-banner')).toHaveTextContent('Nothing was created');
  });

  it('sends only the fields the reviewer changed, as a patch', async () => {
    const user = userEvent.setup();
    const { server } = render(defaultRoutes({ [`POST ${QUEUE}/:id/accept`]: () => acceptResult() }));

    await screen.findByTestId('review-detail');
    await user.keyboard('e');

    const editor = await screen.findByTestId('edits-editor');
    const correspondent = editor.querySelector('#edits-office\\.correspondent') as HTMLInputElement;
    fireEvent.change(correspondent, { target: { value: 'ACME GmbH' } });
    await user.type(screen.getByLabelText(/Why/u), 'the scanner folder is misspelt');
    await user.click(screen.getByRole('button', { name: 'Accept with these edits' }));
    await passTheWindow();

    await waitFor(() => {
      expect(server.requestsTo('POST', `${QUEUE}/${REVIEW_ENTRY_ID}/accept`)).toHaveLength(1);
    });
    const body = server.requestsTo('POST', `${QUEUE}/${REVIEW_ENTRY_ID}/accept`)[0]?.body as {
      edits: { fields: Record<string, unknown> };
      note: string;
    };
    expect(body.edits.fields).toEqual({ 'office.correspondent': 'ACME GmbH' });
    // The ASN was not touched, so it is not in the patch — and would not be relocked by one.
    expect(body.edits.fields).not.toHaveProperty('office.asn');
    expect(body.note).toBe('the scanner folder is misspelt');
  });

  it('refuses to let an inexecutable action be accepted, and says why', async () => {
    render(
      defaultRoutes({
        [`GET ${QUEUE}`]: () => page([reviewEntry({ proposedAction: 'merge' })]),
        [`GET ${QUEUE}/:id`]: () => reviewEntry({ proposedAction: 'merge' }),
      }),
    );
    expect(await screen.findByTestId('entry-inexecutable')).toHaveTextContent('cannot execute');
    expect(screen.getByRole('button', { name: /^Accept/u })).toBeDisabled();
  });

  it('reports a refused decision as its problem document', async () => {
    const user = userEvent.setup();
    render(
      defaultRoutes({
        [`POST ${QUEUE}/:id/accept`]: () => {
          throw new Error('the entry is already accepted');
        },
      }),
    );
    await screen.findByTestId('review-detail');
    await user.keyboard('a');
    await passTheWindow();
    expect(await screen.findByText('The decision was refused')).toBeInTheDocument();
  });

  it('shows an empty queue as a finished one rather than a blank pane', async () => {
    render({ [`GET ${QUEUE}`]: () => page([]) });
    expect(await screen.findByText('Nothing waiting')).toBeInTheDocument();
  });
});
