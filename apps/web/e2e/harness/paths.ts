/**
 * Where things are on disk, resolved from this file rather than from the working directory.
 *
 * Playwright may be invoked from the package or from the repository root, and a relative path that
 * silently resolves to the wrong `dist/` is the kind of failure that looks like a bug in the
 * application.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** `apps/web`. */
export const webPackageRoot = resolve(here, '..', '..');

/** The monorepo root. */
export const repositoryRoot = resolve(webPackageRoot, '..', '..');

/** The built SPA the browser is served. Produced by `pnpm --filter @recueil/web build`. */
export const webDistDirectory = join(webPackageRoot, 'dist');

/** The client source the bundle is built from, for the staleness check in `spa-server.ts`. */
export const webSourceDirectory = join(webPackageRoot, 'src');
