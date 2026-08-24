/**
 * The route tree.
 *
 * Declared in code rather than generated from the filesystem: a handful of routes do not need a
 * build step, and a generated `routeTree.gen.ts` is a file that has to be regenerated, committed
 * and kept in step with the checkout for no gain at this size.
 *
 * `/share` is the odd one out and is meant to be. It is the target of the manifest's `share_target`
 * (`public/manifest.webmanifest`), so its path is a contract with the operating system rather than
 * a choice: changing it changes where a share sheet posts, and the service worker's routing table
 * has to change with it.
 */
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';

import { LibraryRoute, validateLibrarySearch } from './routes/library.js';
import type { LibrarySearch } from './routes/library.js';
import { ReaderRoute } from './routes/reader.js';
import { ReviewRoute, validateReviewSearch } from './routes/review.js';
import type { ReviewSearch } from './routes/review.js';
import { RootLayout } from './routes/root.js';
import { RulesRoute, validateRulesSearch } from './routes/rules.js';
import type { RulesSearch } from './routes/rules.js';
import { ShareRoute, validateShareSearch } from './routes/share.js';
import type { ShareSearch } from './routes/share.js';
import { SourcesRoute, validateSourcesSearch } from './routes/sources.js';
import type { SourcesSearch } from './routes/sources.js';

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

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/review',
  component: ReviewRoute,
  validateSearch: (search: Record<string, unknown>): ReviewSearch => validateReviewSearch(search),
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sources',
  component: SourcesRoute,
  validateSearch: (search: Record<string, unknown>): SourcesSearch => validateSourcesSearch(search),
});

const rulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/rules',
  component: RulesRoute,
  validateSearch: (search: Record<string, unknown>): RulesSearch => validateRulesSearch(search),
});

const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/share',
  component: ShareRoute,
  validateSearch: (search: Record<string, unknown>): ShareSearch => validateShareSearch(search),
});

export const routeTree = rootRoute.addChildren([
  libraryRoute,
  readerRoute,
  reviewRoute,
  sourcesRoute,
  rulesRoute,
  shareRoute,
]);

export const createAppRouter = () => createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
