/**
 * The middle pane: the item list.
 *
 * Three things about it are load-bearing.
 *
 * **Cursor pagination.** Pages are joined by the opaque cursor the previous page returned, and the
 * end condition is the absence of a cursor, never an empty page
 * (`packages/schemas/src/envelopes/pagination.ts`). An offset would be wrong the moment an
 * ingestion run inserted a row above the window, which for this application is most of the time.
 *
 * **Virtualisation.** A personal library is tens of thousands of rows and the pane has to stay
 * responsive at the bottom of it, so only the visible window is in the DOM.
 *
 * **A visible way to fetch more.** The list loads the next page when the window reaches the end of
 * what it has, but there is also a button, because a scroll-triggered fetch that fails silently is
 * indistinguishable from the end of the library — and because "load the next page" has to be
 * reachable from the keyboard (`m` in the shortcut map).
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ItemSummary, PageInfo } from '@recueil/schemas';

import type { ItemListQuery } from '../api/client.js';
import { useItemList } from '../api/queries.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';

/** Row height in pixels. Fixed, because a measured row makes the scrollbar move as you scroll. */
export const ROW_HEIGHT = 76;

export interface ItemListProps {
  rows: readonly ItemSummary[];
  page?: PageInfo;
  selectedItemId: string | null;
  onSelect: (itemId: string) => void;
  onOpen: (itemId: string) => void;
  order: 'asc' | 'desc';
  onOrderChange: (order: 'asc' | 'desc') => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  /** Named so the empty state can say what is empty: the library, a collection, or a search. */
  scopeLabel: string;
  /** True when a filter is narrowing the list, which changes what "empty" means. */
  filtered: boolean;
}

