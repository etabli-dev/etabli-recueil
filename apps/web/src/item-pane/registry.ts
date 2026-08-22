/**
 * The item-pane section registry.
 *
 * CONCEPT.md §5.13 lists "item-pane sections" as the first UI extension surface, and §5.14 says the
 * item pane is "composed of sections (core + plugin)". Phase 1 ships no plugin host in the browser,
 * but the seam has to exist now, because retrofitting one means rewriting every section that was
 * written without it. So the core sections register through exactly the mechanism a plugin will
 * use: there is no privileged path, and `bibliographic` is registered by the same call a
 * third-party section would make.
 *
 * The registry is a plain observable store rather than React state, because registration happens at
 * module load — before any component mounts — and, once the plugin host exists, from outside React
 * altogether.
 */
import type { ComponentType } from 'react';
import type { Item } from '@recueil/schemas';

export interface ItemPaneSectionProps {
  /** The item, fully expanded. A section never fetches the item itself. */
  item: Item;
}

export interface ItemPaneSection {
  /** Stable id. Namespaced by the contributor: `core.bibliographic`, `openalex.metrics`. */
  id: string;
  title: string;
  /** Ascending. The core sections leave gaps of ten so a plugin can slot between them. */
  order: number;
  Component: ComponentType<ItemPaneSectionProps>;
  /** Whether the section applies to this item at all. An absent predicate means "always". */
  isVisible?: (item: Item) => boolean;
  /** `core`, or the id of the plugin that contributed it. Rendered in the section's own chrome. */
  source?: string;
}

type Listener = () => void;

export class ItemPaneSectionRegistry {
  private readonly sections = new Map<string, ItemPaneSection>();

  private readonly listeners = new Set<Listener>();

  /** A snapshot, rebuilt on change, so `useSyncExternalStore` can compare by reference. */
  private snapshot: readonly ItemPaneSection[] = [];

  /**
   * Add a section. Returns the function that removes it again, which is what a plugin's
   * `deactivate` calls and what a test's cleanup calls.
   */
  register(section: ItemPaneSection): () => void {
    if (this.sections.has(section.id)) {
      throw new Error(`An item-pane section with id "${section.id}" is already registered`);
    }
    this.sections.set(section.id, section);
    this.rebuild();
    return () => this.unregister(section.id);
  }

  unregister(id: string): void {
    if (this.sections.delete(id)) this.rebuild();
  }

  /** Every registered section, in render order. */
  all(): readonly ItemPaneSection[] {
    return this.snapshot;
  }

  /** The sections that apply to one item, in render order. */
  for(item: Item): ItemPaneSection[] {
    return this.snapshot.filter((section) => section.isVisible?.(item) ?? true);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private rebuild(): void {
    this.snapshot = [...this.sections.values()].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id),
    );
    for (const listener of this.listeners) listener();
  }
}

/** The registry the application renders. Core sections add themselves in `sections/index.ts`. */
export const itemPaneSections = new ItemPaneSectionRegistry();
