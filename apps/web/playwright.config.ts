/**
 * The end-to-end suite: the built bundle, a real browser, and a real server.
 *
 * There is no `webServer` block. Both servers are started inside the suite (`e2e/harness/`), which
 * is what lets each get an ephemeral port and a temporary database instead of a port chosen in
 * advance and a database left behind — and what lets the seed run through the API between the two
 * of them coming up and the first page load.
 *
 * One worker, and the specs run in order within their file: they share one seeded library, and one
 * of them writes to it. Parallelism here would buy a second or two and cost the ability to assert
 * that an edit persisted.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/u,
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === 'true',
  retries: 0,
  reporter: process.env.CI === 'true' ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices['Desktop Chrome'],
    // The base URL is per-run, because the SPA server binds to an ephemeral port; the suite
    // navigates with absolute URLs it is handed by the harness.
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
