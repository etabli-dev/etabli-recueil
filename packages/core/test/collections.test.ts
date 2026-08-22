/**
 * Collections: the hierarchy, its membership, and the four invariants §4.1 attaches to it.
 *
 * The assertions that matter are C1 (no cycles) and C4 (a move rewrites the whole subtree's depth),
 * because both are service-layer rules that no database constraint is holding up. If the cycle
 * check regresses, nothing else in the system notices until a recursive CTE runs forever.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';

import { InvariantError, NotFoundError, schema } from '../src/index.js';
import { makeLibrary } from './helpers.js';
import type { TestLibrary } from './helpers.js';

let library: TestLibrary;

beforeEach(() => {
  library = makeLibrary();
});

afterEach(() => {
  library.dispose();
});

const makeItem = (title: string) =>
  library.library.createItem({ itemType: 'article', bibliographic: { title } }, library.actor).item;

describe('CollectionService — hierarchy', () => {
  it('creates a forest with depth maintained from the parent', () => {
    const root = library.collections.create({ name: 'Methods' }, library.actor);
    const child = library.collections.create({ name: 'Sepsis', parentId: root.id }, library.actor);
    const grandchild = library.collections.create(
      { name: 'Fluids', parentId: child.id },
      library.actor,
    );

    expect(root.depth).toBe(0);
    expect(child.depth).toBe(1);
    expect(grandchild.depth).toBe(2);
    expect(root.parentKey).toBe('');
    expect(child.parentKey).toBe(root.id);
  });

  it('refuses two siblings with the same name, case-insensitively', () => {
    const root = library.collections.create({ name: 'Reviews' }, library.actor);
    library.collections.create({ name: 'Draft', parentId: root.id }, library.actor);

    expect(() =>
      library.collections.create({ name: '  draft ', parentId: root.id }, library.actor),
    ).toThrow(/already exists/u);

    // The same name under a different parent is fine: the rule is per sibling set.
    expect(() => library.collections.create({ name: 'Draft' }, library.actor)).not.toThrow();
  });

  it('renders the forest as a tree', () => {
    const root = library.collections.create({ name: 'A' }, library.actor);
    library.collections.create({ name: 'A1', parentId: root.id }, library.actor);
    library.collections.create({ name: 'A2', parentId: root.id }, library.actor);
    library.collections.create({ name: 'B' }, library.actor);

    const tree = library.collections.tree();
    expect(tree).toHaveLength(2);
    const first = tree.find((node) => node.collection.name === 'A');
    expect(first?.children.map((node) => node.collection.name).sort()).toEqual(['A1', 'A2']);
  });
});

describe('CollectionService — move (C1, C4)', () => {
  it('rejects a move that would close a cycle, and leaves the hierarchy untouched (C1)', () => {
    const root = library.collections.create({ name: 'Root' }, library.actor);
    const child = library.collections.create({ name: 'Child', parentId: root.id }, library.actor);
    const grandchild = library.collections.create(
      { name: 'Grandchild', parentId: child.id },
      library.actor,
    );

    // Directly under a descendant.
    expect(() => library.collections.move(root.id, grandchild.id, library.actor)).toThrow(
      InvariantError,
    );
    // One level down is the same rule.
    expect(() => library.collections.move(root.id, child.id, library.actor)).toThrow(/cycle/iu);
    // And a collection may not be its own parent.
    expect(() => library.collections.move(root.id, root.id, library.actor)).toThrow(/own parent/iu);

    expect(library.collections.get(root.id).parentId).toBeNull();
    expect(library.collections.get(root.id).depth).toBe(0);
    expect(library.collections.get(grandchild.id).depth).toBe(2);
  });

  it('names the invariant and the ancestors in the refusal', () => {
    const root = library.collections.create({ name: 'Root' }, library.actor);
    const child = library.collections.create({ name: 'Child', parentId: root.id }, library.actor);
    const grandchild = library.collections.create(
      { name: 'Grandchild', parentId: child.id },
      library.actor,
    );

    try {
      library.collections.move(root.id, grandchild.id, library.actor);
      throw new Error('the move should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InvariantError);
      const problem = error as InvariantError;
      expect(problem.status).toBe(409);
      expect(problem.detail?.['invariant']).toBe('C1');
      expect(problem.detail?.['ancestors']).toContain(grandchild.id);
    }
  });

  it('rewrites depth for the whole subtree, in one transaction (C4)', () => {
    const alpha = library.collections.create({ name: 'Alpha' }, library.actor);
    const beta = library.collections.create({ name: 'Beta' }, library.actor);
    const child = library.collections.create({ name: 'Child', parentId: beta.id }, library.actor);
    const grandchild = library.collections.create(
      { name: 'Grandchild', parentId: child.id },
      library.actor,
    );

    expect(library.collections.get(grandchild.id).depth).toBe(2);

    library.collections.move(beta.id, alpha.id, library.actor);

    expect(library.collections.get(beta.id).depth).toBe(1);
    expect(library.collections.get(child.id).depth).toBe(2);
    expect(library.collections.get(grandchild.id).depth).toBe(3);

    library.collections.move(child.id, null, library.actor);
    expect(library.collections.get(child.id).depth).toBe(0);
    expect(library.collections.get(grandchild.id).depth).toBe(1);
  });
});

describe('CollectionService — membership', () => {
  it('adds and removes items, idempotently', () => {
    const collection = library.collections.create({ name: 'To read' }, library.actor);
    const one = makeItem('One');
    const two = makeItem('Two');

    expect(library.collections.addItems(collection.id, [one.id, two.id], library.actor)).toBe(2);
    // A second call adds nothing rather than raising: a retried bulk request must not fail (P9).
    expect(library.collections.addItems(collection.id, [one.id], library.actor)).toBe(0);
    expect(library.collections.countItems(collection.id)).toBe(2);

    expect(library.collections.removeItems(collection.id, [one.id], library.actor)).toBe(1);
    expect(library.collections.countItems(collection.id)).toBe(1);
    expect(library.collections.listItems(collection.id).data.map((row) => row.id)).toEqual([two.id]);
  });

  it('refuses rows in a saved search (C2)', () => {
    const smart = library.collections.create(
      { name: 'Recent sepsis', kind: 'smart', query: { text: 'sepsis' } },
      library.actor,
    );
    const item = makeItem('Sepsis trial');

    expect(() => library.collections.addItems(smart.id, [item.id], library.actor)).toThrow(
      InvariantError,
    );
    expect(() => library.collections.listItems(smart.id)).toThrow(/saved search/iu);
  });

  it('pages membership by cursor without repeating a row', () => {
    const collection = library.collections.create({ name: 'Big' }, library.actor);
    const ids = Array.from({ length: 7 }, (_value, index) => makeItem(`Item ${index}`).id);
    library.collections.addItems(collection.id, ids, library.actor);

    const first = library.collections.listItems(collection.id, { limit: 3 });
    expect(first.data).toHaveLength(3);
    expect(first.page.hasMore).toBe(true);

    const second = library.collections.listItems(collection.id, {
      limit: 3,
      cursor: first.page.nextCursor as string,
    });
    const third = library.collections.listItems(collection.id, {
      limit: 3,
      cursor: second.page.nextCursor as string,
    });

    const seen = [...first.data, ...second.data, ...third.data].map((row) => row.id);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(third.page.hasMore).toBe(false);
  });
});

describe('CollectionService — trash and restore (C3, P5)', () => {
  it('trashes descendants but not items, and puts the memberships back', () => {
    const root = library.collections.create({ name: 'Root' }, library.actor);
    const child = library.collections.create({ name: 'Child', parentId: root.id }, library.actor);
    const item = makeItem('A paper');
    library.collections.addItems(child.id, [item.id], library.actor);

    library.collections.trash(root.id, library.actor);

    // Both collections are gone from the live list; the item is not.
    expect(library.collections.list()).toHaveLength(0);
    expect(() => library.collections.get(child.id)).toThrow(NotFoundError);
    expect(library.library.getItem(item.id).item.trashedAt).toBeNull();
    expect(library.collections.forItem(item.id)).toHaveLength(0);

    // T1: an open trash row for each collection, sharing one group.
    const open = library.db
      .select()
      .from(schema.trash)
      .where(
        and(
          eq(schema.trash.entityType, 'collection'),
          isNull(schema.trash.restoredAt),
          isNull(schema.trash.purgedAt),
        ),
      )
      .all();
    expect(open).toHaveLength(2);
    expect(new Set(open.map((row) => row.groupId)).size).toBe(1);

    library.collections.restore(root.id, library.actor);

    expect(library.collections.list()).toHaveLength(2);
    expect(library.collections.countItems(child.id)).toBe(1);
    expect(library.collections.forItem(item.id).map((row) => row.id)).toEqual([child.id]);

    const stillOpen = library.db
      .select()
      .from(schema.trash)
      .where(and(eq(schema.trash.entityType, 'collection'), isNull(schema.trash.restoredAt)))
      .all();
    expect(stillOpen).toHaveLength(0);
  });

  it('trashing twice does not open a second trash record (P9)', () => {
    const collection = library.collections.create({ name: 'Once' }, library.actor);
    library.collections.trash(collection.id, library.actor);
    library.collections.trash(collection.id, library.actor);

    const rows = library.db
      .select()
      .from(schema.trash)
      .where(eq(schema.trash.entityId, collection.id))
      .all();
    expect(rows).toHaveLength(1);
  });
});
