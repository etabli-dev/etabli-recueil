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
import type { ItemListQuery, LockFacet } from './client.js';
import type {
  IngestionJobDetail,
  IngestionSource,
  IngestionSourceCreate,
  IngestionSourceUpdate,
  ReviewAcceptRequest,
  ReviewAcceptResult,
  ReviewEntry,
  ReviewListQuery,
  Rule,
  RuleCreate,
  RuleDryRunRequest,
  RuleDryRunResponse,
  RuleUpdate,
  SourceRunAccepted,
  TestConnectionResult,
} from './ingestion.js';
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
  reviewQueue: () => ['review'] as const,
  reviewList: (query: ReviewListQuery) => ['review', 'list', query] as const,
  reviewEntry: (id: string) => ['review', 'detail', id] as const,
  sources: () => ['ingestion-sources'] as const,
  source: (id: string) => ['ingestion-sources', 'detail', id] as const,
  job: (id: string) => ['ingestion-jobs', id] as const,
  rules: () => ['rules'] as const,
  rule: (id: string) => ['rules', 'detail', id] as const,
  document: (id: string) => ['documents', id] as const,
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
  /** Which facet's locks. The server defaults to bibliographic, so the office pane must say so. */
  facet?: LockFacet,
): UseMutationResult<Item, ApiError, readonly FieldPath[]> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<Item, ApiError, readonly FieldPath[]>({
    mutationFn: async (fields) => {
      for (const field of fields) await client.unlockField(itemId, field, facet);
      const item = await client.getItem(itemId);
      return item;
    },
    onSuccess: (item) => {
      queryClient.setQueryData(queryKeys.item(itemId), item);
    },
  });
};

/* -------------------------------------------------------------------------------------------- */
/* The review queue                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * The queue.
 *
 * `staleTime: 0` and a refetch on focus, because this list is written to by something that is not
 * the user: a source run inserts entries while the workspace is open, and a review queue showing
 * yesterday's backlog is worse than one showing none. There is no cursor on this endpoint — it
 * pages by `limit` and reports `hasMore` from the page being full — so a plain query, not an
 * infinite one, is what the contract supports.
 */
export const useReviewQueue = (query: ReviewListQuery): UseQueryResult<Page<ReviewEntry>, ApiError> => {
  const client = useApiClient();
  return useQuery<Page<ReviewEntry>, ApiError>({
    queryKey: queryKeys.reviewList(query),
    queryFn: ({ signal }) => client.listReviewEntries(query, signal),
    staleTime: 0,
  });
};

export const useReviewEntry = (id: string | null): UseQueryResult<ReviewEntry, ApiError> => {
  const client = useApiClient();
  return useQuery<ReviewEntry, ApiError>({
    queryKey: queryKeys.reviewEntry(id ?? ''),
    queryFn: ({ signal }) => client.getReviewEntry(id as string, signal),
    enabled: id !== null,
  });
};

export interface ResolveReviewVariables {
  id: string;
  decision: 'accept' | 'reject';
  note?: string;
  /** Present only on `accept`, and only when the reviewer corrected the proposal (§6.1 RQ1). */
  edits?: ReviewAcceptRequest['edits'];
}

/** What a resolution turned out to be, in one shape whichever decision it was. */
export interface ReviewResolution {
  entry: ReviewEntry;
  decision: 'accept' | 'reject';
  /** Set when accepting created an item. The only thing an undo can act on afterwards. */
  itemId: string | null;
  attachmentId: string | null;
  warnings: string[];
}

/**
 * Accept or reject one entry.
 *
 * Both invalidate the whole queue rather than removing the row by hand: accepting an entry may
 * supersede others (RQ2 — the missing file reappeared), and a client that only knew about the row
 * it touched would leave those on screen. The library lists go too, because an acceptance that
 * created an item changed them.
 */
export const useResolveReviewEntry = (): UseMutationResult<
  ReviewResolution,
  ApiError,
  ResolveReviewVariables
> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<ReviewResolution, ApiError, ResolveReviewVariables>({
    mutationFn: async ({ id, decision, note, edits }) => {
      if (decision === 'reject') {
        const entry = await client.rejectReviewEntry(id, note === undefined ? {} : { note });
        return { entry, decision, itemId: null, attachmentId: null, warnings: [] };
      }
      const result: ReviewAcceptResult = await client.acceptReviewEntry(id, {
        ...(note === undefined ? {} : { note }),
        ...(edits === undefined ? {} : { edits }),
      });
      return {
        entry: result.entry,
        decision,
        itemId: result.itemId,
        attachmentId: result.attachmentId,
        warnings: result.warnings,
      };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reviewQueue() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.items() });
    },
  });
};

/**
 * Trash an item an acceptance created.
 *
 * This is the *whole* of what can be reversed once an acceptance has been sent. There is no reopen
 * on the review queue — the server refuses to accept or reject anything that is not `open` — so the
 * entry stays accepted and the item goes to the trash, where it can be restored (P5). The workspace
 * says exactly that rather than calling it an undo.
 */
