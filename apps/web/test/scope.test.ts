/**
 * The left pane's model: the scope, and the collection forest.
 */
import { describe, expect, it } from 'vitest';

import { buildCollectionTree, scopeKey, scopeTitle, scopeToQuery } from '../src/library/scope.js';
import { parseScope, serialiseScope, validateLibrarySearch } from '../src/routes/library.js';
import { collection, id, tag } from './fixtures.js';

const A = id('COLA01');
const B = id('COLB01');
const C = id('COLC01');

describe('the library scope', () => {
  it('round-trips through the URL', () => {
    for (const scope of [
      { kind: 'library' } as const,
      { kind: 'collection', collectionId: A } as const,
      { kind: 'tag', tagId: B } as const,
    ]) {
      expect(parseScope(serialiseScope(scope))).toEqual(scope);
      expect(serialiseScope(scope)).toBe(scopeKey(scope));
    }
  });

  it('falls back to the whole library on a scope it cannot read', () => {
    expect(parseScope('nonsense')).toEqual({ kind: 'library' });
    expect(parseScope('collection:')).toEqual({ kind: 'library' });
  });

  it('becomes the query parameters the list endpoint takes', () => {
    expect(scopeToQuery({ kind: 'library' })).toEqual({});
    expect(scopeToQuery({ kind: 'collection', collectionId: A })).toEqual({ collectionId: A });
    expect(scopeToQuery({ kind: 'tag', tagId: B })).toEqual({ tagId: B });
  });

  it('names itself from the records it refers to, and says so when it cannot', () => {
    const collections = [collection({ id: A, name: 'Methods' })];
    const tags = [tag({ id: B, name: 'to-read' })];

    expect(scopeTitle({ kind: 'library' }, collections, tags)).toBe('All items');
    expect(scopeTitle({ kind: 'collection', collectionId: A }, collections, tags)).toBe('Methods');
    expect(scopeTitle({ kind: 'tag', tagId: B }, collections, tags)).toBe('Tagged to-read');
    expect(scopeTitle({ kind: 'collection', collectionId: C }, collections, tags)).toBe('Unknown collection');
  });
});

describe('the collection forest', () => {
  it('nests children under their parents and sorts by position', () => {
    const tree = buildCollectionTree([
      collection({ id: B, name: 'Beta', parentId: A, depth: 1, position: 1 }),
      collection({ id: A, name: 'Alpha', position: 0 }),
      collection({ id: C, name: 'Gamma', parentId: A, depth: 1, position: 0 }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.collection.id).toBe(A);
    expect(tree[0]?.children.map((node) => node.collection.name)).toEqual(['Gamma', 'Beta']);
  });

  it('keeps several roots, because the hierarchy is a forest', () => {
    const tree = buildCollectionTree([
      collection({ id: A, name: 'Alpha' }),
      collection({ id: B, name: 'Beta' }),
    ]);
    expect(tree.map((node) => node.collection.name)).toEqual(['Alpha', 'Beta']);
  });

  it('promotes an orphan to a root rather than dropping it', () => {
    const tree = buildCollectionTree([
      collection({ id: B, name: 'Orphan', parentId: id('MISSING'), depth: 1 }),
    ]);
    expect(tree.map((node) => node.collection.name)).toEqual(['Orphan']);
  });
});

describe('the library search parameters', () => {
  it('accepts what it understands and replaces what it does not', () => {
    expect(validateLibrarySearch({ order: 'asc', scope: `collection:${A}`, item: 'x', q: 'bias' })).toEqual(
      { order: 'asc', scope: `collection:${A}`, item: 'x', q: 'bias' },
    );
    expect(validateLibrarySearch({ order: 'sideways' })).toEqual({
      order: 'desc',
      scope: 'library',
    });
  });

  it('carries no sort field, because the API accepts none', () => {
    // A `?sort=title` in a bookmark would be a promise `GET /api/v1/items` cannot keep: it parses
    // its query strictly and answers 422. The parameter is dropped rather than passed through.
    expect(validateLibrarySearch({ sort: 'title', order: 'asc' })).toEqual({
      order: 'asc',
      scope: 'library',
    });
  });

  it('drops empty strings rather than putting them in the URL', () => {
    expect(validateLibrarySearch({ q: '', item: '' })).toEqual({
      scope: 'library',
      order: 'desc',
    });
  });
});
