/**
 * `/api/v1/trash` — the bin across every entity (P5, §6.6).
 *
 * The point of the resource is that "never delete" is checkable: everything that has been removed
 * is in one list, with the reason it went there, and can be put back. The purge is the one
 * operation that is not reversible, and it has its own verb and its own scope precisely because of
 * that.
 */
import { describe, expect, it } from 'vitest';

import { body, createItem, harness } from './helpers.js';

describe('GET /api/v1/trash', () => {
  it('lists what has been removed, across entity types', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      const collection = body(
        await h.app.inject({ method: 'POST', url: '/api/v1/collections', payload: { name: 'Gone' } }),
      );

      await h.app.inject({ method: 'POST', url: `/api/v1/items/${item.id as string}/trash` });
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.id as string}/trash`,
        payload: { reason: 'user', reasonDetail: 'tidying up' },
      });

      const page = body(await h.app.inject({ method: 'GET', url: '/api/v1/trash' }));
      const rows = page.data as { entityType: string; entityId: string; reason: string; reasonDetail: string | null }[];

      expect(rows.map((row) => row.entityType).sort()).toEqual(['collection', 'item']);
      expect(rows.find((row) => row.entityType === 'collection')?.reasonDetail).toBe('tidying up');
      expect(rows.every((row) => row.reason === 'user')).toBe(true);

      const filtered = body(await h.app.inject({ method: 'GET', url: '/api/v1/trash?entityType=item' }));
      expect((filtered.data as { entityType: string }[]).map((row) => row.entityType)).toEqual(['item']);
    } finally {
      await h.close();
    }
  });

  it('summarises the bin by entity type', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      await h.app.inject({ method: 'POST', url: `/api/v1/items/${item.id as string}/trash` });

      const summary = body(await h.app.inject({ method: 'GET', url: '/api/v1/trash/summary' }));
      expect((summary.counts as Record<string, number>).item).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('restores through the trash record, dispatching to the owning service', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      await h.app.inject({ method: 'POST', url: `/api/v1/items/${item.id as string}/trash` });

      const page = body(await h.app.inject({ method: 'GET', url: '/api/v1/trash?entityType=item' }));
      const record = (page.data as { id: string }[])[0] as { id: string };

      const restored = await h.app.inject({ method: 'POST', url: `/api/v1/trash/${record.id}/restore` });
      expect(restored.statusCode).toBe(204);

      const live = body(await h.app.inject({ method: 'GET', url: `/api/v1/items/${item.id as string}` }));
      expect(live.trashedAt).toBeNull();

      // The record is closed, so it is no longer in the open list.
      const after = body(await h.app.inject({ method: 'GET', url: '/api/v1/trash' }));
      expect(after.data).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('purges permanently, and only through the purge verb', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      await h.app.inject({ method: 'POST', url: `/api/v1/items/${item.id as string}/trash` });

      const page = body(await h.app.inject({ method: 'GET', url: '/api/v1/trash?entityType=item' }));
      const record = (page.data as { id: string }[])[0] as { id: string };

      const purged = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/trash/${record.id}?reason=${encodeURIComponent('retention policy')}`,
      });
      expect(purged.statusCode).toBe(200);
      expect(body(purged).purgedAt).toBeTypeOf('string');

      // Purging closes the record: it is gone from the open list, and cannot be restored.
      const open = body(await h.app.inject({ method: 'GET', url: '/api/v1/trash' }));
      expect(open.data).toEqual([]);

      const closed = body(await h.app.inject({ method: 'GET', url: '/api/v1/trash?includeClosed=true' }));
      expect((closed.data as { purgedAt: string | null }[])[0]?.purgedAt).toBeTypeOf('string');
    } finally {
      await h.close();
    }
  });

  it('is a 404 for a trash record that does not exist', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/trash/01J8F3Z9K4ABCDEFGHJKMNPQRS/restore',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});
