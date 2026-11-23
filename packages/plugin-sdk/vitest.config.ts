import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // The SDK tests are pure; nothing needs a library.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
