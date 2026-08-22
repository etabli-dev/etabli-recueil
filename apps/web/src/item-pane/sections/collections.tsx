/**
 * The collections section: where this item is filed.
 *
 * The item carries `collectionIds`; the names come from the collection list the left pane already
 * fetched, so this section shares that cache rather than issuing a request of its own. An id whose
 * collection is missing from the list is shown as an id rather than silently dropped — a dangling
 * reference is something to see, not something to hide.
 */
import { useCollections, useUpdateItem } from '../../api/queries.js';
import { ErrorState } from '../../components/states.js';
import type { ItemPaneSectionProps } from '../registry.js';

export const CollectionsSection = ({ item }: ItemPaneSectionProps): JSX.Element => {
  const collections = useCollections();
  const update = useUpdateItem(item.id);
  const filedIn = item.collectionIds ?? [];

  const byId = new Map((collections.data?.data ?? []).map((collection) => [collection.id, collection]));

  const remove = (collectionId: string): void => {
    update.mutate({
      patch: { collectionIds: filedIn.filter((id) => id !== collectionId) },
      expectedVersion: item.version,
    });
  };

  return (
    <div className="collections-section">
      {update.isError ? (
        <ErrorState label="The filing was not saved" error={update.error} onRetry={() => update.reset()} />
      ) : null}

      {filedIn.length === 0 ? (
        <p className="section__note">Not filed in any collection.</p>
      ) : (
        <ul className="collections-section__list">
          {filedIn.map((collectionId) => {
            const collection = byId.get(collectionId);
            return (
              <li key={collectionId} data-testid={`filed-in-${collectionId}`}>
                <span>{collection?.name ?? collectionId}</span>
                {collection?.kind === 'smart' ? <span className="badge badge--quiet">saved search</span> : null}
                <button
                  type="button"
                  className="button button--small"
                  aria-label={`Remove from ${collection?.name ?? collectionId}`}
                  onClick={() => remove(collectionId)}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
