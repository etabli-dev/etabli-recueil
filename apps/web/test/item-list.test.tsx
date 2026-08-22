/**
 * The item list: rendering rows, and following the cursor to the next page.
 *
 * The end condition asserted here is the contract's: the list stops when a page comes back with a
 * null `nextCursor`, not when a page comes back empty.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ItemListContainer } from '../src/library/item-list.js';
import { createFakeServer } from './fake-server.js';
import { itemSummary, page } from './fixtures.js';
import { renderWithApi } from './helpers.js';

const FIRST = [
  itemSummary({ id: '01J8F3Z9K4AAAAAAAAAAAAAAA1', title: 'Attrition bias in randomised trials' }),
  itemSummary({ id: '01J8F3Z9K4AAAAAAAAAAAAAAA2', title: 'Reporting guidelines for observational studies' }),
];
const SECOND = [
  itemSummary({ id: '01J8F3Z9K4AAAAAAAAAAAAAAA3', title: 'Registered reports in the health sciences' }),
];

const listProps = {
  selectedItemId: null,
  onSelect: () => undefined,
  onOpen: () => undefined,
  order: 'desc' as const,
  onOrderChange: () => undefined,
  scopeLabel: 'All items',
  filtered: false,
};

describe('the item list', () => {
  it('renders a row per item and reports how many are loaded', async () => {
    const server = createFakeServer({
      'GET /api/v1/items': () => page(FIRST, null, 2),
    });

    renderWithApi(<ItemListContainer query={{}} {...listProps} />, server);

    expect(await screen.findByText('Attrition bias in randomised trials')).toBeInTheDocument();
    expect(screen.getByText('Reporting guidelines for observational studies')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    expect(screen.getByText('End of the list')).toBeInTheDocument();
  });

  it('sends the scope and the filter as the query parameters the API declares', async () => {
    const server = createFakeServer({
      'GET /api/v1/items': () => page(FIRST, null),
    });

    renderWithApi(
      <ItemListContainer
        query={{ collectionId: '01J8F3Z9K4COLLECTION000001', q: 'attrition', order: 'asc' }}
        {...listProps}
        order="asc"
      />,
      server,
    );

    await screen.findByText('Attrition bias in randomised trials');

    const [request] = server.requestsTo('GET', '/api/v1/items');
    expect(request).toBeDefined();
    expect(request?.query.get('collectionId')).toBe('01J8F3Z9K4COLLECTION000001');
    // `q`, not `text`: the route parses its query with a strict object, so the name matters.
    expect(request?.query.get('q')).toBe('attrition');
    expect(request?.query.get('order')).toBe('asc');
    // No sort field is ever sent, because `GET /api/v1/items` rejects one.
    expect(request?.query.has('sort')).toBe(false);
    expect(request?.query.get('cursor')).toBeNull();
  });

  it('follows the cursor when the window reaches the end of what is loaded', async () => {
    const server = createFakeServer({
      'GET /api/v1/items': (request) =>
        request.query.get('cursor') === null ? page(FIRST, 'Y3Vyc29yLTE', 3) : page(SECOND, null, 3),
    });

    renderWithApi(<ItemListContainer query={{}} {...listProps} />, server);

    // Two rows do not fill the window, so the list fetches ahead on its own rather than leaving a
    // half-empty pane with a button in it.
    expect(await screen.findByText('Registered reports in the health sciences')).toBeInTheDocument();
    // The first page is still there: pages accumulate, they do not replace.
    expect(screen.getByText('Attrition bias in randomised trials')).toBeInTheDocument();
    expect(screen.getByText('3 of 3')).toBeInTheDocument();

    const requests = server.requestsTo('GET', '/api/v1/items');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.query.get('cursor')).toBe('Y3Vyc29yLTE');

    // A null cursor is the end, and the list says so rather than offering another page.
    expect(screen.getByText('End of the list')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('offers the next page as a button once the window is full', async () => {
    const user = userEvent.setup();
    const first = Array.from({ length: 20 }, (_, index) =>
      itemSummary({ id: `01J8F3Z9K4BBBBBBBBBBBBBB${String(index).padStart(2, '0')}`, title: `Row ${index}` }),
    );
    const server = createFakeServer({
      'GET /api/v1/items': (request) =>
        request.query.get('cursor') === null ? page(first, 'Y3Vyc29yLTE', 21) : page(SECOND, null, 21),
    });

    renderWithApi(<ItemListContainer query={{}} {...listProps} />, server);

    expect(await screen.findByText('Row 0')).toBeInTheDocument();
    expect(server.requestsTo('GET', '/api/v1/items')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('21 of 21')).toBeInTheDocument();
    const requests = server.requestsTo('GET', '/api/v1/items');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.query.get('cursor')).toBe('Y3Vyc29yLTE');
  });

  it('says the library is empty rather than showing nothing', async () => {
    const server = createFakeServer({
      'GET /api/v1/items': () => page([], null, 0),
    });

    renderWithApi(<ItemListContainer query={{}} {...listProps} />, server);

    expect(await screen.findByText('All items is empty')).toBeInTheDocument();
    expect(
      screen.getByText(/Import a Zotero library, capture a page with the connector/u),
    ).toBeInTheDocument();
  });

  it('distinguishes an empty filter result from an empty library', async () => {
    const server = createFakeServer({
      'GET /api/v1/items': () => page([], null, 0),
    });

    renderWithApi(
      <ItemListContainer query={{ q: 'nothing matches this' }} {...listProps} filtered scopeLabel="All items" />,
      server,
    );

    expect(await screen.findByText('Nothing in All items matches')).toBeInTheDocument();
  });

  it('reports the order change upwards rather than refetching on its own', async () => {
    const user = userEvent.setup();
    const onOrderChange = vi.fn();
    const server = createFakeServer({ 'GET /api/v1/items': () => page(FIRST, null) });

    renderWithApi(<ItemListContainer query={{}} {...listProps} onOrderChange={onOrderChange} />, server);
    await screen.findByText('Attrition bias in randomised trials');

    await user.click(screen.getByRole('button', { name: 'Sort oldest first' }));
    await waitFor(() => expect(onOrderChange).toHaveBeenCalledWith('asc'));
  });

  it('offers no sort field, because the API has none to offer', async () => {
    const server = createFakeServer({ 'GET /api/v1/items': () => page(FIRST, null) });

    renderWithApi(<ItemListContainer query={{}} {...listProps} />, server);
    await screen.findByText('Attrition bias in randomised trials');

    expect(screen.queryByLabelText('Sort by')).toBeNull();
    expect(screen.getByText('Ordered by when the item last changed')).toBeInTheDocument();
  });
});
