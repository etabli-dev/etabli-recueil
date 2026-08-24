import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // Every pipeline test builds a real library and a real content store in a temporary directory,
    // and several of them deliberately crash a run and resume it; one file at a time keeps the
    // SQLite handles and the scratch trees accountable.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
