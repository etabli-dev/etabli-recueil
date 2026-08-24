import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // Every test here builds a real library, a real content store and — for two of the three
    // sources — a real server listening on a loopback port. One file at a time keeps the SQLite
    // handles, the temporary trees and the sockets accountable, and keeps the timing-sensitive
    // stability tests off a contended machine.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
