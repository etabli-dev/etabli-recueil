/**
 * The route tree.
 *
 * Declared in code rather than generated from the filesystem: two routes do not need a build step,
 * and a generated `routeTree.gen.ts` is a file that has to be regenerated, committed and kept in
 * step with the checkout for no gain at this size.
 */
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';

import { LibraryRoute, validateLibrarySearch } from './routes/library.js';
import type { LibrarySearch } from './routes/library.js';
import { ReaderRoute } from './routes/reader.js';
import { RootLayout } from './routes/root.js';

const rootRoute = createRootRoute({ component: RootLayout });

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LibraryRoute,
  validateSearch: (search: Record<string, unknown>): LibrarySearch => validateLibrarySearch(search),
});

const readerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reader/$attachmentId',
  component: ReaderRoute,
});

export const routeTree = rootRoute.addChildren([libraryRoute, readerRoute]);

export const createAppRouter = () => createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
