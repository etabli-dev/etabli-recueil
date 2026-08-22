import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // Every import test builds a real library in a temp directory and reads the real fixture
    // database; running the files one at a time keeps the handles and the temp trees accountable.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
