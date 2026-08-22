/**
 * `/api/v1/items` end to end.
 *
 * Every assertion here runs against a real library in a temporary directory — a real SQLite file
 * and a real content-addressed store — through `fastify.inject()`. Nothing is mocked, because a
 * test that stubs the service is a test of the stub, and the interesting behaviour of this surface
 * (provenance locks, optimistic concurrency, cascade on trash) all lives below the route.
 */
import { describe, expect, it } from 'vitest';

import { body, createItem, harness, itemPayload } from './helpers.js';

describe('POST /api/v1/items', () => {
  it('creates an item with its facet, tags and collection membership', async () => {
    const h = await harness();
    try {
      const collection = body(
        await h.app.inject({ method: 'POST', url: '/api/v1/collections', payload: { name: 'Trials' } }),
      );

      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/items',
        payload: itemPayload({ tagNames: ['methodology', 'to read'], collectionIds: [collection.id] }),
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toMatch(/^\/api\/v1\/items\/[0-9A-HJKMNP-TV-Z]{26}$/u);
      expect(response.headers.etag).toBe('"1"');

      const item = body(response);
      expect(item.itemType).toBe('article');
      expect((item.bibliographic as Record<string, unknown>).doi).toBe('10.1016/s0140-6736(19)30041-8');
      expect((item.tags as { name: string }[]).map((tag) => tag.name).sort()).toEqual([
        'methodology',
        'to read',
      ]);
      expect(item.collectionIds).toEqual([collection.id]);
    } finally {
      await h.close();
    }
  });

  it('refuses an invalid body with problem+json and a pointer to the field', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/items',
        payload: { itemType: 'article', bibliographic: { doi: 'HTTPS://doi.org/10.1/X' } },
      });

      expect(response.statusCode).toBe(422);
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/u);

      const problem = body(response);
      expect(problem.type).toBe('https://recueil.org/problems/validation');
      expect(problem.status).toBe(422);
      expect(problem.traceId).toBe(response.headers['x-request-id']);
      expect(problem.errors).toContainEqual(
        expect.objectContaining({ path: 'body.bibliographic.doi' }),
      );
    } finally {
      await h.close();
    }
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/items',
        payload: { itemType: 'article', titel: 'a typo' },
      });

      expect(response.statusCode).toBe(422);
      expect(body(response).errors).toContainEqual(
        expect.objectContaining({ path: 'body.titel', code: 'unrecognized_keys' }),
      );
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/v1/items', () => {
  it('pages by cursor and reports the total', async () => {
    const h = await harness();
    try {
      for (let index = 0; index < 5; index += 1) {
        await createItem(h, { title: `Item ${index}`, bibliographic: { title: `Item ${index}` } });
      }

      const first = await h.app.inject({ method: 'GET', url: '/api/v1/items?limit=2' });
      expect(first.statusCode).toBe(200);

      const page = body(first);
      const info = page.page as { nextCursor: string | null; hasMore: boolean; total: number; limit: number };
      expect((page.data as unknown[]).length).toBe(2);
      expect(info.limit).toBe(2);
      expect(info.total).toBe(5);
      expect(info.hasMore).toBe(true);
      expect(info.nextCursor).toBeTypeOf('string');

      const seen = new Set((page.data as { id: string }[]).map((row) => row.id));
      let cursor = info.nextCursor;
      let guard = 0;
      while (cursor !== null && guard < 10) {
        const next = body(
          await h.app.inject({ method: 'GET', url: `/api/v1/items?limit=2&cursor=${cursor}` }),
        );
        for (const row of next.data as { id: string }[]) seen.add(row.id);
        cursor = (next.page as { nextCursor: string | null }).nextCursor;
        guard += 1;
      }

      // Every item exactly once: a cursor that repeated or skipped a row would show up here.
      expect(seen.size).toBe(5);
    } finally {
      await h.close();
    }
  });

  it('returns summaries with the rendered creator string and the attachment count', async () => {
    const h = await harness();
    try {
      const creator = body(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/creators',
          payload: { kind: 'person', familyName: 'Ravaud', givenName: 'Philippe' },
        }),
      );
      const second = body(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/creators',
          payload: { kind: 'person', familyName: 'Boutron', givenName: 'Isabelle' },
        }),
      );
      const third = body(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/creators',
          payload: { kind: 'person', familyName: 'Moher', givenName: 'David' },
        }),
      );

      const item = await createItem(h);
      await h.app.inject({
        method: 'PUT',
        url: `/api/v1/items/${item.id as string}/creators`,
        payload: {
          creators: [
            { creatorId: creator.id, role: 'author' },
            { creatorId: second.id, role: 'author' },
            { creatorId: third.id, role: 'author' },
          ],
        },
      });

      const page = body(await h.app.inject({ method: 'GET', url: '/api/v1/items' }));
      const row = (page.data as Record<string, unknown>[])[0] as Record<string, unknown>;
      expect(row.creatorSummary).toBe('Ravaud et al.');
      expect(row.issuedYear).toBe(2019);
      expect(row.containerTitle).toBe('The Lancet');
      expect(row.attachmentCount).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('refuses a page size outside the contract range', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/items?limit=5000' });
      expect(response.statusCode).toBe(422);
      expect(body(response).errors).toContainEqual(expect.objectContaining({ path: 'query.limit' }));
    } finally {
      await h.close();
    }
  });

  it('filters by collection, tag and item type', async () => {
    const h = await harness();
    try {
      const collection = body(
        await h.app.inject({ method: 'POST', url: '/api/v1/collections', payload: { name: 'Filed' } }),
      );
      const filed = await createItem(h, { collectionIds: [collection.id], tagNames: ['keep'] });
      await createItem(h, { itemType: 'book', title: 'A book', bibliographic: { title: 'A book' } });

      const byCollection = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/items?collectionId=${collection.id}` }),
      );
      expect((byCollection.data as { id: string }[]).map((row) => row.id)).toEqual([filed.id]);

      const byType = body(await h.app.inject({ method: 'GET', url: '/api/v1/items?itemType=book' }));
      expect((byType.data as { title: string }[]).map((row) => row.title)).toEqual(['A book']);

      const tags = body(await h.app.inject({ method: 'GET', url: '/api/v1/tags' }));
      const keep = (tags.data as { id: string; name: string }[]).find((tag) => tag.name === 'keep');
      const byTag = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/items?tagId=${keep?.id ?? ''}` }),
      );
      expect((byTag.data as { id: string }[]).map((row) => row.id)).toEqual([filed.id]);
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/v1/items/{id}', () => {
  it('expands the whole record and carries the version as an ETag', async () => {
    const h = await harness();
    try {
      const created = await createItem(h, { tagNames: ['x'] });
      const response = await h.app.inject({ method: 'GET', url: `/api/v1/items/${created.id as string}` });

      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"1"');

      const item = body(response);
      expect(item.bibliographic).toBeTypeOf('object');
      expect(item.creators).toEqual([]);
      expect(item.attachments).toEqual([]);
      expect(item.noteIds).toEqual([]);
      // A hand-made facet write locks its fields (P4-1), and the lock is visible here.
      expect((item.bibliographic as Record<string, unknown>).lockedFields).toContain('doi');
    } finally {
      await h.close();
    }
  });

  it('is a 404 problem document for an unknown id', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'GET',
        url: '/api/v1/items/01J8F3Z9K4ABCDEFGHJKMNPQRS',
      });
      expect(response.statusCode).toBe(404);
      expect(body(response).type).toBe('https://recueil.org/problems/not-found');
    } finally {
      await h.close();
    }
  });

  it('is a 422 for an id that is not a ULID, with the pointer at the path parameter', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/items/not-an-id' });
      expect(response.statusCode).toBe(422);
      expect(body(response).errors).toContainEqual(expect.objectContaining({ path: 'path.id' }));
    } finally {
      await h.close();
    }
  });

  it('finds an item by its public key', async () => {
    const h = await harness();
    try {
      const created = await createItem(h);
      const response = await h.app.inject({
        method: 'GET',
        url: `/api/v1/items/by-key/${created.publicId as string}`,
      });
      expect(response.statusCode).toBe(200);
      expect(body(response).id).toBe(created.id);
    } finally {
      await h.close();
    }
  });
});

