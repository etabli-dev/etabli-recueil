/**
 * The web client against a running Recueil server.
 *
 * Everything below happens over HTTP against `apps/server`'s Fastify application, on a socket, over
 * SQLite in a temporary directory, with the production bundle served from `dist/`. The unit suite
 * proves the client builds the request it means to; this suite is the only thing that proves the
 * request is one the server answers — and it is what caught every mismatch reconciled in
 * `src/api/client.ts`: a `sort` the list endpoint rejects, a `text` that is spelled `q`, an
 * `/attachments?itemId=` that does not exist, and a content endpoint that hangs off the document
 * rather than the attachment.
 *
 * The specs share one seeded library and run in order, because one of them writes to it and the
 * next asserts that the write survived a reload.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { startApiServer } from './harness/api-server.js';
import type { ApiServer } from './harness/api-server.js';
import { PAGE_ONE_TEXT, PAGE_TWO_TEXT } from './harness/pdf.js';
import { COLLECTION_NAME, NOTE_SEARCH_TERM, TITLES, seedLibrary } from './harness/seed.js';
import type { SeededLibrary } from './harness/seed.js';
import { startSpaServer } from './harness/spa-server.js';
import type { SpaServer } from './harness/spa-server.js';

let api: ApiServer;
let spa: SpaServer;
let seeded: SeededLibrary;
/** Whether this build of SQLite has FTS5. ADR-0011 says it may not; the note search needs it. */
let searchAvailable = false;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await startApiServer();
  seeded = await seedLibrary(api.url);
  spa = await startSpaServer(api.url);

  const health = (await (await fetch(`${api.url}/health`)).json()) as {
    search?: { available?: boolean };
  };
  searchAvailable = health.search?.available === true;
});

test.afterAll(async () => {
  await spa?.stop();
  await api?.stop();
});

/**
 * Open the library and wait for the first page of items.
 *
 * Waiting on a row rather than on `networkidle`: the list is cursor-paged and the query cache
 * refetches on focus, so "the network went quiet" is not the same event as "the library is drawn".
 */
const openLibrary = async (page: Page): Promise<void> => {
  await page.goto(`${spa.url}/`);
  await expect(page.getByTestId(`item-row-${seeded.trialItemId}`)).toBeVisible();
};

const itemsPane = (page: Page) => page.locator('[data-pane="items"]');
const detailPane = (page: Page) => page.locator('[data-pane="detail"]');

/**
 * Every request the server refused, and every error the page threw.
 *
 * This is an assertion, not only a diagnostic, and it is the one that would have caught the
 * mismatches this suite exists to prevent. A `422` for an invented query parameter shows up in the
 * interface as an empty pane, and a pane can be empty for honest reasons — so a test that only
 * looked at the screen would report "the list is empty", which is true and useless. Nothing in this
 * application should provoke a 4xx or a 5xx, including from a background query whose result never
 * reaches the assertions, so any at all fails the test that produced it.
 *
 * On a failure the list and the server's own log are attached to the report, which is the
 * difference between a five-minute diagnosis and an hour of one.
 */
const browserFailures = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
});

test.afterEach(async ({ page }, testInfo) => {
  const failures = browserFailures.get(page) ?? [];

  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('failed-requests', {
      body: failures.length === 0 ? '(none)' : failures.join('\n'),
      contentType: 'text/plain',
    });
    await testInfo.attach('server-log', { body: api.log(), contentType: 'text/plain' });
    return;
  }

  expect(failures, 'the browser made requests the server refused').toEqual([]);
});

/* -------------------------------------------------------------------------------------------- */

test('the item list shows every seeded item', async ({ page }) => {
  await openLibrary(page);

  const pane = itemsPane(page);
  await expect(pane.getByText(TITLES.trial)).toBeVisible();
  await expect(pane.getByText(TITLES.guidelines)).toBeVisible();
  await expect(pane.getByText(TITLES.registered)).toBeVisible();

  // `page.total` comes from the server's own count, so this asserts the envelope as well as the rows.
  await expect(pane.getByText('3 of 3')).toBeVisible();
});

test('selecting an item populates the item pane from one request', async ({ page }) => {
  await openLibrary(page);
  await page.getByTestId(`item-row-${seeded.trialItemId}`).click();

  const detail = detailPane(page);
  await expect(detail.getByRole('heading', { name: TITLES.trial })).toBeVisible();

  // The bibliographic facet, the creators, the tags, the collection membership and the attachments
  // all arrive expanded on `GET /items/{id}` — no `expand` parameter, and no second request.
  await expect(detail.getByLabel('Publication')).toHaveValue('Journal of Negative Results');
  await expect(detail.getByLabel('Year')).toHaveValue('2019');
  await expect(detail.getByLabel('DOI')).toHaveValue('10.1000/e2e.trial');
  await expect(detail.locator('.creators').getByText(/Ravaud/u)).toBeVisible();
  await expect(detail.locator('.creators').getByText(/Boutron/u)).toBeVisible();
  await expect(detail.getByTestId('tag-to-read')).toBeVisible();
  await expect(detail.getByTestId(`filed-in-${seeded.collectionId}`)).toContainText(COLLECTION_NAME);
  await expect(detail.getByTestId(`attachment-${seeded.attachmentId}`)).toContainText(
    'The trial, as published',
  );
});

