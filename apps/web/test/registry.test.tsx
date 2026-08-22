/**
 * The item-pane section registry — the seam CONCEPT.md §5.13 promises to plugins.
 *
 * The test that matters is that a section contributed after the fact behaves exactly like a core
 * one: same registration call, same ordering rules, same visibility predicate, and it appears in a
 * pane that was written without knowing it existed.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ItemPaneSectionRegistry } from '../src/item-pane/registry.js';
import { ItemPaneSections } from '../src/item-pane/item-pane.js';
import { itemPaneSections } from '../src/item-pane/registry.js';
import { expandedItem } from './fixtures.js';

describe('the item-pane section registry', () => {
  it('orders by order, then by id, so the sequence is deterministic', () => {
    const registry = new ItemPaneSectionRegistry();
    const Nothing = (): null => null;

    registry.register({ id: 'b', title: 'B', order: 20, Component: Nothing });
    registry.register({ id: 'a', title: 'A', order: 10, Component: Nothing });
    registry.register({ id: 'c', title: 'C', order: 10, Component: Nothing });

    expect(registry.all().map((section) => section.id)).toEqual(['a', 'c', 'b']);
  });

  it('refuses a duplicate id rather than shadowing the first section', () => {
    const registry = new ItemPaneSectionRegistry();
    const Nothing = (): null => null;
    registry.register({ id: 'x', title: 'X', order: 1, Component: Nothing });

    expect(() => registry.register({ id: 'x', title: 'Other X', order: 2, Component: Nothing })).toThrow(
      /already registered/u,
    );
  });

  it('returns a function that removes the section again', () => {
    const registry = new ItemPaneSectionRegistry();
    const remove = registry.register({ id: 'x', title: 'X', order: 1, Component: () => null });

    expect(registry.all()).toHaveLength(1);
    remove();
    expect(registry.all()).toHaveLength(0);
  });

  it('applies the visibility predicate per item', () => {
    const registry = new ItemPaneSectionRegistry();
    registry.register({
      id: 'office',
      title: 'Office',
      order: 1,
      Component: () => null,
      isVisible: (item) => item.office !== null && item.office !== undefined,
    });

    expect(registry.for(expandedItem())).toHaveLength(0);
  });

  it('renders a section contributed after the pane was written', () => {
    const remove = itemPaneSections.register({
      id: 'test.plugin',
      title: 'Contributed section',
      order: 999,
      source: 'test-plugin',
      Component: () => <p>Contributed content</p>,
    });

    try {
      render(<ItemPaneSections item={expandedItem()} />);
      expect(screen.getByText('Contributed content')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Contributed section/u })).toBeInTheDocument();
    } finally {
      remove();
    }
  });
});
