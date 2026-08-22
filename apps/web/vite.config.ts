/**
 * The build and the development server.
 *
 * The proxy is the only thing here with an opinion. In production the SPA is served by the Fastify
 * app itself, so `/api/v1` and `/health` are same-origin and no proxy exists; in development Vite
 * serves the client on 5173 and the server runs on 3000, and the proxy makes the two look
 * same-origin so that the client never has to carry a base URL, a CORS mode or a cookie policy
 * that only exists in development (CONCEPT.md §5.15).
 */
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
    // PDF.js is large and only the reader route needs it, so it gets a chunk of its own rather
    // than being pulled into the entry the library view loads.
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
        },
      },
    },
  },
});