test('editing a bibliographic field persists across a reload', async ({ page }) => {
  await openLibrary(page);
  await page.getByTestId(`item-row-${seeded.trialItemId}`).click();

  const volume = detailPane(page).getByLabel('Volume');
  await expect(volume).toHaveValue('12');
  await volume.fill('17');
  await volume.press('Enter');

  // A manual write locks the field it touched (P4-1), so the lock badge appearing is the server's
  // answer being rendered rather than the input keeping what was typed into it.
  await expect(detailPane(page).getByTestId('lock-volume')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId(`item-row-${seeded.trialItemId}`)).toBeVisible();
  await page.getByTestId(`item-row-${seeded.trialItemId}`).click();
  await expect(detailPane(page).getByLabel('Volume')).toHaveValue('17');

  // And the same value is in the API, not merely in a cache the reload happened to keep.
  const response = await page.request.get(`${api.url}/api/v1/items/${seeded.trialItemId}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { bibliographic?: { volume?: string | null } };
  expect(body.bibliographic?.volume).toBe('17');
});

test('choosing a collection narrows the list', async ({ page }) => {
  await openLibrary(page);
  await page.getByRole('treeitem', { name: new RegExp(COLLECTION_NAME, 'u') }).click();

  const pane = itemsPane(page);
  await expect(pane.getByText(TITLES.guidelines)).toBeHidden();
  await expect(pane.getByText(TITLES.trial)).toBeVisible();
  await expect(pane.getByText(TITLES.registered)).toBeVisible();
  await expect(pane.getByText('2 of 2')).toBeVisible();

  // The scope is in the URL, which is what makes "the items in Trials" a link (CONCEPT.md §5.14).
  expect(new URL(page.url()).searchParams.get('scope')).toBe(`collection:${seeded.collectionId}`);
});

test('searching finds an item by the text of its note', async ({ page }) => {
  // Without FTS5 the filter degrades to a `LIKE` over the title, which cannot see a note at all
  // (ADR-0011). That is a property of the SQLite build, not a failure of the client, so it is a
  // skip with the reason named rather than a red test or a quietly weakened assertion.
  test.skip(!searchAvailable, 'this SQLite build has no FTS5 index, so a note is not searchable');

  await openLibrary(page);
  await page.getByRole('searchbox', { name: 'Search the library' }).fill(NOTE_SEARCH_TERM);

  const pane = itemsPane(page);
  // The word is in the note, not in the item: the filter resolves a note hit to the item it hangs
  // off, which is the whole reason `GET /items?q=` is not a title search.
  await expect(pane.getByText(TITLES.guidelines)).toBeVisible();
  await expect(pane.getByText(TITLES.trial)).toBeHidden();
  await expect(pane.getByText(TITLES.registered)).toBeHidden();
  await expect(pane.getByText('1 of 1')).toBeVisible();

  await page.getByTestId(`item-row-${seeded.guidelinesItemId}`).click();
  await expect(detailPane(page).getByText(new RegExp(NOTE_SEARCH_TERM, 'u'))).toBeVisible();
});

test('the reader opens the attached PDF and renders page one', async ({ page }) => {
  await openLibrary(page);
  await page.getByTestId(`item-row-${seeded.trialItemId}`).click();

  await page
    .getByTestId(`attachment-${seeded.attachmentId}`)
    .getByRole('button', { name: 'Open in reader' })
    .click();

  await expect(page).toHaveURL(new RegExp(`/reader/${seeded.attachmentId}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'The trial, as published' })).toBeVisible();

  // Two pages, and the first one showing.
  await expect(page.getByText('of 2')).toBeVisible();
  await expect(page.getByLabel('Page 1')).toBeVisible();

  // The text layer is PDF.js's own extraction of the page, positioned over the canvas. It carries
  // page one's words and not page two's, which is what "page 1 is rendered" means.
  const textLayer = page.locator('.textLayer');
  await expect(textLayer).toContainText(PAGE_ONE_TEXT);
  await expect(textLayer).not.toContainText(PAGE_TWO_TEXT);

  // And the canvas has ink on it. A text layer over a blank canvas would satisfy everything above.
  //
  // Two counts rather than one, because "not white" is not the same as "drawn": an untouched canvas
  // is transparent *black*, which a naive darkness test reads as a page covered in ink. So the page
  // must be opaque — PDF.js paints the white background — and some of those opaque pixels dark.
  const ink = await page.locator('canvas.reader__canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (context === null || canvas.width === 0 || canvas.height === 0) return null;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) {
      if ((data[index + 3] ?? 0) < 255) continue;
      opaque += 1;
      if ((data[index] ?? 255) < 128) dark += 1;
    }
    return { opaque, dark, total: data.length / 4 };
  });

  expect(ink).not.toBeNull();
  const { opaque, dark, total } = ink as { opaque: number; dark: number; total: number };
  expect(opaque).toBeGreaterThan(total * 0.99);
  expect(dark).toBeGreaterThan(0);

  // Page two is reachable, and shows the other page's text — so the reader is paging the document
  // rather than having drawn one image.
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(textLayer).toContainText(PAGE_TWO_TEXT);
});
