/**
 * The three-pane library, wired together.
 *
 * This is where the panes stop being independent components: choosing a collection has to narrow
 * the middle pane, moving the selection has to change the right one, and the keyboard has to do
 * both without the mouse. The error case is here too, because a failed list request is the state
 * the user is most likely to meet and least likely to have been shown honestly.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import { FocusManager } from '../src/keyboard/focus.js';
import { LibraryView } from '../src/library/library-view.js';
import type { LibraryViewState } from '../src/library/library-view.js';
import { registerCoreSections } from '../src/item-pane/sections/index.js';
import { FakeProblem, createFakeServer } from './fake-server.js';
import type { FakeServer, Handler } from './fake-server.js';
import {
  ITEM_ID,
  collection,
  expandedItem,
  id,
  itemSummary,
  page,
  problem,
  tag,
} from './fixtures.js';
import { renderWithApi } from './helpers.js';

beforeAll(() => {
  registerCoreSections();
});

const METHODS = id('COL001');
const READING = id('COL002');
const TO_READ = id('TAG001');

const ROWS = [
  itemSummary({ id: ITEM_ID, title: 'Attrition bias in randomised trials' }),
  itemSummary({ id: '01J8F3Z9K4AAAAAAAAAAAAAAA2', title: 'Reporting guidelines' }),
];

const baseRoutes = (overrides: Record<string, Handler> = {}): Record<string, Handler> => ({
  'GET /api/v1/items': () => page(ROWS, null, 2),
  'GET /api/v1/items/:id': () => expandedItem(),
  'GET /api/v1/collections': () =>
    page([
      collection({ id: METHODS, name: 'Methods', itemCount: 12 }),
      collection({ id: READING, name: 'Reading list', parentId: METHODS, depth: 1 }),
    ]),
  'GET /api/v1/tags': () => page([tag({ id: TO_READ, name: 'to-read' })]),
  'GET /api/v1/notes': () => page([]),
  'GET /api/v1/fields': () => page([]),
  'GET /api/v1/items/:id/field-values': () => page([]),
  ...overrides,
});

/** A harness that holds the state the route would otherwise keep in the URL. */
const Harness = ({ initial }: { initial?: Partial<LibraryViewState> }): JSX.Element => {
  const [state, setState] = useState<LibraryViewState>({
    scope: { kind: 'library' },
    selectedItemId: null,
    order: 'desc',
    text: '',
    ...initial,
  });
  return (
    <FocusManager>
      <LibraryView
        state={state}
        onStateChange={(change) => setState((current) => ({ ...current, ...change }))}
        onOpenItem={() => undefined}
      />
    </FocusManager>
  );
};

const renderLibrary = (server: FakeServer, initial?: Partial<LibraryViewState>) =>
  renderWithApi(<Harness initial={initial} />, server);