describe('PATCH /api/v1/items/{id}', () => {
  it('applies the change and bumps the version', async () => {
    const h = await harness();
    try {
      const created = await createItem(h);
      const response = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/items/${created.id as string}`,
        payload: { title: 'A better title' },
      });

      expect(response.statusCode).toBe(200);
      expect(body(response).title).toBe('A better title');
      expect(body(response).version).toBe(2);
      expect(response.headers.etag).toBe('"2"');
    } finally {
      await h.close();
    }
  });

  it('refuses a stale If-Match with 412 and changes nothing (P1)', async () => {
    const h = await harness();
    try {
      const created = await createItem(h);
      await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/items/${created.id as string}`,
        payload: { title: 'First writer wins' },
      });

      const stale = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/items/${created.id as string}`,
        headers: { 'if-match': '"1"' },
        payload: { title: 'Second writer loses' },
      });

      expect(stale.statusCode).toBe(412);
      expect(body(stale).type).toBe('https://recueil.org/problems/version-conflict');

      const current = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/items/${created.id as string}` }),
      );
      expect(current.title).toBe('First writer wins');
    } finally {
      await h.close();
    }
  });

  it('rejects an If-Match that is not a quoted version', async () => {
    const h = await harness();
    try {
      const created = await createItem(h);
      const response = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/items/${created.id as string}`,
        headers: { 'if-match': '1' },
        payload: { title: 'x' },
      });
      expect(response.statusCode).toBe(400);
      expect(body(response).errors).toContainEqual(
        expect.objectContaining({ path: 'headers.if-match' }),
      );
    } finally {
      await h.close();
    }
  });

  it('replaces the tag set rather than adding to it', async () => {
    const h = await harness();
    try {
      const created = await createItem(h, { tagNames: ['one', 'two'] });
      const response = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/items/${created.id as string}`,
        payload: { tagNames: ['two', 'three'] },
      });

      expect((body(response).tags as { name: string }[]).map((tag) => tag.name).sort()).toEqual([
        'three',
        'two',
      ]);
    } finally {
      await h.close();
    }
  });
});

