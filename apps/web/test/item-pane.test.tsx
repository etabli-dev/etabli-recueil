/**
 * The item pane: sections, lock state, and what an edit actually sends.
 *
 * The two assertions that matter here are about the contract rather than the pixels. A field whose
 * provenance says `locked` has to say so on screen, because P4-2 is only useful if the person
 * looking at the value knows it is protected. And an edit has to send a patch containing that one
 * field and nothing else, because a manual write locks everything it touches (P4-1) — a patch that
 * echoed the facet back would lock all of it.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';

import { ItemPane } from '../src/item-pane/item-pane.js';
import { registerCoreSections } from '../src/item-pane/sections/index.js';
import { FakeProblem, createFakeServer } from './fake-server.js';
import type { Handler } from './fake-server.js';
import {
  ATTACHMENT_ID,
  ITEM_ID,
  collection,
  customField,
  expandedItem,
  fieldValue,
  id,
  note,
  page,
  problem,
} from './fixtures.js';
import { renderWithApi } from './helpers.js';

beforeAll(() => {
  registerCoreSections();
});

const COLLECTION_ID = id('COL001');
const FIELD_ID = id('FLD001');

/** Everything the pane's sections fetch, so that only the route under test has to be overridden. */
const routes = (overrides: Record<string, Handler> = {}): Record<string, Handler> => ({
  'GET /api/v1/items/:id': () => expandedItem(),
  'GET /api/v1/collections': () => page([collection({ id: COLLECTION_ID, name: 'Methods' })]),
  'GET /api/v1/notes': () => page([note({ id: id('NOTE01'), itemId: ITEM_ID, title: 'On attrition' })]),
  'GET /api/v1/fields': () =>
    page([customField({ id: FIELD_ID, fieldKey: 'sample_size', name: 'Sample size', dataType: 'integer' })]),
  'GET /api/v1/items/:id/field-values': () =>
    page([
      fieldValue({
        id: id('FVL001'),
        fieldId: FIELD_ID,
        content: { type: 'integer', value: 1204 },
      }),
    ]),
  ...overrides,
});