describe('the library view', () => {
  it('renders the three panes', async () => {
    renderLibrary(createFakeServer(baseRoutes()));

    expect(await screen.findByRole('region', { name: 'Collections' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'All items' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Item' })).toBeInTheDocument();
  });

  it('draws the collection forest, with saved searches and tags beside it', async () => {
    renderLibrary(createFakeServer(baseRoutes()));

    const methods = await screen.findByRole('treeitem', { name: /Methods/u });
    expect(methods).toHaveAttribute('aria-level', '1');
    expect(within(methods).getByText('12')).toBeInTheDocument();
    // A child collection is a level deeper, which is how the forest of invariant C1 is conveyed.
    expect(screen.getByRole('treeitem', { name: /Reading list/u })).toHaveAttribute('aria-level', '2');
    expect(screen.getByRole('treeitem', { name: /to-read/u })).toBeInTheDocument();
  });

  it('narrows the item list to the chosen collection', async () => {
    const user = userEvent.setup();
    const server = createFakeServer(baseRoutes());
    renderLibrary(server);

    await user.click(await screen.findByRole('treeitem', { name: /Methods/u }));

    await waitFor(() => {
      const scoped = server
        .requestsTo('GET', '/api/v1/items')
        .filter((request) => request.query.get('collectionId') === METHODS);
      expect(scoped).toHaveLength(1);
    });
    expect(await screen.findByRole('region', { name: 'Methods' })).toBeInTheDocument();
  });

  it('moves the selection with j and k, and shows the item in the right-hand pane', async () => {
    const user = userEvent.setup();
    renderLibrary(createFakeServer(baseRoutes()));

    await screen.findByText('Attrition bias in randomised trials');

    await user.keyboard('j');
    await waitFor(() =>
      expect(screen.getByTestId(`item-row-${ITEM_ID}`)).toHaveAttribute('data-selected', 'true'),
    );
    expect(await screen.findByRole('button', { name: /Bibliographic/u })).toBeInTheDocument();

    await user.keyboard('j');
    await waitFor(() =>
      expect(screen.getByTestId('item-row-01J8F3Z9K4AAAAAAAAAAAAAAA2')).toHaveAttribute(
        'data-selected',
        'true',
      ),
    );

    await user.keyboard('k');
    await waitFor(() =>
      expect(screen.getByTestId(`item-row-${ITEM_ID}`)).toHaveAttribute('data-selected', 'true'),
    );
  });

  it('reverses the sort order from the keyboard', async () => {
    const user = userEvent.setup();
    const server = createFakeServer(baseRoutes());
    renderLibrary(server);

    await screen.findByText('Attrition bias in randomised trials');
    await user.keyboard('r');

    await waitFor(() => {
      const ascending = server
        .requestsTo('GET', '/api/v1/items')
        .filter((request) => request.query.get('order') === 'asc');
      expect(ascending).toHaveLength(1);
    });
  });

  it('opens the command palette, filters it, and runs the command', async () => {
    const user = userEvent.setup();
    const server = createFakeServer(baseRoutes());
    renderLibrary(server);

    await screen.findByRole('treeitem', { name: /Methods/u });
    await user.keyboard('{Control>}k{/Control}');

    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(within(palette).getByRole('combobox'), 'methods');

    const options = within(palette).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Go to Methods');

    await user.keyboard('{Enter}');

    await waitFor(() => {
      const scoped = server
        .requestsTo('GET', '/api/v1/items')
        .filter((request) => request.query.get('collectionId') === METHODS);
      expect(scoped).toHaveLength(1);
    });
  });

  it('shows the generated shortcut list, and closes it again', async () => {
    const user = userEvent.setup();
    renderLibrary(createFakeServer(baseRoutes()));

    await screen.findByText('Attrition bias in randomised trials');
    await user.keyboard('?');

    const help = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(help).getByText('Select the next item')).toBeInTheDocument();
    expect(within(help).getByText('Open the command palette')).toBeInTheDocument();
    // Reader shortcuts belong to the reader's scope and are not listed here.
    expect(within(help).queryByText('Next page')).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull());
  });

  it('does not fire a shortcut while the search box is being typed into', async () => {
    const user = userEvent.setup();
    const server = createFakeServer(baseRoutes());
    renderLibrary(server);

    const search = await screen.findByLabelText('Search the library');
    await user.click(search);
    await user.type(search, 'jerk');

    expect(search).toHaveValue('jerk');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the problem document when the list request fails', async () => {
    const server = createFakeServer(
      baseRoutes({
        'GET /api/v1/items': () => {
          throw new FakeProblem(
            problem({
              type: 'https://recueil.org/problems/unavailable',
              title: 'Service unavailable',
              status: 503,
              detail: 'The content-addressed store at /var/lib/recueil/storage is not writable.',
              traceId: 'req-8f2c11',
            }),
          );
        },
      }),
    );
    renderLibrary(server);

    expect(await screen.findByText('Could not load the library')).toBeInTheDocument();
    expect(screen.getByTestId('problem-detail')).toHaveTextContent(
      'The content-addressed store at /var/lib/recueil/storage is not writable.',
    );
    expect(screen.getByTestId('problem-type')).toHaveTextContent(
      'https://recueil.org/problems/unavailable',
    );
    expect(screen.getByTestId('problem-trace')).toHaveTextContent('req-8f2c11');
    expect(screen.getByText('503')).toBeInTheDocument();
  });

  it('retries a failed list request when asked', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const server = createFakeServer(
      baseRoutes({
        'GET /api/v1/items': () => {
          attempts += 1;
          if (attempts === 1) throw new FakeProblem(problem({ status: 503, title: 'Service unavailable' }));
          return page(ROWS, null, 2);
        },
      }),
    );
    renderLibrary(server);

    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Attrition bias in randomised trials')).toBeInTheDocument();
  });

  it('says the item pane has nothing selected rather than showing an empty frame', async () => {
    renderLibrary(createFakeServer(baseRoutes()));

    expect(await screen.findByText('Nothing selected')).toBeInTheDocument();
  });
});