describe('PATCH /api/v1/items/{id}/bibliographic', () => {
  it('reports what a manual lock refused an automated write (P4-4)', async () => {
    const h = await harness();
    try {
      // The create wrote the DOI by hand, so it is locked.
      const created = await createItem(h);

      const response = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/items/${created.id as string}/bibliographic`,
        payload: {
          values: { doi: '10.9999/other', abstract: 'Added by the resolver.' },
          provenance: { source: 'crossref', confidence: 0.9 },
        },
      });

      expect(response.statusCode).toBe(200);
      const result = body(response);
      // `applied` names the facet as well as the field, because an item has two of them.
      expect(result.applied).toContain('bibliographic.abstract');
      expect(result.applied).not.toContain('bibliographic.doi');
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ fieldPath: 'doi', lockedBy: 'manual' }),
      );

      const facet = (result.item as Record<string, unknown>).bibliographic as Record<string, unknown>;
      expect(facet.doi).toBe('10.1016/s0140-6736(19)30041-8');
      expect(facet.abstract).toBe('Added by the resolver.');
      const provenance = facet.provenance as Record<string, { source: string } | undefined>;
      expect(provenance.abstract?.source).toBe('crossref');
    } finally {
      await h.close();
    }
  });

  it('lets a manual write through the lock, and locks the new value', async () => {
    const h = await harness();
    try {
      const created = await createItem(h);
      const response = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/items/${created.id as string}/bibliographic`,
        payload: { values: { doi: '10.9999/corrected' } },
      });

      expect(body(response).applied).toContain('bibliographic.doi');
      const facet = (body(response).item as Record<string, unknown>).bibliographic as Record<string, unknown>;
      expect(facet.doi).toBe('10.9999/corrected');
      expect(facet.lockedFields).toContain('doi');
    } finally {
      await h.close();
    }
  });
});

describe('provenance and locks', () => {
  it('reports both facets and honours an unlock', async () => {
    const h = await harness();
    try {
      const created = await createItem(h);
      const id = created.id as string;

      const before = body(await h.app.inject({ method: 'GET', url: `/api/v1/items/${id}/provenance` }));
      expect(before.lockedFields).toContain('doi');
      const map = before.bibliographic as Record<string, { source: string } | undefined>;
      expect(map.doi?.source).toBe('manual');

      const unlocked = await h.app.inject({ method: 'DELETE', url: `/api/v1/items/${id}/locks/doi` });
      expect(unlocked.statusCode).toBe(204);

      // With the lock gone, a resolver may now write the field.
      const written = body(
        await h.app.inject({
          method: 'PATCH',
          url: `/api/v1/items/${id}/bibliographic`,
          payload: { values: { doi: '10.9999/resolved' }, provenance: { source: 'crossref' } },
        }),
      );
      expect(written.applied).toContain('bibliographic.doi');

      const relocked = await h.app.inject({
        method: 'POST',
        url: `/api/v1/items/${id}/locks`,
        payload: { fieldPath: 'doi' },
      });
      expect(body(relocked).lockedFields).toContain('doi');
    } finally {
      await h.close();
    }
  });
});

