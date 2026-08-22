/**
 * The three-pane library (CONCEPT.md §5.14).
 *
 * Collections and tags on the left, the item list in the middle, the item pane on the right; the
 * keyboard map, the command palette and the help overlay on top of all three. This component owns
 * the wiring and none of the rendering: each pane is its own component, and the item pane's
 * contents come from the section registry.
 *
 * State lives above it. The route puts the scope, the selection, the sort direction and the search
 * text in the URL, so that the middle pane is addressable and the back button does what it looks
 * like it does; this component only reports changes upwards.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ItemSummary } from '@recueil/schemas';

import { useCollections, useTags } from '../api/queries.js';
import { Pane } from '../components/panel.js';
import { CommandPalette } from '../keyboard/command-palette.js';
import { ShortcutHelp } from '../keyboard/shortcut-help.js';
import { useFocusManager } from '../keyboard/focus.js';
import { useShortcuts } from '../keyboard/use-shortcuts.js';
import type { Command } from '../keyboard/commands.js';
import { ItemPane } from '../item-pane/item-pane.js';
import { CollectionTree } from './collection-tree.js';
import { ItemListContainer } from './item-list.js';
import { LIBRARY_SCOPE, scopeKey, scopeTitle, scopeToQuery } from './scope.js';
import type { LibraryScope } from './scope.js';

export interface LibraryViewState {
  scope: LibraryScope;
  selectedItemId: string | null;
  /**
   * The direction of the list's one ordering, `(dateModified, id)`.
   *
   * There is no sort field to choose. `GET /api/v1/items` orders by that pair and nothing else,
   * because a cursor over a non-total order skips or repeats rows, and a control offering a
   * choice the API does not have would be a control that lies.
   */
  order: 'asc' | 'desc';
  /** The full-text filter, in Recueil's own query syntax. */
  text: string;
}

export interface LibraryViewProps {
  state: LibraryViewState;
  onStateChange: (change: Partial<LibraryViewState>) => void;
  /** Open an item's first readable attachment in the reader. */
  onOpenItem: (itemId: string) => void;
}

