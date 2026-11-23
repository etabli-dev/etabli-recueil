/**
 * Assemble what the app serves: `apps/mobile/www/`.
 *
 * 1. A copy of the web client's production build (`apps/web/dist/`), without source maps.
 * 2. The shell's pages, built by Vite into `www/shell/`.
 * 3. The host script added to the copied `index.html` ahead of the web client's entry, so that
 *    `globalThis.recueilHost` exists when the client asks for it. The web build is not changed.
 *
 * Then `cap sync` copies `www/` into the native projects. It fails loudly when the web build is
 * missing: `pnpm --filter "@recueil/mobile..." run build` builds the web client first.
 */
import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const mobileRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const webDist = join(dirname(require.resolve('@recueil/web/package.json')), 'dist');
const outDir = join(mobileRoot, 'www');
const HOST_TAG = '<script type="module" src="/shell/host.js"></script>';

const exists = async (path) => stat(path).then(() => true, () => false);

if (!(await exists(join(webDist, 'index.html')))) {
  console.error(`assemble: ${join(webDist, 'index.html')} does not exist.\nBuild the web client first: pnpm --filter "@recueil/mobile..." run build`);
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await cp(webDist, outDir, { recursive: true, filter: (source) => !source.endsWith('.map') });
await build({ configFile: join(mobileRoot, 'vite.config.ts'), logLevel: 'warn' });

const indexPath = join(outDir, 'index.html');
const index = await readFile(indexPath, 'utf8');
const entry = /<script type="module"[^>]*\ssrc="\/assets\/[^"]+"[^>]*><\/script>/u.exec(index);
if (entry === null) {
  console.error('assemble: the web client index.html has no module entry script to load the host ahead of.');
  process.exit(1);
}
await writeFile(indexPath, index.replace(entry[0], `${HOST_TAG}\n    ${entry[0]}`));
console.log(`assemble: ${outDir} ready for cap sync`);
