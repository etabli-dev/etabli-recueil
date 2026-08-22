/**
 * The application, assembled.
 *
 * Composition happens here and nowhere else: the client, the query cache, the focus manager, the
 * core item-pane sections and the router. A test can build any subset of this without touching the
 * others, which is the whole reason the pieces take their collaborators as arguments.
 */
import { RouterProvider } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';

import { ApiProvider } from './api/context.js';
import type { RecueilClient } from './api/client.js';
import { FocusManager } from './keyboard/focus.js';
import { registerCoreSections } from './item-pane/sections/index.js';
import { createAppRouter } from './router.js';

registerCoreSections();

export interface AppProps {
  client: RecueilClient;
  queryClient?: QueryClient;
  router?: ReturnType<typeof createAppRouter>;
}

export const App = ({ client, queryClient, router = createAppRouter() }: AppProps): JSX.Element => (
  <ApiProvider client={client} queryClient={queryClient}>
    <FocusManager>
      <RouterProvider router={router} />
    </FocusManager>
  </ApiProvider>
);
