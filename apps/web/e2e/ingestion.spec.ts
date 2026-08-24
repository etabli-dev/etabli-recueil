/**
 * Ingestion, end to end: a folder configured in the browser, a file dropped into it, and an item in
 * the library at the other end.
 *
 * This is the claim M2 rests on — "scanner → searchable item with zero manual steps" for the flows
 * that clear the gate, and a review queue that makes the rest cheap — and it is the only test in
 * the repository that exercises all of it at once: the production bundle, over HTTP, against the
 * real Fastify application, against SQLite on disk, with the real ingestion pipeline reading a real
 * directory.
 *
 * Two things about how it asserts.
 *
 * **The two sides are queried separately.** The last assertion does not read the acceptance's own
 * response and call the item filed; it goes to the library screen, which fetches
 * `GET /api/v1/items`, and finds the row there. A check that inspected only the answer the write
 * returned could not fail, and would read as evidence.
 *
 * **The confidence gate is lowered, not bypassed.** `RECUEIL_INGEST_CONFIDENCE_THRESHOLD` is set
 * high enough that the hand-built PDF lands in the review queue, because the queue is what is under
 * test. The pipeline is otherwise the deployed one — no fake stage, no shortcut.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { startApiServer } from './harness/api-server.js';
import type { ApiServer } from './harness/api-server.js';
import { PAGE_ONE_TEXT, buildTwoPagePdf } from './harness/pdf.js';
import { startSpaServer } from './harness/spa-server.js';
import type { SpaServer } from './harness/spa-server.js';

let api: ApiServer;
let spa: SpaServer;

/** What the scanner is pretending to have produced. */
const SCAN_NAME = 'Rechnung-2026-114.pdf';
const SOURCE_NAME = 'Scanner drop';
const CORRESPONDENT = 'Acme GmbH';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await startApiServer({
    // 1.0 is unreachable — no combination of heuristics scores it — so every arrival is queued for
    // a human. That is the state this suite is about.
    env: { RECUEIL_INGEST_CONFIDENCE_THRESHOLD: '1.0' },
  });
  spa = await startSpaServer(api.url);
});

test.afterAll(async () => {
  await spa?.stop();
  await api?.stop();
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    // eslint-disable-next-line no-console -- the server log is the first thing worth reading here.
    console.log(api.log());
    await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true }).catch(() => undefined);
  }
});

/** Fail loudly rather than silently passing a test that only looked at a rendered error state. */
const failOnPageError = (page: Page): void => {
  page.on('pageerror', (error) => {
    throw new Error(`The page threw: ${error.message}`);
  });
};

test('configures a watched folder from the sources screen', async ({ page }) => {
  failOnPageError(page);
  await page.goto(`${spa.url}/sources`);

  await expect(page.getByText('No sources configured')).toBeVisible();

  await page.getByRole('button', { name: 'Add a source' }).click();
  await page.getByLabel('Name').fill(SOURCE_NAME);
  await page.getByLabel('Recorded as').selectOption('scanner');
  await page.getByLabel('Directory').fill(api.consumeDirectory);
  // A scanner writes a large PDF over several seconds; zero here because the test writes the file
  // in one call and should not wait for a settle period that exists for a different reason.
  await page.getByLabel('Settle for (ms)').fill('0');
  await page.getByRole('button', { name: 'Add the source' }).click();

  await expect(page.getByTestId('source-detail')).toBeVisible();
  await expect(page.getByRole('option', { name: new RegExp(SOURCE_NAME, 'u') })).toBeVisible();

  // The source is the server's now, not the form's: reloading reads it back over the API.
  await page.reload();
  await expect(page.getByText(api.consumeDirectory)).toBeVisible();
});

test('tests the connection, and names the checks behind the answer', async ({ page }) => {
  failOnPageError(page);
  await page.goto(`${spa.url}/sources`);
  await page.getByRole('option', { name: new RegExp(SOURCE_NAME, 'u') }).click();

  await page.getByRole('button', { name: 'Test the connection' }).click();

  const result = page.getByTestId('test-result');
  await expect(result).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('test-checks')).toContainText('directory');
  await expect(result).toContainText('nothing was ingested');
});

test('a file dropped into the folder becomes a review-queue entry', async ({ page }) => {
  failOnPageError(page);

  await mkdir(api.consumeDirectory, { recursive: true });
  await writeFile(join(api.consumeDirectory, SCAN_NAME), buildTwoPagePdf());

  await page.goto(`${spa.url}/sources`);
  await page.getByRole('option', { name: new RegExp(SOURCE_NAME, 'u') }).click();
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByText(/started as job/u)).toBeVisible();

  // The run is a job, so the screen is polled rather than assumed to be finished. `waiting_review`
  // is the state IK6 describes: the run raised entries and will not proceed until they are decided.
  await expect(page.getByTestId('last-run')).toHaveAttribute('data-state', /waiting_review|succeeded/u, {
    timeout: 30_000,
  });

  // The backlog is read from the review queue, not from the run's own report.
  await expect(page.getByTestId('backlog-open')).toContainText('1 open review entry', { timeout: 30_000 });
});

