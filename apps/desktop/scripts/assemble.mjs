/**
 * Assemble what the desktop window serves: `apps/desktop/dist/`.
 *
 * 1. A copy of the web client's production build (`apps/web/dist/`), without source maps — they
 *    are a development aid, and inside an installed application they would only be weight.
 * 2. The shell's own pages, built by Vite into `dist/shell/` (`vite.config.ts`).
 * 3. One line added to the copied `index.html`: the host script, ahead of the web client's entry,
 *    so that `globalThis.recueilHost` exists by the time the client asks for it
 *    (`apps/web/src/host.ts`). The web build itself is not changed.
 *
 * It fails loudly when the web build is missing rather than shipping a window with nothing in it:
 * `pnpm --filter "@recueil/desktop..." run build` builds the web client and its dependencies first,
 * and that is what `tauri build` runs (`src-tauri/tauri.conf.json`).
 */
import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const webRoot = dirname(require.resolve('@recueil/web/package.json'));
const webDist = join(webRoot, 'dist');
const outDir = join(desktopRoot, 'dist');

const HOST_TAG = '<script type="module" src="/shell/host.js"></script>';

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(join(webDist, 'index.html')))) {
  console.error(
    `assemble: ${join(webDist, 'index.html')} does not exist.\n` +
      'Build the web client first: pnpm --filter "@recueil/desktop..." run build',
  );
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await cp(webDist, outDir, {
  recursive: true,
  filter: (source) => !source.endsWith('.map'),
});

await build({ configFile: join(desktopRoot, 'vite.config.ts'), logLevel: 'warn' });

const indexPath = join(outDir, 'index.html');
const index = await readFile(indexPath, 'utf8');
const entry = /<script type="module"[^>]*\ssrc="\/assets\/[^"]+"[^>]*><\/script>/u.exec(index);
if (entry === null) {
  console.error('assemble: the web client index.html has no module entry script to load the host ahead of.');
  process.exit(1);
}
const patched = index.replace(entry[0], `${HOST_TAG}\n    ${entry[0]}`);
await writeFile(indexPath, patched);

for (const required of ['index.html', 'shell/connect.html', 'shell/host.js']) {
  if (!(await exists(join(outDir, required)))) {
    console.error(`assemble: ${required} is missing from ${outDir}.`);
    process.exit(1);
  }
}
const hostTags = patched.split(HOST_TAG).length - 1;
if (hostTags !== 1) {
  console.error(`assemble: index.html loads the host script ${hostTags} times; expected once.`);
  process.exit(1);
}

console.log(`assemble: ${outDir} — the web client, the connection page and the host script.`);
