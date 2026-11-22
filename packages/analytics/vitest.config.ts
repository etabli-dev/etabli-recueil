import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // Analytics tests build small libraries in temp directories;
    // one file at a time keeps them accountable.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
