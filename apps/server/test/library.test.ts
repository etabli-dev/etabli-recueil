/**
 * Collections, tags, notes, custom fields and creators.
 *
 * One file rather than five, because the interesting assertions are the invariants each resource
 * refuses to break, and those are short. The happy paths are short too; what earns the space is the
 * refusal — C1's cycle, C2's smart membership, CF1's immutable type, CR2's two ORCIDs.
 */
import { describe, expect, it } from 'vitest';

import { body, createItem, harness } from './helpers.js';

const collection = async (
  h: Awaited<ReturnType<typeof harness>>,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const response = await h.app.inject({ method: 'POST', url: '/api/v1/collections', payload });
  if (response.statusCode !== 201) throw new Error(`collection: ${response.statusCode} ${response.payload}`);
  return body(response);
};

describe('collections', () => {
  it('creates a hierarchy and returns it as a tree', async () => {
    const h = await harness();
    try {
      const root = await collection(h, { name: 'Methods' });
      const child = await collection(h, { name: 'Trials', parentId: root.id });
      await collection(h, { name: 'Cohorts', parentId: root.id });

      const tree = body(await h.app.inject({ method: 'GET', url: '/api/v1/collections/tree' }));
      const nodes = tree.data as { collection: { id: string; name: string }; children: unknown[] }[];
      expect(nodes.length).toBe(1);
      expect(nodes[0]?.collection.name).toBe('Methods');
      expect(nodes[0]?.children.length).toBe(2);

      expect(child.depth).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('refuses a move that would make a cycle (C1)', async () => {
    const h = await harness();
    try {
      const root = await collection(h, { name: 'Root' });
      const child = await collection(h, { name: 'Child', parentId: root.id });

      const response = await h.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${root.id as string}/move`,
        payload: { parentId: child.id },
      });

      expect(response.statusCode).toBe(409);
      expect(body(response).type).toBe('https://recueil.org/problems/integrity');
      expect(body(response).detail).toContain('C1');
    } finally {
      await h.close();
    }
  });

  it('rewrites subtree depth on a move (C4)', async () => {
    const h = await harness();
    try {
      const a = await collection(h, { name: 'A' });
      const b = await collection(h, { name: 'B' });
      const child = await collection(h, { name: 'Child', parentId: b.id });

      await h.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${b.id as string}/move`,
        payload: { parentId: a.id },
      });

      const moved = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/collections/${child.id as string}` }),
      );
      expect(moved.depth).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('files and unfiles items, and counts them', async () => {
    const h = await harness();
    try {
      const target = await collection(h, { name: 'Reading' });
      const one = await createItem(h);
      const two = await createItem(h, { title: 'Two', bibliographic: { title: 'Two' } });

      const added = await h.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${target.id as string}/items`,
        payload: { itemIds: [one.id, two.id] },
      });
      expect(body(added).changed).toBe(2);

      // Idempotent: filing the same item again moves nothing.
      const again = await h.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${target.id as string}/items`,
        payload: { itemIds: [one.id] },
      });
      expect(body(again).changed).toBe(0);

      const listed = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/collections/${target.id as string}/items` }),
      );
      expect((listed.data as unknown[]).length).toBe(2);

      const removed = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${target.id as string}/items`,
        payload: { itemIds: [one.id] },
      });
      expect(body(removed).changed).toBe(1);

      const fetched = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/collections/${target.id as string}` }),
      );
      expect(fetched.itemCount).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('refuses to file items into a saved search (C2)', async () => {
    const h = await harness();
    try {
      const saved = await collection(h, {
        name: 'Everything about trials',
        kind: 'smart',
        query: { text: 'trial' },
      });
      const item = await createItem(h);

      const response = await h.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${saved.id as string}/items`,
        payload: { itemIds: [item.id] },
      });
      expect(response.statusCode).toBe(409);
    } finally {
      await h.close();
    }
  });

  it('refuses a smart collection with no query', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        payload: { name: 'Broken', kind: 'smart' },
      });
      expect(response.statusCode).toBe(422);
      expect(body(response).errors).toContainEqual(expect.objectContaining({ path: 'body.query' }));
    } finally {
      await h.close();
    }
  });

  it('trashes the subtree and leaves the items alone (C3)', async () => {
    const h = await harness();
    try {
      const root = await collection(h, { name: 'Parent' });
      const child = await collection(h, { name: 'Child', parentId: root.id });
      const item = await createItem(h, { collectionIds: [child.id] });

      await h.app.inject({ method: 'POST', url: `/api/v1/collections/${root.id as string}/trash` });

      expect(
        (await h.app.inject({ method: 'GET', url: `/api/v1/collections/${child.id as string}` })).statusCode,
      ).toBe(200);
      expect(
        body(await h.app.inject({ method: 'GET', url: `/api/v1/collections/${child.id as string}` }))
          .trashedAt,
      ).toBeTypeOf('string');

      // The item is untouched.
      const live = body(await h.app.inject({ method: 'GET', url: `/api/v1/items/${item.id as string}` }));
      expect(live.trashedAt).toBeNull();
    } finally {
      await h.close();
    }
  });
});

describe('tags', () => {
  it('renames without losing the assignments (TG1)', async () => {
    const h = await harness();
    try {
      const item = await createItem(h, { tagNames: ['methdology'] });
      const tags = body(await h.app.inject({ method: 'GET', url: '/api/v1/tags' }));
      const tag = (tags.data as { id: string }[])[0] as { id: string };

      const renamed = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/tags/${tag.id}`,
        payload: { name: 'methodology' },
      });
      expect(body(renamed).name).toBe('methodology');

      const onItem = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/items/${item.id as string}/tags` }),
      );
      expect((onItem.data as { name: string }[]).map((entry) => entry.name)).toEqual(['methodology']);
    } finally {
      await h.close();
    }
  });

  it('merges one tag into another and moves the assignments (TG2)', async () => {
    const h = await harness();
    try {
      const item = await createItem(h, { tagNames: ['RCT', 'trial'] });
      const tags = body(await h.app.inject({ method: 'GET', url: '/api/v1/tags' }));
      const byName = new Map((tags.data as { id: string; name: string }[]).map((t) => [t.name, t.id]));

      const merged = await h.app.inject({
        method: 'POST',
        url: `/api/v1/tags/${byName.get('trial') as string}/merge`,
        payload: { loserId: byName.get('RCT') },
      });

      expect(merged.statusCode).toBe(200);
      expect((body(merged).winner as { name: string }).name).toBe('trial');

      const onItem = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/items/${item.id as string}/tags` }),
      );
      expect((onItem.data as { name: string }[]).map((entry) => entry.name)).toEqual(['trial']);
    } finally {
      await h.close();
    }
  });

  it('replaces the tag set of an item', async () => {
    const h = await harness();
    try {
      const item = await createItem(h, { tagNames: ['a', 'b'] });
      const response = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/items/${item.id as string}/tags`,
        payload: { tagNames: ['b', 'c'], source: 'rule' },
      });

      expect(response.statusCode).toBe(200);
      const names = (body(response).data as { name: string; source: string }[]);
      expect(names.map((entry) => entry.name).sort()).toEqual(['b', 'c']);
      expect(names.find((entry) => entry.name === 'c')?.source).toBe('rule');
    } finally {
      await h.close();
    }
  });
});

describe('notes', () => {
  it('creates from markdown and from HTML, keeping both (N1, P10)', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);

      const markdown = await h.app.inject({
        method: 'POST',
        url: '/api/v1/notes',
        payload: { itemId: item.id, contentMarkdown: '# A heading\n\nSome thoughts.' },
      });
      expect(markdown.statusCode).toBe(201);
      expect(body(markdown).title).toBe('A heading');
      expect(body(markdown).sourceFormat).toBe('markdown');

      const html = await h.app.inject({
        method: 'POST',
        url: '/api/v1/notes',
        payload: {
          itemId: item.id,
          sourceFormat: 'html',
          contentMarkdown: '',
          contentOriginal: '<h1>From Zotero</h1><p>Body.</p>',
        },
      });
      expect(html.statusCode).toBe(201);
      expect(body(html).sourceFormat).toBe('html');
      expect(body(html).contentMarkdown).toContain('From Zotero');
      expect(body(html).contentOriginal).toBe('<h1>From Zotero</h1><p>Body.</p>');

      const onItem = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/items/${item.id as string}/notes` }),
      );
      expect((onItem.data as unknown[]).length).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('refuses a note with no content', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/notes',
        payload: { contentMarkdown: '' },
      });
      expect(response.statusCode).toBe(422);
      expect(body(response).errors).toContainEqual(
        expect.objectContaining({ path: 'body.contentMarkdown' }),
      );
    } finally {
      await h.close();
    }
  });

  it('refuses a stale conditional update', async () => {
    const h = await harness();
    try {
      const note = body(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/notes',
          payload: { contentMarkdown: 'First.' },
        }),
      );
      await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/notes/${note.id as string}`,
        payload: { contentMarkdown: 'Second.' },
      });

      const stale = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/notes/${note.id as string}`,
        headers: { 'if-match': '"1"' },
        payload: { contentMarkdown: 'Third.' },
      });
      expect(stale.statusCode).toBe(412);
    } finally {
      await h.close();
    }
  });
});