describe('trash and restore', () => {
  it('trashes with its cascade and restores', async () => {
    const h = await harness();
    try {
      const created = await createItem(h);
      const id = created.id as string;
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/notes',
        payload: { itemId: id, contentMarkdown: 'A note.' },
      });

      const trashed = await h.app.inject({ method: 'POST', url: `/api/v1/items/${id}/trash` });
      expect(trashed.statusCode).toBe(200);
      expect(body(trashed).trashedAt).toBeTypeOf('string');

      // Gone from the live list, and from a plain fetch.
      const list = body(await h.app.inject({ method: 'GET', url: '/api/v1/items' }));
      expect(list.data).toEqual([]);
      expect((await h.app.inject({ method: 'GET', url: `/api/v1/items/${id}` })).statusCode).toBe(404);
      expect(
        (await h.app.inject({ method: 'GET', url: `/api/v1/items/${id}?includeTrashed=true` })).statusCode,
      ).toBe(200);

      // And it is in the bin, with its note beside it.
      const bin = body(await h.app.inject({ method: 'GET', url: '/api/v1/trash' }));
      const types = (bin.data as { entityType: string }[]).map((row) => row.entityType);
      expect(types).toContain('item');
      expect(types).toContain('note');

      const restored = await h.app.inject({ method: 'POST', url: `/api/v1/items/${id}/restore` });
      expect(restored.statusCode).toBe(200);
      expect(body(restored).trashedAt).toBeNull();
    } finally {
      await h.close();
    }
  });
});

describe('POST /api/v1/items/bulk', () => {
  it('reports each operation separately and replays an idempotency key (IK2)', async () => {
    const h = await harness();
    try {
      const request = {
        operations: [
          { op: 'create', ref: 'a', payload: itemPayload({ bibliographic: { title: 'Bulk one' } }) },
          { op: 'create', ref: 'b', payload: { itemType: 'not a slug!' } },
          { op: 'update', ref: 'c', id: '01J8F3Z9K4ABCDEFGHJKMNPQRS', payload: { title: 'nope' } },
        ],
      };

      const first = await h.app.inject({
        method: 'POST',
        url: '/api/v1/items/bulk',
        headers: { 'idempotency-key': 'batch-0001' },
        payload: request,
      });

      expect(first.statusCode).toBe(207);
      const result = body(first);
      expect(result.replayed).toBe(false);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(2);

      const outcomes = result.results as { ref: string; status: string; problem?: { type: string } }[];
      expect(outcomes.find((entry) => entry.ref === 'a')?.status).toBe('created');
      expect(outcomes.find((entry) => entry.ref === 'b')?.problem?.type).toBe(
        'https://recueil.org/problems/validation',
      );
      expect(outcomes.find((entry) => entry.ref === 'c')?.problem?.type).toBe(
        'https://recueil.org/problems/not-found',
      );

      // The replay returns the stored document and does not act again.
      const replay = await h.app.inject({
        method: 'POST',
        url: '/api/v1/items/bulk',
        headers: { 'idempotency-key': 'batch-0001' },
        payload: request,
      });
      expect(replay.statusCode).toBe(200);
      expect(body(replay).replayed).toBe(true);
      expect(body(replay).batchId).toBe(result.batchId);

      const list = body(await h.app.inject({ method: 'GET', url: '/api/v1/items' }));
      expect((list.page as { total: number }).total).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('runs again under a counted key when force is set (IK3)', async () => {
    const h = await harness();
    try {
      const request = {
        force: true,
        operations: [{ op: 'create', payload: itemPayload({ bibliographic: { title: 'Forced' } }) }],
      };

      for (let run = 0; run < 2; run += 1) {
        const response = await h.app.inject({
          method: 'POST',
          url: '/api/v1/items/bulk',
          headers: { 'idempotency-key': 'forced-0001' },
          payload: request,
        });
        expect(response.statusCode).toBe(207);
        expect(body(response).replayed).toBe(false);
      }

      const list = body(await h.app.inject({ method: 'GET', url: '/api/v1/items' }));
      expect((list.page as { total: number }).total).toBe(2);
    } finally {
      await h.close();
    }
  });
});
