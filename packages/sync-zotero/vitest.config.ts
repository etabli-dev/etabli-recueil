import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // Every sync test builds a real library in a temp directory against an in-process fake
    // zotero.org; running the files one at a time keeps the handles and temp trees accountable.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
