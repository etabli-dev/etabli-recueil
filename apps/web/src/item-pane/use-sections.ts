/** Subscribing a component to the section registry. */
import { useMemo, useSyncExternalStore } from 'react';
import type { Item } from '@recueil/schemas';

import { itemPaneSections } from './registry.js';
import type { ItemPaneSection, ItemPaneSectionRegistry } from './registry.js';

export const useItemPaneSections = (
  item: Item,
  registry: ItemPaneSectionRegistry = itemPaneSections,
): ItemPaneSection[] => {
  const all = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.all(),
    () => registry.all(),
  );
  return useMemo(() => all.filter((section) => section.isVisible?.(item) ?? true), [all, item]);
};