export const useTrashItem = (): UseMutationResult<void, ApiError, { itemId: string; reason: string }> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, { itemId: string; reason: string }>({
    mutationFn: ({ itemId, reason }) => client.trashItem(itemId, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.items() });
    },
  });
};

/**
 * The run that raised an entry, with its stage trace.
 *
 * `GET /ingestion/queue/{id}` reads `ingest_checkpoints`, which is the same table a resumed run
 * reads — so the trace a reviewer sees and the point the run would restart from cannot disagree.
 */
export const useIngestionJob = (id: string | null): UseQueryResult<IngestionJobDetail, ApiError> => {
  const client = useApiClient();
  return useQuery<IngestionJobDetail, ApiError>({
    queryKey: queryKeys.job(id ?? ''),
    queryFn: ({ signal }) => client.getIngestionJob(id as string, signal),
    enabled: id !== null,
    // A run is asynchronous: the request that starts it returns before it has done anything, so the
    // first read of it almost always shows a job with no result yet. Polling stops as soon as the
    // job has a `finishedAt`, which is what makes this a progress display rather than a permanent
    // timer on an idle screen. `waiting_review` counts as finished — the run is over and waiting on
    // a human (IK6), and nothing further will change until one acts.
    refetchInterval: (query) => (query.state.data?.job.finishedAt === null ? 2_000 : false),
    staleTime: 0,
  });
};

/* -------------------------------------------------------------------------------------------- */
/* Sources                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export const useIngestionSources = (): UseQueryResult<Page<IngestionSource>, ApiError> => {
  const client = useApiClient();
  return useQuery<Page<IngestionSource>, ApiError>({
    queryKey: queryKeys.sources(),
    queryFn: ({ signal }) => client.listIngestionSources(signal),
    // A run started elsewhere changes `lastRunAt` and `lastError` on the row, and those are two of
    // the four things this screen exists to show.
    refetchInterval: 15_000,
    staleTime: 0,
  });
};

export const useCreateIngestionSource = (): UseMutationResult<
  IngestionSource,
  ApiError,
  IngestionSourceCreate
> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<IngestionSource, ApiError, IngestionSourceCreate>({
    mutationFn: (body) => client.createIngestionSource(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.sources() }),
  });
};

export const useUpdateIngestionSource = (
  id: string,
): UseMutationResult<IngestionSource, ApiError, IngestionSourceUpdate> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<IngestionSource, ApiError, IngestionSourceUpdate>({
    mutationFn: (body) => client.updateIngestionSource(id, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.sources() }),
  });
};

export const useDeleteIngestionSource = (): UseMutationResult<void, ApiError, string> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => client.deleteIngestionSource(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.sources() }),
  });
};

/** Probe the far side. The result is mutation state, not cached: a test is an event, not a fact. */
export const useTestIngestionSource = (): UseMutationResult<TestConnectionResult, ApiError, string> => {
  const client = useApiClient();
  return useMutation<TestConnectionResult, ApiError, string>({
    mutationFn: (id) => client.testIngestionSource(id),
  });
};

export const useRunIngestionSource = (): UseMutationResult<SourceRunAccepted, ApiError, string> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<SourceRunAccepted, ApiError, string>({
    mutationFn: (id) => client.runIngestionSource(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sources() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.reviewQueue() });
    },
  });
};

/* -------------------------------------------------------------------------------------------- */
/* Rules                                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * The rule table.
 *
 * The server returns it in evaluation order — ascending priority then rule id — so a list rendered
 * from this predicts precedence rather than merely listing.
 */
export const useRules = (kind?: 'ingestion' | 'dedup'): UseQueryResult<Page<Rule>, ApiError> => {
  const client = useApiClient();
  return useQuery<Page<Rule>, ApiError>({
    queryKey: [...queryKeys.rules(), kind ?? 'all'],
    queryFn: ({ signal }) => client.listRules(kind === undefined ? {} : { kind }, signal),
  });
};

export const useCreateRule = (): UseMutationResult<Rule, ApiError, RuleCreate> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<Rule, ApiError, RuleCreate>({
    mutationFn: (body) => client.createRule(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.rules() }),
  });
};

export const useUpdateRule = (): UseMutationResult<Rule, ApiError, { id: string; body: RuleUpdate }> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<Rule, ApiError, { id: string; body: RuleUpdate }>({
    mutationFn: ({ id, body }) => client.updateRule(id, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.rules() }),
  });
};

export const useDeleteRule = (): UseMutationResult<void, ApiError, string> => {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => client.deleteRule(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.rules() }),
  });
};

/** The dry run is a mutation because it is a request with a body, not because it writes. It does not. */
export const useDryRunRules = (): UseMutationResult<RuleDryRunResponse, ApiError, RuleDryRunRequest> => {
  const client = useApiClient();
  return useMutation<RuleDryRunResponse, ApiError, RuleDryRunRequest>({
    mutationFn: (body) => client.dryRunRules(body),
  });
};