describe('the item pane', () => {
  it('renders every registered section in order', async () => {
    const server = createFakeServer(routes());
    renderWithApi(<ItemPane itemId={ITEM_ID} />, server);

    expect(await screen.findByRole('button', { name: /Bibliographic/u })).toBeInTheDocument();
    for (const title of ['Attachments', 'Tags', 'Collections', 'Notes', 'Custom fields']) {
      expect(screen.getByRole('button', { name: new RegExp(title, 'u') })).toBeInTheDocument();
    }
  });

  it('shows a field whose provenance is locked as locked, and offers to release it', async () => {
    const server = createFakeServer(routes());
    renderWithApi(<ItemPane itemId={ITEM_ID} />, server);

    const doi = await screen.findByTestId('field-doi');
    expect(doi).toHaveAttribute('data-locked', 'true');
    expect(within(doi).getByTestId('lock-doi')).toHaveTextContent('Locked');
    expect(within(doi).getByText('Resolvers will not overwrite this value.')).toBeInTheDocument();
    expect(within(doi).getByRole('button', { name: 'Unlock DOI' })).toBeInTheDocument();
    // The lock protects the value from resolvers, not from its owner: it stays editable.
    expect(within(doi).getByLabelText('DOI')).not.toHaveAttribute('readonly');

    // A field with unlocked provenance is not marked, and shows where the value came from.
    const title = screen.getByTestId('field-title');
    expect(title).toHaveAttribute('data-locked', 'false');
    expect(within(title).queryByTestId('lock-title')).not.toBeInTheDocument();
    expect(within(title).getByText(/from crossref/u)).toBeInTheDocument();
    expect(within(title).getByText(/confidence 0\.98/u)).toBeInTheDocument();
  });

  it('sends a patch carrying only the edited field, with the version as If-Match', async () => {
    const user = userEvent.setup();
    const server = createFakeServer(
      routes({
        'PATCH /api/v1/items/:id': (request) => {
          const body = request.body as { bibliographic?: { volume?: string } };
          const patched = expandedItem();
          patched.version = 8;
          if (patched.bibliographic !== null && patched.bibliographic !== undefined) {
            patched.bibliographic.volume = body.bibliographic?.volume ?? null;
          }
          return patched;
        },
      }),
    );

    renderWithApi(<ItemPane itemId={ITEM_ID} />, server);

    const volume = await screen.findByLabelText('Volume');
    await user.clear(volume);
    await user.type(volume, '366');
    await user.tab();

    await waitFor(() => expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)).toHaveLength(1));

    const [request] = server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`);
    expect(request?.body).toEqual({ bibliographic: { volume: '366' } });
    expect(request?.headers['if-match']).toBe('"7"');
    expect(request?.headers['content-type']).toBe('application/json');
  });

  it('clears a field to null rather than to an empty string', async () => {
    const user = userEvent.setup();
    const server = createFakeServer(
      routes({ 'PATCH /api/v1/items/:id': () => expandedItem() }),
    );

    renderWithApi(<ItemPane itemId={ITEM_ID} />, server);

    const volume = await screen.findByLabelText('Volume');
    await user.clear(volume);
    await user.tab();

    await waitFor(() => expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)).toHaveLength(1));
    expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)[0]?.body).toEqual({
      bibliographic: { volume: null },
    });
  });

  it('does not send a request when the value has not changed', async () => {
    const user = userEvent.setup();
    const server = createFakeServer(routes());
    renderWithApi(<ItemPane itemId={ITEM_ID} />, server);

    const volume = await screen.findByLabelText('Volume');
    await user.click(volume);
    await user.tab();

    expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)).toHaveLength(0);
  });

  it('refuses a non-numeric year in the client instead of sending it', async () => {
    const user = userEvent.setup();
    const server = createFakeServer(routes());
    renderWithApi(<ItemPane itemId={ITEM_ID} />, server);

    const year = await screen.findByLabelText('Year');
    await user.clear(year);
    await user.type(year, 'nineteen');
    await user.tab();

    expect(await screen.findByText('Year must be a whole number')).toBeInTheDocument();
    expect(server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`)).toHaveLength(0);
  });

  it('releases a lock by deleting it, and refetches the item to see the result', async () => {
    const user = userEvent.setup();
    let unlocked = false;
    const server = createFakeServer(
      routes({
        // `DELETE /items/{id}/locks/{fieldPath}` answers 204 and carries no body, so the pane can
        // only learn what happened by asking for the item again.
        'DELETE /api/v1/items/:id/locks/:fieldPath': () => {
          unlocked = true;
          return undefined;
        },
        'GET /api/v1/items/:id': () => {
          const item = expandedItem();
          if (unlocked && item.bibliographic !== null && item.bibliographic !== undefined) {
            item.bibliographic.lockedFields = [];
            item.bibliographic.provenance = {};
          }
          return item;
        },
      }),
    );

    renderWithApi(<ItemPane itemId={ITEM_ID} />, server);

    await user.click(await screen.findByRole('button', { name: 'Unlock DOI' }));

    await waitFor(() =>
      expect(server.requestsTo('DELETE', `/api/v1/items/${ITEM_ID}/locks/doi`)).toHaveLength(1),
    );
    // Provenance is read-only on the wire: nothing was posted anywhere (P4-3).
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    await waitFor(() => expect(screen.queryByTestId('lock-doi')).toBeNull());
  });

  it('renders the attachments, the tags and the typed custom-field values', async () => {
    const server = createFakeServer(routes());
    renderWithApi(<ItemPane itemId={ITEM_ID} />, server);

    expect(await screen.findByTestId(`attachment-${ATTACHMENT_ID}`)).toHaveTextContent('Ravaud 2019.pdf');
    expect(screen.getByTestId('tag-methods')).toHaveTextContent('methods');
    await waitFor(() =>
      expect(screen.getByTestId(`filed-in-${COLLECTION_ID}`)).toHaveTextContent('Methods'),
    );
    expect(await screen.findByTestId('custom-field-sample_size')).toHaveTextContent('1204');
  });

  it('reports a rejected write as its problem document', async () => {
    const user = userEvent.setup();
    const server = createFakeServer(
      routes({
        'PATCH /api/v1/items/:id': () => {
          throw new FakeProblem(
            problem({
              type: 'https://recueil.org/problems/version-conflict',
              title: 'Version conflict',
              status: 412,
              detail: 'The item was modified by another client; expected version 7.',
            }),
          );
        },
      }),
    );

    renderWithApi(<ItemPane itemId={ITEM_ID} />, server);

    const volume = await screen.findByLabelText('Volume');
    await user.clear(volume);
    await user.type(volume, '366');
    await user.tab();

    expect(await screen.findByText('The change was not saved')).toBeInTheDocument();
    expect(screen.getByTestId('problem-detail')).toHaveTextContent(
      'The item was modified by another client; expected version 7.',
    );
    expect(screen.getByTestId('problem-type')).toHaveTextContent(
      'https://recueil.org/problems/version-conflict',
    );
  });
});
