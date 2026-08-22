/**
 * The client, and the query cache, as context.
 *
 * One `RecueilClient` per application, provided rather than imported, so that a test — or the
 * desktop shell talking to its sidecar on a different port — can substitute one without any
 * component knowing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

import { RecueilClient } from './client.js';
import { ApiError } from './problem.js';

const ClientContext = createContext<RecueilClient | null>(null);

/**
 * Query defaults.
 *
 * Retrying a 4xx is pointless — the request was wrong and will be wrong again — and retrying a
 * write is worse than pointless without an idempotency key, so both are off. A library is a set
 * that changes under you (an ingestion run inserts rows the whole time), so a page is stale as
 * soon as it is fetched and refetched on focus.
 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });

export interface ApiProviderProps {
  client: RecueilClient;
  queryClient?: QueryClient;
  children: ReactNode;
}

export const ApiProvider = ({ client, queryClient, children }: ApiProviderProps): JSX.Element => {
  const resolved = useMemo(() => queryClient ?? createQueryClient(), [queryClient]);
  return (
    <QueryClientProvider client={resolved}>
      <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
    </QueryClientProvider>
  );
};

export const useApiClient = (): RecueilClient => {
  const client = useContext(ClientContext);
  if (client === null) {
    throw new Error('useApiClient was called outside an <ApiProvider>');
  }
  return client;
};
