/**
 * The build and the development server.
 *
 * The proxy is the only thing here with an opinion. In development Vite serves the client on 5173
 * and the server runs on 3000, and the proxy makes the two look same-origin so that the client
 * never has to carry a base URL, a CORS mode or a cookie policy that only exists in development
 * (CONCEPT.md §5.15).
 *
 * **In production the built assets are not served by anything in this repository yet.** An earlier
 * comment here said the Fastify application serves them; it does not — `apps/server` has no
 * static-file plugin and no route for `dist/`. Until it has one, a deployment puts `dist/` behind
 * its own web server or reverse proxy, on the same origin as the API so that the assumption above
 * still holds. Serving the SPA from the server is Phase 2 work.
 */
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Where `recueil serve` listens by default (apps/server/src/config.ts). */
const SERVER_ORIGIN = process.env.RECUEIL_SERVER_ORIGIN ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: SERVER_ORIGIN, changeOrigin: false },
      '/health': { target: SERVER_ORIGIN, changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      '/api': { target: SERVER_ORIGIN, changeOrigin: false },
      '/health': { target: SERVER_ORIGIN, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      // Two entries. The service worker is a second one rather than a file copied out of `public/`
      // because it is TypeScript that shares `src/pwa/share-protocol.ts` with the page: the worker
      // stashes a shared file and the page reads it back, and the two agreeing about the cache key
      // is a property worth having the compiler check.
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        'service-worker': fileURLToPath(new URL('src/pwa/service-worker.ts', import.meta.url)),
      },
      output: {
        // The worker's URL is registered by name and remembered by the browser, so it is the one
        // build output that must not be content-hashed. Everything else is, which is what lets the
        // worker cache `/assets/` first and ask the network second.
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js',
        // PDF.js is large and only the reader route needs it, so it gets a chunk of its own rather
        // than being pulled into the entry the library view loads.
        manualChunks: (id) => (id.includes('pdfjs-dist') ? 'pdfjs' : undefined),
      },
    },
  },
});