describe('custom fields', () => {
  it('defines a field, writes a typed value and clears it', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      const field = body(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/fields',
          payload: { fieldKey: 'sample_size', name: 'Sample size', dataType: 'integer' },
        }),
      );
      expect(field.fieldKey).toBe('sample_size');

      const written = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/items/${item.id as string}/field-values/sample_size`,
        payload: { content: { type: 'integer', value: 412 } },
      });
      expect(written.statusCode).toBe(200);
      expect(body(written).content).toEqual({ type: 'integer', value: 412 });

      const listed = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/items/${item.id as string}/field-values` }),
      );
      expect((listed.data as unknown[]).length).toBe(1);

      const cleared = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/items/${item.id as string}/field-values/sample_size`,
      });
      expect(cleared.statusCode).toBe(204);
    } finally {
      await h.close();
    }
  });

  it('refuses a value whose type is not the field’s (FV1)', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/fields',
        payload: { fieldKey: 'sample_size', name: 'Sample size', dataType: 'integer' },
      });

      const response = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/items/${item.id as string}/field-values/sample_size`,
        payload: { content: { type: 'text', value: 'four hundred and twelve' } },
      });
      expect(response.statusCode).toBe(409);
      expect(body(response).detail).toContain('FV1');
    } finally {
      await h.close();
    }
  });

  it('refuses to remove a field that has values (CF2)', async () => {
    const h = await harness();
    try {
      const item = await createItem(h);
      const field = body(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/fields',
          payload: { fieldKey: 'notes_field', name: 'Notes', dataType: 'text' },
        }),
      );
      await h.app.inject({
        method: 'PUT',
        url: `/api/v1/items/${item.id as string}/field-values/notes_field`,
        payload: { content: { type: 'text', value: 'something' } },
      });

      const response = await h.app.inject({ method: 'DELETE', url: `/api/v1/fields/${field.id as string}` });
      expect(response.statusCode).toBe(409);
      expect(body(response).detail).toContain('CF2');
    } finally {
      await h.close();
    }
  });

  it('has no way to change the data type (CF1)', async () => {
    const h = await harness();
    try {
      const field = body(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/fields',
          payload: { fieldKey: 'sample_size', name: 'Sample size', dataType: 'integer' },
        }),
      );
      const response = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/fields/${field.id as string}`,
        payload: { dataType: 'text' },
      });
      expect(response.statusCode).toBe(422);
      expect(body(response).errors).toContainEqual(
        expect.objectContaining({ path: 'body.dataType', code: 'unrecognized_keys' }),
      );
    } finally {
      await h.close();
    }
  });
});

describe('creators', () => {
  it('sets an author list in order and lists the works', async () => {
    const h = await harness();
    try {
      const first = body(
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
          payload: { kind: 'organisation', literalName: 'Cochrane Collaboration' },
        }),
      );
      const item = await createItem(h);

      const written = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/items/${item.id as string}/creators`,
        payload: {
          creators: [
            { creatorId: first.id, role: 'author', affiliationRaw: 'Université Paris Cité' },
            { creatorId: second.id, role: 'editor' },
          ],
        },
      });

      expect(written.statusCode).toBe(200);
      const list = body(written).data as { ordinal: number; role: string; creator: { displayName: string } }[];
      expect(list.map((entry) => entry.ordinal)).toEqual([0, 1]);
      expect(list[0]?.creator.displayName).toBe('Philippe Ravaud');
      expect(list[1]?.role).toBe('editor');

      const works = body(
        await h.app.inject({ method: 'GET', url: `/api/v1/creators/${first.id as string}/works` }),
      );
      expect((works.data as { id: string }[]).map((row) => row.id)).toEqual([item.id]);
    } finally {
      await h.close();
    }
  });

  it('refuses to merge two creators with different ORCIDs (CR2)', async () => {
    const h = await harness();
    try {
      const winner = body(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/creators',
          payload: { kind: 'person', familyName: 'Smith', givenName: 'Jane', orcid: '0000-0002-1825-0097' },
        }),
      );
      const loser = body(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/creators',
          payload: { kind: 'person', familyName: 'Smith', givenName: 'J', orcid: '0000-0001-5109-3700' },
        }),
      );

      const response = await h.app.inject({
        method: 'POST',
        url: `/api/v1/creators/${winner.id as string}/merge`,
        payload: { loserId: loser.id },
      });
      expect(response.statusCode).toBe(409);
      expect(body(response).detail).toContain('CR2');
    } finally {
      await h.close();
    }
  });

  it('refuses a person with no name at all', async () => {
    const h = await harness();
    try {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/v1/creators',
        payload: { kind: 'person', givenName: 'Only given' },
      });
      expect(response.statusCode).toBe(422);
      expect(body(response).errors).toContainEqual(
        expect.objectContaining({ path: 'body.familyName' }),
      );
    } finally {
      await h.close();
    }
  });
});
