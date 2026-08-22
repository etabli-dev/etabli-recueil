/**
 * The API client: what it sends, and what it does with what comes back.
 */
import { describe, expect, it } from 'vitest';

import { RecueilClient } from '../src/api/client.js';
import { ApiError, isApiError, parseProblemDocument } from '../src/api/problem.js';
import { FakeProblem, createFakeServer } from './fake-server.js';
import { ITEM_ID, expandedItem, page, problem } from './fixtures.js';

const clientFor = (server: ReturnType<typeof createFakeServer>): RecueilClient =>
  new RecueilClient({ fetch: server.fetch });

describe('the API client', () => {
  it('omits absent query parameters rather than sending them empty', async () => {
    const server = createFakeServer({ 'GET /api/v1/items': () => page([]) });
    await clientFor(server).listItems({ limit: 25, q: undefined, collectionId: undefined });

    const [request] = server.requestsTo('GET', '/api/v1/items');
    expect(request?.query.get('limit')).toBe('25');
    expect(request?.query.has('q')).toBe(false);
    expect(request?.query.has('collectionId')).toBe(false);
  });

  it('fetches an item with no query at all: the server expands everything already', async () => {
    const server = createFakeServer({ 'GET /api/v1/items/:id': () => expandedItem() });
    await clientFor(server).getItem(ITEM_ID);

    const [request] = server.requestsTo('GET', `/api/v1/items/${ITEM_ID}`);
    // `GET /items/{id}` takes no `expand`; sending one was the assumption this reconciled.
    expect(request?.url).toBe(`/api/v1/items/${ITEM_ID}`);
  });

  it('releases a lock by addressing it, one field at a time', async () => {
    const server = createFakeServer({ 'DELETE /api/v1/items/:id/locks/:fieldPath': () => undefined });
    await clientFor(server).unlockField(ITEM_ID, 'doi');

    const [request] = server.requestsTo('DELETE', `/api/v1/items/${ITEM_ID}/locks/doi`);
    expect(request).toBeDefined();
    expect(request?.body).toBeUndefined();
  });

  it('lists an item\u2019s attachments under the item, where the route lives', async () => {
    const server = createFakeServer({ 'GET /api/v1/items/:id/attachments': () => page([]) });
    await clientFor(server).listAttachments(ITEM_ID);

    expect(server.requestsTo('GET', `/api/v1/items/${ITEM_ID}/attachments`)).toHaveLength(1);
  });

  it('lists the collections without a limit, which the route would refuse', async () => {
    const server = createFakeServer({ 'GET /api/v1/collections': () => page([]) });
    await clientFor(server).listCollections();

    const [request] = server.requestsTo('GET', '/api/v1/collections');
    expect(request?.url).toBe('/api/v1/collections');
  });

  it('upserts a custom-field value by item and field key', async () => {
    const server = createFakeServer({
      'PUT /api/v1/items/:id/field-values/:fieldKey': (request) => request.body,
    });
    await clientFor(server).setFieldValue(ITEM_ID, 'invoice_total', {
      content: { type: 'monetary', value: 42, currency: 'EUR' },
    });

    const [request] = server.requestsTo('PUT', `/api/v1/items/${ITEM_ID}/field-values/invoice_total`);
    expect(request?.body).toEqual({ content: { type: 'monetary', value: 42, currency: 'EUR' } });
  });

  it('sends the expected version as a quoted If-Match, and omits it when there is none', async () => {
    const server = createFakeServer({ 'PATCH /api/v1/items/:id': () => expandedItem() });
    const client = clientFor(server);

    await client.updateItem(ITEM_ID, { title: 'One' }, 7);
    await client.updateItem(ITEM_ID, { title: 'Two' });

    const requests = server.requestsTo('PATCH', `/api/v1/items/${ITEM_ID}`);
    expect(requests[0]?.headers['if-match']).toBe('"7"');
    expect(requests[1]?.headers['if-match']).toBeUndefined();
  });

  it('turns a problem document into an ApiError that keeps every member', async () => {
    const server = createFakeServer({
      'GET /api/v1/items': () => {
        throw new FakeProblem(
          problem({
            type: 'https://recueil.org/problems/validation',
            title: 'Invalid input',
            status: 422,
            detail: 'sort must be one of dateModified, dateAdded, title, issuedYear',
            errors: [{ path: 'sort', message: 'unknown sort field', code: 'invalid_value' }],
          }),
        );
      },
    });

    const failure = await clientFor(server)
      .listItems({})
      .catch((error: unknown) => error);

    expect(isApiError(failure)).toBe(true);
    const apiError = failure as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.type).toBe('https://recueil.org/problems/validation');
    expect(apiError.problem.errors?.[0]).toEqual({
      path: 'sort',
      message: 'unknown sort field',
      code: 'invalid_value',
    });
    expect(apiError.request.method).toBe('GET');
    expect(apiError.message).toContain('sort must be one of');
  });

  it('recognises the two problem types the item pane has to branch on', async () => {
    const locked = new ApiError(
      problem({ type: 'https://recueil.org/problems/field-locked', status: 409, title: 'Field locked' }),
      { method: 'PATCH', url: '/api/v1/items/x' },
    );
    const stale = new ApiError(
      problem({ type: 'https://recueil.org/problems/version-conflict', status: 412, title: 'Version conflict' }),
      { method: 'PATCH', url: '/api/v1/items/x' },
    );

    expect(locked.isFieldLocked).toBe(true);
    expect(locked.isVersionConflict).toBe(false);
    expect(stale.isVersionConflict).toBe(true);
  });

  it('reports an unroutable response as a problem document rather than a raw status', async () => {
    const client = new RecueilClient({
      fetch: async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    });

    const failure = (await client.listItems({}).catch((error: unknown) => error)) as ApiError;
    expect(failure.status).toBe(502);
    expect(failure.problem.type).toBe('https://recueil.org/problems/internal');
    expect(failure.problem.title).toBe('Server error');
  });

  it('reports a transport failure as a problem document with no status', async () => {
    const client = new RecueilClient({
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    const failure = (await client.getHealth().catch((error: unknown) => error)) as ApiError;
    expect(failure.status).toBe(0);
    expect(failure.problem.type).toBe('https://recueil.org/problems/transport');
    expect(failure.problem.detail).toBe('Failed to fetch');
  });

  it('builds the document content URL the reader hands to PDF.js', () => {
    // The bytes hang off the document, not the attachment: the same PDF reachable from two items is
    // stored once and served once (AT1, ADR-0004).
    const client = new RecueilClient({ baseUrl: 'http://127.0.0.1:3000' });
    expect(client.documentContentUrl('01J8F3Z9K4DOC0010000000000')).toBe(
      'http://127.0.0.1:3000/api/v1/documents/01J8F3Z9K4DOC0010000000000/content',
    );
  });

  it('rejects a body that only looks like a problem document', () => {
    expect(parseProblemDocument({ type: 'x', title: 'y' })).toBeNull();
    expect(parseProblemDocument('not an object')).toBeNull();
    expect(parseProblemDocument({ type: 'x', title: 'y', status: 400 })).toEqual({
      type: 'x',
      title: 'y',
      status: 400,
    });
  });
});
