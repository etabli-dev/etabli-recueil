import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // Every test in here spawns a real `recueil` process, and the serve test binds a socket and
    // writes a SQLite file in a temp directory. Serialised so that a failure names one file rather
    // than an interleaving of four.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
