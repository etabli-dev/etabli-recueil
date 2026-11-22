/**
 * Build the extension for each browser: `dist/chrome/` and `dist/firefox/`, plus zip-ready trees.
 *
 * tsc has already compiled `src/` to `dist/js/`. This copies that and the static files into one
 * directory per browser with the manifest that browser wants: Chromium runs the background as a
 * module service worker; Firefox's MV3 takes `background.scripts` and a gecko id. Safari takes the
 * Chromium build through `xcrun safari-web-extension-converter` on a Mac (README).
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const STATIC = ['popup.html', 'popup.css', 'options.html'];

const targets = {
  chrome: manifest,
  firefox: {
    ...manifest,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: { gecko: { id: 'connector@recueil.etabli.dev', strict_min_version: '128.0' } },
    minimum_chrome_version: undefined,
  },
};

for (const [name, content] of Object.entries(targets)) {
  const out = join(root, 'dist', name);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(join(root, 'dist', 'js'), out, { recursive: true, filter: (source) => !source.endsWith('.d.ts') && !source.endsWith('.map') });
  for (const file of STATIC) await cp(join(root, 'src', file), join(out, file));
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(content, null, 2)}\n`);
  console.log(`connector: dist/${name}`);
}
