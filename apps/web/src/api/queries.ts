/**
 * The query and mutation hooks.
 *
 * Every key is built by `queryKeys`, so that an invalidation after a write cannot miss a cache
 * entry because two call sites spelled the same key differently. Keys are hierarchical for the
 * same reason: invalidating `queryKeys.items()` invalidates every list, every filter and every
 * page of them, which is exactly what an edit to an item's title has to do.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { UseInfiniteQueryResult, UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import type {
  Attachment,
  Collection,
  CustomField,
  FieldPath,
  FieldValue,
  HealthResponse,
  Item,
  ItemSummary,
  ItemUpdate,
  Note,
  Page,
  Tag,
} from '@recueil/schemas';

import { useApiClient } from './context.js';
import type { ItemListQuery } from './client.js';
import type { ApiError } from './problem.js';

export const queryKeys = {
  health: () => ['health'] as const,
  items: () => ['items'] as const,
  itemList: (query: ItemListQuery) => ['items', 'list', query] as const,
  item: (id: string) => ['items', 'detail', id] as const,
  collections: () => ['collections'] as const,
  tags: () => ['tags'] as const,
  attachments: (itemId: string) => ['attachments', itemId] as const,
  attachment: (id: string) => ['attachments', 'detail', id] as const,
  notes: (itemId: string) => ['notes', itemId] as const,
  customFields: () => ['fields'] as const,
  fieldValues: (itemId: string) => ['field-values', itemId] as const,
} as const;

export const useHealth = (): UseQueryResult<HealthResponse, ApiError> => {
  const client = useApiClient();
  return useQuery<HealthResponse, ApiError>({
    queryKey: queryKeys.health(),
    queryFn: ({ signal }) => client.getHealth(signal),
  });
};

/**
 * The item list, cursor-paginated.
 *
 * Cursors, not offsets: a page boundary computed from a row count is wrong the moment anything is
 * inserted before it, and a library is exactly the kind of set that is being written to while it
 * is read (`packages/schemas/src/envelopes/pagination.ts`). The end condition is the absence of a
 * cursor, never an empty page.
 */
export const useItemList = (
  query: ItemListQuery,
): UseInfiniteQueryResult<{ pages: Page<ItemSummary>[]; pageParams: unknown[] }, ApiError> => {
  const client = useApiClient();
  return useInfiniteQuery<Page<ItemSummary>, ApiError, { pages: Page<ItemSummary>[]; pageParams: unknown[] }, readonly unknown[], string | undefined>({
    queryKey: queryKeys.itemList(query),
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      client.listItems(pageParam === undefined ? query : { ...query, cursor: pageParam }, signal),
    getNextPageParam: (lastPage) => lastPage.page.nextCursor ?? undefined,
  });
};

export const useItem = (id: string | null): UseQueryResult<Item, ApiError> => {
  const client = useApiClient();
  return useQuery<Item, ApiError>({
    queryKey: queryKeys.item(id ?? ''),
    queryFn: ({ signal }) => client.getItem(id as string, { signal }),
    enabled: id !== null,
  });
};

export const useCollections = (): UseQueryResult<Page<Collection>, ApiError> => {
  const client = useApiClient();
  return useQuery<Page<Collection>, ApiError>({
    queryKey: queryKeys.collections(),
    queryFn: ({ signal }) => client.listCollections(signal),
  });
};

export const useTags = (): UseQueryResult<Page<Tag>, ApiError> => {
  const client = useApiClient();
  return useQuery<Page<Tag>, ApiError>({
    queryKey: queryKeys.tags(),
    queryFn: ({ signal }) => client.listTags(signal),
  });
};

export const useAttachment = (id: string | null): UseQueryResult<Attachment, ApiError> => {
  const client = useApiClient();
  return useQuery<Attachment, ApiError>({
    queryKey: queryKeys.attachment(id ?? ''),
    queryFn: ({ signal }) => client.getAttachment(id as string, signal),
    enabled: id !== null,
  });
};

export const useNotes = (itemId: string | null): UseQueryResult<Page<Note>, ApiError> => {
  const client = useApiClient();
  return useQuery<Page<Note>, ApiError>({
    queryKey: queryKeys.notes(itemId ?? ''),
    queryFn: ({ signal }) => client.listNotes(itemId as string, signal),
    enabled: itemId !== null,
  });
};

export const useCustomFields = (): UseQueryResult<Page<CustomField>, ApiError> => {
  const client = useApiClient();
  return useQuery<Page<CustomField>, ApiError>({
    queryKey: queryKeys.customFields(),
    queryFn: ({ signal }) => client.listCustomFields(signal),
  });
};

export const useFieldValues = (itemId: string | null): UseQueryResult<Page<FieldValue>, ApiError> => {
  const client = useApiClient();
  return useQuery<Page<FieldValue>, ApiError>({
    queryKey: queryKeys.fieldValues(itemId ?? ''),
    queryFn: ({ signal }) => client.listFieldValues(itemId as string, signal),
    enabled: itemId !== null,
  });
};

export interface UpdateItemVariables {
  patch: ItemUpdate;
  /** Sent as `If-Match`. A stale write is rejected, not merged (P1). */
  expectedVersion?: number;
}

/**
 * Write to an item.
 *
 * The response is seeded into the detail cache rather than triggering a refetch, because the
 * server returns the item it actually wrote — including the provenance rows and locks the write
 * created (P4-1), which is the part the item pane has to redraw. The lists are invalidated because
 * a title change reorders them.
 */
export const useUpdateItem = (
  itemId: string,
): UseMutationResult<Item, ApiError, UpdateItemVariables> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<Item, ApiError, UpdateItemVariables>({
    mutationFn: ({ patch, expectedVersion }) => client.updateItem(itemId, patch, expectedVersion),
    onSuccess: (item) => {
      queryClient.setQueryData(queryKeys.item(itemId), item);
      void queryClient.invalidateQueries({ queryKey: queryKeys.items() });
    },
  });
};

/**
 * Release manual locks so resolvers may write the fields again (P4-2).
 *
 * `DELETE /items/{id}/locks/{fieldPath}` addresses one lock and answers `204`, so releasing two
 * fields is two requests and neither returns the item. The mutation therefore refetches the item
 * once, at the end, rather than seeding the cache from a response that does not exist.
 */
export const useUnlockFields = (
  itemId: string,
): UseMutationResult<Item, ApiError, readonly FieldPath[]> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<Item, ApiError, readonly FieldPath[]>({
    mutationFn: async (fields) => {
      for (const field of fields) await client.unlockField(itemId, field);
      const item = await client.getItem(itemId);
      return item;
    },
    onSuccess: (item) => {
      queryClient.setQueryData(queryKeys.item(itemId), item);
    },
  });
};
