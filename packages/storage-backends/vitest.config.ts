import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    // The S3 conformance run pushes a blob past the multipart threshold through a loopback
    // server, which is slower than anything else in this repository but still seconds, not
    // minutes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
