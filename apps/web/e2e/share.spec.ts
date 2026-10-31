import { expect, test } from '@playwright/test';
import { startApiServer, type ApiServer } from './harness/api-server.js';
import { startSpaServer, type SpaServer } from './harness/spa-server.js';
import { buildTwoPagePdf } from './harness/pdf.js';
import { SHARE_CACHE } from '../src/pwa/share-protocol.js';

let api: ApiServer;
let spa: SpaServer;
test.beforeAll(async () => {
  api = await startApiServer({ env: { RECUEIL_INGEST_CONFIDENCE_THRESHOLD: '1.0' } });
  spa = await startSpaServer(api.url);
});
test.afterAll(async () => { await spa?.stop(); await api?.stop(); });

test('worker accepts a real multipart share, preserves a failed upload, then stores exact bytes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(spa.url);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const bytes = Array.from(buildTwoPagePdf());
  const landing = await page.evaluate(async (content) => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(content)], 'Mobile scan.pdf', { type: 'application/pdf' }));
    form.set('text', 'Shared from the scanner');
    const response = await fetch('/share', { method: 'POST', body: form });
    return response.url;
  }, bytes);
  expect(new URL(landing).searchParams.get('share')).toMatch(/^[a-f0-9]{32}$/u);
  await page.goto(landing);
  await expect(page.getByText('Mobile scan.pdf', { exact: true })).toBeVisible();
  await page.route('**/api/v1/ingestion/upload', route => route.fulfill({
    status: 503, contentType: 'application/problem+json',
    body: JSON.stringify({ title: 'Temporarily unavailable', status: 503 }),
  }));
  await page.getByRole('button', { name: 'Add to the library' }).click();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(await page.evaluate(async name => (await (await caches.open(name)).keys()).length, SHARE_CACHE)).toBe(1);
  await page.unroute('**/api/v1/ingestion/upload');
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/ingestion/upload') && r.status() === 200);
  await page.getByRole('button', { name: 'Try again' }).click();
  const result = await (await response).json() as { document: { id: string }; outcome: string };
  await expect(page.getByTestId('share-result')).toHaveAttribute('data-outcome', 'review');
  await expect.poll(() => page.evaluate(async name => (await (await caches.open(name)).keys()).length, SHARE_CACHE)).toBe(0);
  const stored = await page.request.get(`${api.url}/api/v1/documents/${result.document.id}/content`);
  expect(stored.status()).toBe(200);
  expect(Array.from(await stored.body())).toEqual(bytes);
  await page.reload();
  await expect(page.getByTestId('share-empty')).toBeVisible();
  expect(errors).toEqual([]);
});
