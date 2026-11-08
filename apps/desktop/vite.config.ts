/**
 * The shell's own pages: the connection page and the host script.
 *
 * They are built into `dist/shell/`, beside a copy of the web client's `dist/`, by
 * `scripts/assemble.mjs` — which is what runs this, so it is not a development server
 * configuration. Two entries:
 *
 * - `connect.html`, the page the window opens on. It checks the configured server and hands over
 *   to the web client, or explains why it cannot.
 * - `host.ts`, emitted under the fixed name `host.js` because the assembled `index.html` loads it
 *   by that name, ahead of the web client's own entry (`apps/web/src/host.ts`).
 */
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('shell'),
  base: '/shell/',
  // No `public/`: everything the pages load is imported, so it is hashed and nothing is copied.
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: here('dist/shell'),
    emptyOutDir: true,
    sourcemap: false,
    // The web client's assets are copied, not inlined; the shell's are small enough not to care.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        connect: here('shell/connect.html'),
        host: here('shell/host.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'host' ? 'host.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
