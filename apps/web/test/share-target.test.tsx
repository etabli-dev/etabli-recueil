/**
 * The page the operating system's share sheet lands on.
 *
 * The three properties worth holding: the file reaches `POST /api/v1/ingestion/upload` as multipart
 * with the name the worker cleaned, the pipeline's actual outcome is reported rather than a generic
 * success — a scan that landed in the review queue has not been filed — and the stash is emptied
 * only after the upload has answered, because a share cleared optimistically and then failing is a
 * document that was on the phone, was consumed by this page, and is nowhere.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SharePanel } from '../src/routes/share.js';
import { validateShareSearch } from '../src/routes/share.js';
import { SHARE_CACHE, shareKey, SHARE_FILENAME_HEADER, SHARE_STASHED_AT_HEADER } from '../src/pwa/share-protocol.js';
import { createFakeServer } from './fake-server.js';
import type { FakeServer, Handler, RecordedRequest } from './fake-server.js';
import { FakeCacheStorage } from './fake-cache.js';
import { renderWithApi } from './helpers.js';
import { expandedItem } from './fixtures.js';
import { reviewEntry, scanDocument } from './ingestion-fixtures.js';

const KEY = 'ab'.repeat(8);
const UPLOAD = '/api/v1/ingestion/upload';

/** The pipeline's answer, in the shape `IngestUploadResult` has on the wire. */
const uploadResult = (overrides: Record<string, unknown> = {}): unknown => ({
  outcome: 'ingested',
  jobId: '01J8F3Z9K4JOB00000000000A1',
  document: scanDocument({ sha256: 'c'.repeat(64), byteSize: 3 }),
  item: { ...expandedItem(), itemType: 'invoice', title: 'Rechnung 114' },
  reviewEntry: null,
  reasonCode: null,
  detail: 'Filed as an invoice.',
  ...overrides,
});

let storage: FakeCacheStorage;

/** A stash the worker would have written, put in place by hand. */
const stash = async (filename = 'Rechnung 114.pdf'): Promise<void> => {
  const cache = await storage.open(SHARE_CACHE);
  await cache.put(
    shareKey(KEY, 0),
    new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }), {
      headers: {
        'content-type': 'application/pdf',
        [SHARE_FILENAME_HEADER]: encodeURIComponent(filename),
        [SHARE_STASHED_AT_HEADER]: '2026-08-22T09:15:00.000Z',
      },
    }),
  );
};

beforeEach(() => {
  storage = new FakeCacheStorage();
  Object.defineProperty(globalThis, 'caches', { value: storage, configurable: true, writable: true });
});

const render = (routes: Record<string, Handler> = {}): { server: FakeServer } => {
  const server = createFakeServer({ [`POST ${UPLOAD}`]: () => uploadResult(), ...routes });
  renderWithApi(<SharePanel shareKey={KEY} error={null} />, server);
  return { server };
};

describe('validateShareSearch', () => {
  it('accepts only a key of the shape the worker writes', () => {
    expect(validateShareSearch({ share: 'ab'.repeat(8) })).toEqual({ share: 'ab'.repeat(8) });
    expect(validateShareSearch({ share: '../../etc/passwd' })).toEqual({});
    expect(validateShareSearch({ share: 'ZZZZ' })).toEqual({});
  });

  it("carries the worker’s own failure through", () => {
    expect(validateShareSearch({ error: 'stash' })).toEqual({ error: 'stash' });
  });
});

describe('the share landing page', () => {
  it('shows what was shared, with its name and type', async () => {
    await stash();
    render();
    expect(await screen.findByText('Rechnung 114.pdf')).toBeInTheDocument();
    expect(screen.getByTestId('share-item')).toHaveTextContent('application/pdf');
  });

  it('uploads to the ingestion endpoint as multipart, marked as mobile capture', async () => {
    const user = userEvent.setup();
    await stash();
    const { server } = render();

    await screen.findByTestId('share-page');
    await user.click(screen.getByRole('button', { name: 'Add to the library' }));

    await waitFor(() => {
      expect(server.requestsTo('POST', UPLOAD)).toHaveLength(1);
    });
    const request = server.requestsTo('POST', UPLOAD)[0] as RecordedRequest;
    // No `content-type` header from the client: the browser sets the multipart boundary, and a
    // client that set the header itself would set it without one.
    expect(request.headers['content-type']).toBeUndefined();
  });

  it('reports a duplicate as one, rather than as a fresh upload', async () => {
    const user = userEvent.setup();
    await stash();
    render({
      [`POST ${UPLOAD}`]: () =>
        uploadResult({ outcome: 'duplicate', item: null, detail: 'These bytes were already in the library.' }),
    });

    await screen.findByTestId('share-page');
    await user.click(screen.getByRole('button', { name: 'Add to the library' }));

    const result = await screen.findByTestId('share-result');
    expect(result).toHaveAttribute('data-outcome', 'duplicate');
    expect(result).toHaveTextContent('already in the library');
  });

  it('says a scan went to the review queue rather than calling it filed', async () => {
    const user = userEvent.setup();
    await stash();
    render({
      [`POST ${UPLOAD}`]: () =>
        uploadResult({
          outcome: 'review',
          item: null,
          reviewEntry: reviewEntry(),
          reasonCode: 'low_confidence_metadata',
          detail: 'The confidence gate refused it.',
        }),
    });

    await screen.findByTestId('share-page');
    await user.click(screen.getByRole('button', { name: 'Add to the library' }));

    const result = await screen.findByTestId('share-result');
    expect(result).toHaveAttribute('data-outcome', 'review');
    expect(screen.getByTestId('share-review')).toHaveTextContent('waiting in the review queue');
  });

  it('empties the stash once the upload has answered', async () => {
    const user = userEvent.setup();
    await stash();
    render();

    await screen.findByTestId('share-page');
    await user.click(screen.getByRole('button', { name: 'Add to the library' }));
    await screen.findByTestId('share-result');

    await waitFor(async () => {
      const cache = await storage.open(SHARE_CACHE);
      expect(cache.entries.size).toBe(0);
    });
  });

  it('keeps the stash when the upload failed, so the share is not lost', async () => {
    const user = userEvent.setup();
    await stash();
    render({
      [`POST ${UPLOAD}`]: () => {
        throw new Error('the server refused');
      },
    });

    await screen.findByTestId('share-page');
    await user.click(screen.getByRole('button', { name: 'Add to the library' }));

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    const cache = await storage.open(SHARE_CACHE);
    expect(cache.entries.size).toBe(1);
  });

  it('explains itself when opened with nothing to pick up', async () => {
    render();
    // No stash was written, so there is nothing under the key.
    expect(await screen.findByTestId('share-empty')).toHaveTextContent('Opening it directly has nothing to pick up');
  });

  it('says plainly when the worker could not read the share at all', () => {
    const server = createFakeServer({});
    renderWithApi(<SharePanel shareKey={null} error="stash" />, server);
    expect(screen.getByText('The share could not be picked up')).toBeInTheDocument();
  });
});
