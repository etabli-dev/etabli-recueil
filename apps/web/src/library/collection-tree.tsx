/**
 * The left pane: collections, saved searches and tags.
 *
 * Saved searches are collections whose membership is a query rather than a list
 * (`spec/data-model.md` §4.1), so they are drawn in the same tree with a badge rather than in a
 * section of their own — which is also why filing, the `.bib` endpoint and export treat the two
 * identically.
 */
import { buildCollectionTree, scopeKey } from './scope.js';
import type { CollectionNode, LibraryScope } from './scope.js';
import type { Collection, Tag } from '@recueil/schemas';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';

export interface CollectionTreeProps {
  collections: readonly Collection[];
  tags: readonly Tag[];
  scope: LibraryScope;
  onSelect: (scope: LibraryScope) => void;
  /** Passed straight through from the queries, so the pane renders its own three states. */
  status: 'pending' | 'error' | 'success';
  error?: unknown;
  onRetry?: () => void;
}

export const CollectionTree = ({
  collections,
  tags,
  scope,
  onSelect,
  status,
  error,
  onRetry,
}: CollectionTreeProps): JSX.Element => {
  if (status === 'pending') return <LoadingState label="Loading collections…" />;
  if (status === 'error') {
    return <ErrorState label="Could not load the collections" error={error} onRetry={onRetry} />;
  }

  const roots = buildCollectionTree(collections);
  const selected = scopeKey(scope);

  return (
    <nav className="tree" aria-label="Collections and tags">
      <ul className="tree__list" role="tree" aria-label="Collections">
        <li role="none">
          <TreeButton
            label="All items"
            selected={selected === 'library'}
            depth={0}
            onSelect={() => onSelect({ kind: 'library' })}
          />
        </li>
        {roots.map((node) => (
          <CollectionBranch key={node.collection.id} node={node} depth={0} selected={selected} onSelect={onSelect} />
        ))}
      </ul>

      {collections.length === 0 ? (
        <EmptyState
          title="No collections"
          description="Nothing is filed yet. Collections and saved searches will appear here as you make them."
        />
      ) : null}

      <h3 className="tree__heading">Tags</h3>
      {tags.length === 0 ? (
        <p className="section__note">No tags in this library.</p>
      ) : (
        <ul className="tree__list" role="tree" aria-label="Tags">
          {tags.map((tag) => (
            <li key={tag.id} role="none">
              <TreeButton
                label={tag.name}
                selected={selected === `tag:${tag.id}`}
                depth={0}
                colour={tag.colour ?? undefined}
                onSelect={() => onSelect({ kind: 'tag', tagId: tag.id })}
              />
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
};

interface CollectionBranchProps {
  node: CollectionNode;
  depth: number;
  selected: string;
  onSelect: (scope: LibraryScope) => void;
}

const CollectionBranch = ({ node, depth, selected, onSelect }: CollectionBranchProps): JSX.Element => (
  <li role="none">
    <TreeButton
      label={node.collection.name}
      selected={selected === `collection:${node.collection.id}`}
      depth={depth}
      count={node.collection.itemCount}
      smart={node.collection.kind === 'smart'}
      colour={node.collection.colour ?? undefined}
      onSelect={() => onSelect({ kind: 'collection', collectionId: node.collection.id })}
    />
    {node.children.length === 0 ? null : (
      <ul className="tree__list" role="group">
        {node.children.map((child) => (
          <CollectionBranch
            key={child.collection.id}
            node={child}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </ul>
    )}
  </li>
);

interface TreeButtonProps {
  label: string;
  selected: boolean;
  depth: number;
  count?: number;
  smart?: boolean;
  colour?: string;
  onSelect: () => void;
}

const TreeButton = ({ label, selected, depth, count, smart, colour, onSelect }: TreeButtonProps): JSX.Element => (
  <button
    type="button"
    role="treeitem"
    aria-selected={selected}
    aria-level={depth + 1}
    className="tree__item"
    data-selected={selected ? 'true' : 'false'}
    data-focus-target={selected ? 'true' : undefined}
    style={{ paddingInlineStart: `${0.5 + depth * 0.9}rem` }}
    onClick={onSelect}
  >
    {colour === undefined ? null : <span className="tree__swatch" aria-hidden="true" style={{ background: colour }} />}
    <span className="tree__label">{label}</span>
    {smart === true ? <span className="badge badge--quiet">saved search</span> : null}
    {count === undefined ? null : <span className="tree__count">{count}</span>}
  </button>
);