export const LibraryView = ({ state, onStateChange, onOpenItem }: LibraryViewProps): JSX.Element => {
  const collections = useCollections();
  const tags = useTags();
  const focus = useFocusManager();

  const [rows, setRows] = useState<readonly ItemSummary[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const collectionRows = collections.data?.data ?? [];
  const tagRows = tags.data?.data ?? [];

  const move = useCallback(
    (delta: number | 'first' | 'last'): void => {
      if (rows.length === 0) return;
      const current = rows.findIndex((row) => row.id === state.selectedItemId);
      let next: number;
      if (delta === 'first') next = 0;
      else if (delta === 'last') next = rows.length - 1;
      else if (current < 0) next = delta > 0 ? 0 : rows.length - 1;
      else next = Math.min(Math.max(current + delta, 0), rows.length - 1);
      const row = rows[next];
      if (row !== undefined) onStateChange({ selectedItemId: row.id });
    },
    [rows, state.selectedItemId, onStateChange],
  );

  const openSelected = useCallback((): void => {
    if (state.selectedItemId !== null) onOpenItem(state.selectedItemId);
  }, [state.selectedItemId, onOpenItem]);

  const loadMoreRef = useRef<() => void>(() => undefined);
  const registerLoadMore = useCallback((loadMore: () => void) => {
    loadMoreRef.current = loadMore;
  }, []);

  /**
   * While an overlay is open it owns the keyboard, all but the two keys that get out of it: the
   * listener stays bound and the library's own handlers are withheld, rather than the binding being
   * torn down — unbinding would take `Escape` with it and leave the overlay unclosable by keyboard.
   */
  const overlayOpen = paletteOpen || helpOpen;

  useShortcuts(
    {
      dismiss: () => {
        setPaletteOpen(false);
        setHelpOpen(false);
      },
      ...(overlayOpen
        ? {}
        : {
            'command-palette': () => setPaletteOpen(true),
            'shortcut-help': () => setHelpOpen(true),
            'focus-collections': () => focus.focusPane('collections'),
            'focus-items': () => focus.focusPane('items'),
            'focus-item-pane': () => focus.focusPane('detail'),
            'focus-search': () => searchRef.current?.focus(),
            'item-next': () => move(1),
            'item-previous': () => move(-1),
            'item-first': () => move('first'),
            'item-last': () => move('last'),
            'item-load-more': () => loadMoreRef.current(),
            'item-open': openSelected,
            'sort-reverse': () => onStateChange({ order: state.order === 'desc' ? 'asc' : 'desc' }),
          }),
    },
    { scope: 'library' },
  );

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'library.all',
        title: 'Show all items',
        group: 'Library',
        run: () => onStateChange({ scope: LIBRARY_SCOPE }),
      },
      {
        id: 'library.search',
        title: 'Search the library',
        group: 'Library',
        shortcutId: 'focus-search',
        run: () => searchRef.current?.focus(),
      },
      {
        id: 'library.reverse',
        title: 'Reverse the sort order',
        group: 'Library',
        shortcutId: 'sort-reverse',
        run: () => onStateChange({ order: state.order === 'desc' ? 'asc' : 'desc' }),
      },
      {
        id: 'library.open',
        title: 'Open the selected item in the reader',
        group: 'Library',
        shortcutId: 'item-open',
        disabled: state.selectedItemId === null,
        run: openSelected,
      },
      {
        id: 'library.help',
        title: 'Show the keyboard shortcuts',
        group: 'Help',
        shortcutId: 'shortcut-help',
        run: () => setHelpOpen(true),
      },
      ...collectionRows.map<Command>((collection) => ({
        id: `collection.${collection.id}`,
        title: `Go to ${collection.name}`,
        group: collection.kind === 'smart' ? 'Saved searches' : 'Collections',
        keywords: 'collection filing',
        run: () => onStateChange({ scope: { kind: 'collection', collectionId: collection.id } }),
      })),
      ...tagRows.map<Command>((tag) => ({
        id: `tag.${tag.id}`,
        title: `Show items tagged ${tag.name}`,
        group: 'Tags',
        run: () => onStateChange({ scope: { kind: 'tag', tagId: tag.id } }),
      })),
    ],
    [collectionRows, tagRows, state.order, state.selectedItemId, onStateChange, openSelected],
  );

  const listQuery = useMemo(
    () => ({
      ...scopeToQuery(state.scope),
      order: state.order,
      ...(state.text.trim() === '' ? {} : { q: state.text.trim() }),
    }),
    [state.scope, state.order, state.text],
  );

  const label = scopeTitle(state.scope, collectionRows, tagRows);

  return (
    <div className="library" data-scope={scopeKey(state.scope)}>
      <Pane
        id="collections"
        title="Collections"
        ref={focus.registerPane('collections')}
        active={focus.activePane === 'collections'}
      >
        <CollectionTree
          collections={collectionRows}
          tags={tagRows}
          scope={state.scope}
          onSelect={(scope) => onStateChange({ scope, selectedItemId: null })}
          status={collections.isPending ? 'pending' : collections.isError ? 'error' : 'success'}
          error={collections.error}
          onRetry={() => void collections.refetch()}
        />
      </Pane>

      <Pane
        id="items"
        title={label}
        ref={focus.registerPane('items')}
        active={focus.activePane === 'items'}
        toolbar={
          <input
            ref={searchRef}
            className="search"
            type="search"
            aria-label="Search the library"
            placeholder="Search…"
            value={state.text}
            onChange={(event) => onStateChange({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              onStateChange({ text: '' });
              event.currentTarget.blur();
            }}
          />
        }
      >
        <ItemListContainer
          query={listQuery}
          onRowsChange={setRows}
          onLoadMoreReady={registerLoadMore}
          selectedItemId={state.selectedItemId}
          onSelect={(itemId) => onStateChange({ selectedItemId: itemId })}
          onOpen={onOpenItem}
          order={state.order}
          onOrderChange={(order) => onStateChange({ order })}
          scopeLabel={label}
          filtered={state.text.trim() !== '' || state.scope.kind !== 'library'}
        />
      </Pane>

      <Pane id="detail" title="Item" ref={focus.registerPane('detail')} active={focus.activePane === 'detail'}>
        <ItemPane itemId={state.selectedItemId} />
      </Pane>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <ShortcutHelp open={helpOpen} scope="library" onClose={() => setHelpOpen(false)} />
    </div>
  );
};
