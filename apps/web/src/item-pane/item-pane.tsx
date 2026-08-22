/**
 * The right-hand pane: one item, rendered as a list of sections.
 *
 * The pane itself knows nothing about bibliography, attachments or notes. It fetches the item,
 * asks the registry which sections apply, and draws them — which is what makes the plugin surface
 * of CONCEPT.md §5.13 real rather than promised. Adding a section is a `register` call and no
 * change here.
 */
import { useState } from 'react';
import type { Item } from '@recueil/schemas';

import { useItem } from '../api/queries.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { useItemPaneSections } from './use-sections.js';

export interface ItemPaneProps {
  itemId: string | null;
}

export const ItemPane = ({ itemId }: ItemPaneProps): JSX.Element => {
  const item = useItem(itemId);

  if (itemId === null) {
    return (
      <EmptyState
        title="Nothing selected"
        description="Choose an item in the list to see its fields, attachments, tags and notes."
      />
    );
  }
  if (item.isPending) return <LoadingState label="Loading the item…" />;
  if (item.isError) {
    return <ErrorState label="Could not load the item" error={item.error} onRetry={() => void item.refetch()} />;
  }

  return <ItemPaneSections item={item.data} />;
};

/** Split out so the section list can be rendered from a known item, in tests and in previews. */
export const ItemPaneSections = ({ item }: { item: Item }): JSX.Element => {
  const sections = useItemPaneSections(item);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggle = (id: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <article className="item-pane" aria-label={item.title ?? 'Untitled item'}>
      <header className="item-pane__header">
        <h3 className="item-pane__title">{item.title ?? 'Untitled item'}</h3>
        <p className="item-pane__meta">
          <span className="badge">{item.itemType}</span>
          <code className="item-pane__key">{item.publicId}</code>
          <span>version {item.version}</span>
        </p>
      </header>

      {sections.length === 0 ? (
        <EmptyState
          title="No sections apply"
          description="Every registered item-pane section declined this item type."
        />
      ) : (
        sections.map((section) => {
          const isCollapsed = collapsed.has(section.id);
          return (
            <section
              key={section.id}
              className="item-pane__section"
              data-section={section.id}
              data-section-source={section.source ?? 'unknown'}
              aria-labelledby={`section-${section.id}`}
            >
              <h4 className="section__title">
                <button
                  type="button"
                  id={`section-${section.id}`}
                  className="item-pane__toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(section.id)}
                >
                  <span aria-hidden="true">{isCollapsed ? '\u25b8' : '\u25be'}</span> {section.title}
                </button>
              </h4>
              {isCollapsed ? null : <div className="section__body"><section.Component item={item} /></div>}
            </section>
          );
        })
      )}
    </article>
  );
};
