import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // The host tests build real libraries and load real plugin modules from temp directories;
    // one file at a time keeps the module cache and the temp trees accountable.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
