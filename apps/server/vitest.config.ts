import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // Every integration test builds a real library — a SQLite file and a content-addressed store —
    // in its own temporary directory. Running the files one at a time keeps the open handles and
    // the temporary trees easy to account for, and matches packages/core.
    fileParallelism: false,
  },
});