test('the entry carries its reason, its proposal and what the run recorded', async ({ page }) => {
  failOnPageError(page);
  await page.goto(`${spa.url}/review`);

  await expect(page.getByTestId('review-detail')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('entry-explanation')).toContainText('The threshold is');
  await expect(page.getByRole('option', { name: /low_confidence_metadata/u })).toBeVisible();

  // The document itself, fetched by its own row rather than described by the entry.
  await expect(page.getByTestId('subject-preview')).toBeVisible();
  await expect(page.getByTestId('subject-preview')).toContainText('application/pdf');

  // What the run recorded, which is the stage checkpoints and the log — not a summary invented here.
  await expect(page.getByTestId('run-trace')).toBeVisible();
  await expect(page.getByTestId('trace-stages')).toContainText('rules');
});

test('accepting with an edit files the document into the library', async ({ page }) => {
  failOnPageError(page);
  await page.goto(`${spa.url}/review`);
  await expect(page.getByTestId('review-detail')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /^Edit and accept/u }).click();
  await page.getByLabel('Item type').fill('invoice');
  const correspondent = page.locator('#edits-office\\.correspondent');
  if ((await correspondent.count()) > 0) {
    await correspondent.fill(CORRESPONDENT);
  }
  await page.getByLabel(/Why/u).fill('the correspondent is on the letterhead');
  await page.getByRole('button', { name: 'Accept with these edits' }).click();

  // The decision is staged first: this is the grace period that makes single-letter accept safe,
  // and it exists because the queue has no reopen.
  await expect(page.getByTestId('pending-banner')).toBeVisible();
  await expect(page.getByTestId('pending-banner')).toContainText('not sent yet');

  // Then it is sent, and the banner reports what the server said it did.
  await expect(page.getByTestId('sent-banner')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sent-banner')).toContainText('It created one item');
  // And it stops offering an undo it cannot honour.
  await expect(page.getByTestId('sent-banner')).toContainText('stays resolved');
});

test('the item is in the library, queried from the library and not from the acceptance', async ({ page }) => {
  failOnPageError(page);
  await page.goto(`${spa.url}/`);

  // `GET /api/v1/items` is what this screen fetches. Finding the row here is the other side of the
  // comparison: the acceptance's own answer is not consulted.
  const row = page.locator('.item-row', { hasText: PAGE_ONE_TEXT });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  await expect(page.locator('.item-pane__title')).toContainText(PAGE_ONE_TEXT);
  await expect(page.locator('.item-pane__meta .badge')).toHaveText('invoice');

  // The office facet is the Paperless mapping, and the edit made while accepting is on it.
  const officeSection = page.locator('[data-section="core.office"]');
  await expect(officeSection).toBeVisible();
  await expect(officeSection.getByLabel('Correspondent')).toHaveValue(CORRESPONDENT);
});

test('the review queue is empty again, and says so', async ({ page }) => {
  failOnPageError(page);
  await page.goto(`${spa.url}/review`);
  await expect(page.getByText('Nothing waiting')).toBeVisible({ timeout: 30_000 });
});

test('the office facet is editable, and a correction locks the field against resolvers', async ({ page }) => {
  failOnPageError(page);
  await page.goto(`${spa.url}/`);

  const row = page.locator('.item-row', { hasText: PAGE_ONE_TEXT });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  const officeSection = page.locator('[data-section="core.office"]');
  await officeSection.getByLabel('Reference number').fill('RE-2026-114');
  await officeSection.getByLabel('Reference number').blur();

  // Written, and written back: a reload reads it from the server.
  await expect(officeSection.locator('[data-field="referenceNumber"]')).toHaveAttribute(
    'data-locked',
    'true',
    { timeout: 15_000 },
  );
  await page.reload();
  await row.click();
  await expect(officeSection.getByLabel('Reference number')).toHaveValue('RE-2026-114');

  // The amount is one fact: value and currency together, or neither.
  await officeSection.getByLabel('Amount', { exact: true }).fill('1299.00');
  await officeSection.getByLabel('Currency').fill('EUR');
  await officeSection.getByLabel('Currency').blur();
  await page.reload();
  await row.click();
  await expect(officeSection.getByLabel('Amount', { exact: true })).toHaveValue('1299.00');
});
