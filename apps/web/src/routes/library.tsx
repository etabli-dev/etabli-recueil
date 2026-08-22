/**
 * The library route.
 *
 * Everything the middle pane is showing lives in the URL: the scope, the selected item, the sort
 * and the search text. That is not tidiness — it is what makes "the items tagged `to-read`, sorted
 * by year" a link, makes the back button behave, and gives the `recueil://` deep links of
 * CONCEPT.md §5.14 something to point at.
 */
import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';

import { useApiClient } from '../api/context.js';
import { queryKeys } from '../api/queries.js';
import { LibraryView } from '../library/library-view.js';
import type { LibraryViewState } from '../library/library-view.js';
import { LIBRARY_SCOPE } from '../library/scope.js';
import type { LibraryScope } from '../library/scope.js';
import { isReadable } from '../item-pane/sections/attachments.js';

export interface LibrarySearch {
  /** `library`, `collection:<id>` or `tag:<id>` — the same string `scopeKey` produces. */
  scope: string;
  item?: string;
  /**
   * The direction of the one ordering the API has.
   *
   * There is no sort *field* in the URL because there is none on the wire: `GET /api/v1/items` is
   * ordered by `(dateModified, id)` and takes `order` alone, because that pair is what makes the
   * cursor total. A `?sort=title` in a bookmark would be a promise the server cannot keep.
   */
  order: 'asc' | 'desc';
  q?: string;
}

/** Search parameters are user input like any other: unknown values fall back, they do not throw. */
export const validateLibrarySearch = (raw: Record<string, unknown>): LibrarySearch => {
  const search: LibrarySearch = {
    scope: typeof raw.scope === 'string' && raw.scope !== '' ? raw.scope : 'library',
    order: raw.order === 'asc' ? 'asc' : 'desc',
  };
  if (typeof raw.item === 'string' && raw.item !== '') search.item = raw.item;
  if (typeof raw.q === 'string' && raw.q !== '') search.q = raw.q;
  return search;
};

export const parseScope = (value: string): LibraryScope => {
  const [kind, id] = value.split(':');
  if (kind === 'collection' && id !== undefined && id !== '') return { kind: 'collection', collectionId: id };
  if (kind === 'tag' && id !== undefined && id !== '') return { kind: 'tag', tagId: id };
  return LIBRARY_SCOPE;
};

export const serialiseScope = (scope: LibraryScope): string => {
  switch (scope.kind) {
    case 'collection':
      return `collection:${scope.collectionId}`;
    case 'tag':
      return `tag:${scope.tagId}`;
    default:
      return 'library';
  }
};

export const LibraryRoute = (): JSX.Element => {
  const search = useSearch({ strict: false }) as LibrarySearch;
  const navigate = useNavigate();
  const client = useApiClient();
  const queryClient = useQueryClient();

  const state: LibraryViewState = {
    scope: parseScope(search.scope ?? 'library'),
    selectedItemId: search.item ?? null,
    order: search.order ?? 'desc',
    text: search.q ?? '',
  };

  const onStateChange = useCallback(
    (change: Partial<LibraryViewState>) => {
      void navigate({
        to: '/',
        search: (previous: Record<string, unknown>): LibrarySearch => {
          const current = validateLibrarySearch(previous);
          const next: LibrarySearch = {
            scope: change.scope === undefined ? current.scope : serialiseScope(change.scope),
            order: change.order ?? current.order,
          };
          const item = change.selectedItemId === undefined ? current.item : change.selectedItemId ?? undefined;
          if (item !== undefined && item !== null) next.item = item;
          const text = change.text === undefined ? current.q : change.text;
          if (text !== undefined && text.trim() !== '') next.q = text;
          return next;
        },
        replace: true,
      });
    },
    [navigate],
  );

  /**
   * Open an item in the reader.
   *
   * The reader addresses an attachment, not an item, because an item may hold a scan, a supplement
   * and a snapshot at once. So this resolves the item's first readable attachment and navigates
   * there; an item with nothing readable selects rather than navigating, which is the honest
   * outcome — there is nothing to show.
   */
  const onOpenItem = useCallback(
    (itemId: string) => {
      void (async () => {
        const item = await queryClient.fetchQuery({
          queryKey: queryKeys.item(itemId),
          queryFn: ({ signal }) => client.getItem(itemId, { signal }),
        });
        const attachment = (item.attachments ?? []).find(isReadable);
        if (attachment === undefined) {
          onStateChange({ selectedItemId: itemId });
          return;
        }
        void navigate({ to: '/reader/$attachmentId', params: { attachmentId: attachment.id } });
      })();
    },
    [client, queryClient, navigate, onStateChange],
  );

  return <LibraryView state={state} onStateChange={onStateChange} onOpenItem={onOpenItem} />;
};
