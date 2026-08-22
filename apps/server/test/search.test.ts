/**
 * `/api/v1/search`, and the difference between a search and a filter.
 *
 * `GET /items?q=` folds the match into a SQL query so it can be paged and combined with other
 * filters; `GET /search` ranks. Both are tested here against the same fixtures, because the pair is
 * easy to confuse and the answer to "why did I get a different set" is that they are different
 * questions.
 */
import { describe, expect, it } from 'vitest';

import { body, createItem, harness } from './helpers.js';

const seed = async (h: Awaited<ReturnType<typeof harness>>): Promise<void> => {
  await createItem(h, {
    title: 'A randomised controlled trial of aspirin',
    bibliographic: {
      title: 'A randomised controlled trial of aspirin',
      containerTitle: 'The Lancet',
      abstract: 'Aspirin reduced the incidence of thrombosis.',
      issuedYear: 2019,
    },
  });
  await createItem(h, {
    title: 'A cohort study of paracetamol',
    bibliographic: {
      title: 'A cohort study of paracetamol',
      containerTitle: 'BMJ',
      abstract: 'Observational, and therefore not a trial.',
      issuedYear: 2020,
    },
  });
};

describe('GET /api/v1/search', () => {
  it('ranks hits and returns the compiled expression', async () => {
    const h = await harness();
    try {
      await seed(h);
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/search?q=aspirin' });

      expect(response.statusCode).toBe(200);
      const result = body(response);
      expect(result.query).toBe('aspirin');
      expect(result.expression).toBeTypeOf('string');
      expect((result.hits as unknown[]).length).toBeGreaterThan(0);

      const hit = (result.hits as Record<string, unknown>[])[0] as Record<string, unknown>;
      expect(hit.entityType).toBe('item');
      expect(hit.score).toBeTypeOf('number');
    } finally {
      await h.close();
    }
  });

  it('honours the field syntax and the exclusion operator', async () => {
    const h = await harness();
    try {
      await seed(h);

      const titled = body(await h.app.inject({ method: 'GET', url: '/api/v1/search?q=title:aspirin' }));
      expect((titled.hits as unknown[]).length).toBe(1);

      const excluded = body(
        await h.app.inject({ method: 'GET', url: encodeURI('/api/v1/search?q=trial -aspirin') }),
      );
      // "trial" appears in the second item's abstract; the exclusion removes the first.
      for (const hit of excluded.hits as { entityId: string }[]) {
        const item = body(await h.app.inject({ method: 'GET', url: `/api/v1/items/${hit.entityId}` }));
        expect(item.title).not.toContain('aspirin');
      }
    } finally {
      await h.close();
    }
  });

  it('refuses an unknown field and names the ones that exist', async () => {
    const h = await harness();
    try {
      await seed(h);
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/search?q=publisher:elsevier' });
      expect(response.statusCode).toBe(422);
      expect(body(response).detail).toContain('title');
    } finally {
      await h.close();
    }
  });

  it('refuses an empty query rather than returning the library', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/search?q=' });
      expect(response.statusCode).toBe(422);
      expect(body(response).errors).toContainEqual(expect.objectContaining({ path: 'query.q' }));
    } finally {
      await h.close();
    }
  });
});

describe('GET /api/v1/items?q=', () => {
  it('filters the list, and still pages', async () => {
    const h = await harness();
    try {
      await seed(h);
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/items?q=aspirin&limit=10' });

      expect(response.statusCode).toBe(200);
      const page = body(response);
      expect((page.data as { title: string }[]).map((row) => row.title)).toEqual([
        'A randomised controlled trial of aspirin',
      ]);
      expect((page.page as { total: number }).total).toBe(1);
    } finally {
      await h.close();
    }
  });
});
