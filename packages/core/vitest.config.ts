import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // The migration and ingestion tests each build a real SQLite file in a temp directory; running
    // the files one at a time keeps the handles and the temp trees easy to account for.
    fileParallelism: false,
  },
});
