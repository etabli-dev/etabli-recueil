/**
 * The shell's own pages — the connection page and the host script — built into `www/shell/` beside
 * a copy of the web client's build. `scripts/assemble.mjs` runs this; it is not a dev server.
 */
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('shell'),
  base: '/shell/',
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: here('www/shell'),
    emptyOutDir: true,
    sourcemap: false,
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