export const ItemList = ({
  rows,
  page,
  selectedItemId,
  onSelect,
  onOpen,
  order,
  onOrderChange,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  scopeLabel,
  filtered,
}: ItemListProps): JSX.Element => {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualiser = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // A viewport to work from before the first measurement. Without it the first paint has no
    // height to fill and renders nothing at all.
    initialRect: { width: 720, height: 640 },
  });

  const virtualRows = virtualiser.getVirtualItems();
  const lastVisibleIndex = virtualRows[virtualRows.length - 1]?.index ?? -1;

  // Fetch ahead when the window reaches the tail of what is loaded.
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    if (rows.length === 0) return;
    if (lastVisibleIndex < rows.length - 1) return;
    onLoadMore();
  }, [hasNextPage, isFetchingNextPage, lastVisibleIndex, rows.length, onLoadMore]);

  // Keep the selection in view when the keyboard moves it.
  const selectedIndex = useMemo(
    () => rows.findIndex((row) => row.id === selectedItemId),
    [rows, selectedItemId],
  );
  useEffect(() => {
    if (selectedIndex < 0) return;
    virtualiser.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedIndex, virtualiser]);

  if (rows.length === 0) {
    return (
      <div className="item-list">
        <ListToolbar order={order} onOrderChange={onOrderChange} total={page?.total} loaded={0} />
        <EmptyState
          title={filtered ? `Nothing in ${scopeLabel} matches` : `${scopeLabel} is empty`}
          description={
            filtered
              ? 'No item matches the current filter. Clear the search, or choose a different collection.'
              : 'There is nothing here yet. Import a Zotero library, capture a page with the connector, or drop a file into a watched folder.'
          }
        />
      </div>
    );
  }

  return (
    <div className="item-list">
      <ListToolbar order={order} onOrderChange={onOrderChange} total={page?.total} loaded={rows.length} />

      <div className="item-list__scroller" ref={scrollRef} data-testid="item-list-scroller">
        <div
          className="item-list__sizer"
          style={{ height: `${virtualiser.getTotalSize()}px` }}
          role="listbox"
          aria-label="Items"
        >
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (row === undefined) return null;
            const selected = row.id === selectedItemId;
            return (
              <div
                key={row.id}
                className="item-row"
                role="option"
                aria-selected={selected}
                data-testid={`item-row-${row.id}`}
                data-selected={selected ? 'true' : 'false'}
                data-focus-target={selected ? 'true' : undefined}
                tabIndex={selected ? 0 : -1}
                style={{
                  position: 'absolute',
                  insetInlineStart: 0,
                  insetInlineEnd: 0,
                  top: 0,
                  height: `${ROW_HEIGHT}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={() => onSelect(row.id)}
                onDoubleClick={() => onOpen(row.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  onOpen(row.id);
                }}
              >
                <span className="item-row__title">{row.title ?? 'Untitled item'}</span>
                <span className="item-row__creators">{row.creatorSummary ?? '—'}</span>
                <span className="item-row__meta">
                  <span className="badge badge--quiet">{row.itemType}</span>
                  {row.issuedYear === null || row.issuedYear === undefined ? null : <span>{row.issuedYear}</span>}
                  {row.containerTitle === null || row.containerTitle === undefined ? null : (
                    <span className="item-row__container">{row.containerTitle}</span>
                  )}
                  {row.attachmentCount === 0 ? null : (
                    <span className="badge badge--quiet">{row.attachmentCount} files</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <footer className="item-list__footer">
        <span>
          {rows.length} loaded
          {page?.total === undefined ? '' : ` of ${page.total}`}
        </span>
        {hasNextPage ? (
          <button type="button" className="button" onClick={onLoadMore} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        ) : (
          <span className="item-list__end">End of the list</span>
        )}
      </footer>
    </div>
  );
};

interface ListToolbarProps {
  order: 'asc' | 'desc';
  onOrderChange: (order: 'asc' | 'desc') => void;
  total?: number;
  loaded: number;
}

/**
 * The list controls.
 *
 * One control, because the API has one ordering: `(dateModified, id)`, reversible. There is no
 * "sort by title" to offer — `GET /api/v1/items` does not accept a sort field, and it does not
 * accept one because the cursor is built from the sort key and a non-total order loses rows.
 */
const ListToolbar = ({ order, onOrderChange, total, loaded }: ListToolbarProps): JSX.Element => (
  <div className="item-list__toolbar">
    <span className="item-list__sort">Ordered by when the item last changed</span>
    <button
      type="button"
      className="button button--small"
      aria-label={order === 'desc' ? 'Sort oldest first' : 'Sort newest first'}
      onClick={() => onOrderChange(order === 'desc' ? 'asc' : 'desc')}
    >
      {order === 'desc' ? 'Newest first' : 'Oldest first'}
    </button>
    <span className="item-list__count">
      {/* `total` is absent, not zero, when the server cannot count cheaply. */}
      {total === undefined ? `${loaded} loaded` : `${loaded} of ${total}`}
    </span>
  </div>
);

export interface ItemListContainerProps
  extends Omit<
    ItemListProps,
    'rows' | 'page' | 'hasNextPage' | 'isFetchingNextPage' | 'onLoadMore'
  > {
  query: ItemListQuery;
  /** Lifted so the pane's keyboard handlers can move the selection through the loaded rows. */
  onRowsChange?: (rows: readonly ItemSummary[]) => void;
  /**
   * Handed the "fetch the next page" function, so that the shortcut map can bind `m` to it without
   * the pane above having to own the query.
   */
  onLoadMoreReady?: (loadMore: () => void) => void;
}

/** The list, wired to the API. Split from the presentation so neither has to know the other's job. */
export const ItemListContainer = ({
  query,
  onRowsChange,
  onLoadMoreReady,
  ...rest
}: ItemListContainerProps): JSX.Element => {
  const list = useItemList(query);

  const rows = useMemo(
    () => (list.data?.pages ?? []).flatMap((page) => page.data),
    [list.data],
  );

  // Depends on the three values rather than on the query object, which is new on every render: a
  // `loadMore` whose identity changed each time would re-run the fetch-ahead effect each time too.
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = list;
  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  useEffect(() => {
    onRowsChange?.(rows);
  }, [rows, onRowsChange]);

  useEffect(() => {
    onLoadMoreReady?.(loadMore);
  }, [loadMore, onLoadMoreReady]);

  if (list.isPending) return <LoadingState label="Loading the library…" />;
  if (list.isError) {
    return <ErrorState label="Could not load the library" error={list.error} onRetry={() => void list.refetch()} />;
  }

  const lastPage = list.data.pages[list.data.pages.length - 1];

  return (
    <ItemList
      {...rest}
      rows={rows}
      page={lastPage?.page}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadMore={loadMore}
    />
  );
};
