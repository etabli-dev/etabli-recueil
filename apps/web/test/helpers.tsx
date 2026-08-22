/**
 * Rendering a component with the application's providers, and nothing else.
 *
 * Retries are off and the cache is fresh per test: a retry turns an assertion about one failed
 * request into a five-second wait, and a shared cache turns test order into a dependency.
 */
import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

import { ApiProvider } from '../src/api/context.js';
import { RecueilClient } from '../src/api/client.js';
import type { FakeServer } from './fake-server.js';

export interface RenderedWithApi extends RenderResult {
  client: RecueilClient;
  queryClient: QueryClient;
}

export const renderWithApi = (ui: ReactElement, server: FakeServer): RenderedWithApi => {
  const client = new RecueilClient({ fetch: server.fetch });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  const result = render(<ApiProvider client={client} queryClient={queryClient}>{ui}</ApiProvider>);
  return { ...result, client, queryClient };
};
