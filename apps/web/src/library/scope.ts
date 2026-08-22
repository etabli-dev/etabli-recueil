/**
 * What the item list is showing — the left pane's selection, as one value.
 *
 * Collections, saved searches and tags are three ways of narrowing the same list, so they are one
 * discriminated union rather than three pieces of coordinated state. That is also what makes the
 * scope a URL: the middle pane's contents are addressable, and a link to "the unread items tagged
 * `to-read`" is a link rather than a sequence of clicks.
 */
import type { Collection, Tag } from '@recueil/schemas';

import type { ItemListQuery } from '../api/client.js';

export type LibraryScope =
  | { kind: 'library' }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'tag'; tagId: string };

export const LIBRARY_SCOPE: LibraryScope = { kind: 'library' };

export const scopeKey = (scope: LibraryScope): string => {
  switch (scope.kind) {
    case 'collection':
      return `collection:${scope.collectionId}`;
    case 'tag':
      return `tag:${scope.tagId}`;
    default:
      return 'library';
  }
};

/** The scope as query parameters. The server does the filtering; the client only names it. */
export const scopeToQuery = (scope: LibraryScope): Pick<ItemListQuery, 'collectionId' | 'tagId'> => {
  switch (scope.kind) {
    case 'collection':
      return { collectionId: scope.collectionId };
    case 'tag':
      return { tagId: scope.tagId };
    default:
      return {};
  }
};

export const scopeTitle = (
  scope: LibraryScope,
  collections: readonly Collection[],
  tags: readonly Tag[],
): string => {
  switch (scope.kind) {
    case 'collection': {
      const collection = collections.find((candidate) => candidate.id === scope.collectionId);
      return collection?.name ?? 'Unknown collection';
    }
    case 'tag': {
      const tag = tags.find((candidate) => candidate.id === scope.tagId);
      return tag === undefined ? 'Unknown tag' : `Tagged ${tag.name}`;
    }
    default:
      return 'All items';
  }
};

export interface CollectionNode {
  collection: Collection;
  children: CollectionNode[];
}

/**
 * The collection forest.
 *
 * The hierarchy is a forest, not a tree (invariant C1): several roots are normal. A node whose
 * parent is missing from the page — trashed, or beyond the page limit — is promoted to a root
 * rather than dropped, because a collection the user cannot see is worse than one in the wrong
 * place.
 */
export const buildCollectionTree = (collections: readonly Collection[]): CollectionNode[] => {
  const nodes = new Map<string, CollectionNode>();
  for (const collection of collections) {
    nodes.set(collection.id, { collection, children: [] });
  }

  const roots: CollectionNode[] = [];
  for (const collection of collections) {
    const node = nodes.get(collection.id);
    if (node === undefined) continue;
    const parentId = collection.parentId;
    const parent = parentId === null || parentId === undefined ? undefined : nodes.get(parentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  const byPosition = (left: CollectionNode, right: CollectionNode): number =>
    left.collection.position - right.collection.position ||
    left.collection.name.localeCompare(right.collection.name);

  const sortDeep = (list: CollectionNode[]): void => {
    list.sort(byPosition);
    for (const node of list) sortDeep(node.children);
  };
  sortDeep(roots);

  return roots;
};
