/**
 * The tags section.
 *
 * Each tag shows where it came from — typed, applied by an ingestion rule, written by a resolver,
 * carried in from an import. "Why is this tagged?" is a question the data model answers
 * (`ItemTag.source`, `ruleRef`, `confidence`), so the pane answers it too rather than showing an
 * undifferentiated row of chips.
 *
 * Adding and removing writes `tagNames`, which is the whole set: the contract has no
 * add-one-tag operation, and inventing one in the client would be a second way of doing it that
 * the CLI and the R package do not have (P6).
 */
import { useState } from 'react';

import { ErrorState } from '../../components/states.js';
import { useUpdateItem } from '../../api/queries.js';
import type { ItemPaneSectionProps } from '../registry.js';

export const TagsSection = ({ item }: ItemPaneSectionProps): JSX.Element => {
  const tags = item.tags ?? [];
  const update = useUpdateItem(item.id);
  const [draft, setDraft] = useState('');

  const writeNames = (names: string[]): void => {
    update.mutate({ patch: { tagNames: names }, expectedVersion: item.version });
  };

  const add = (): void => {
    const name = draft.trim();
    if (name === '') return;
    if (tags.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) {
      setDraft('');
      return;
    }
    setDraft('');
    writeNames([...tags.map((tag) => tag.name), name]);
  };

  return (
    <div className="tags">
      {update.isError ? (
        <ErrorState label="The tags were not saved" error={update.error} onRetry={() => update.reset()} />
      ) : null}

      {tags.length === 0 ? (
        <p className="section__note">No tags.</p>
      ) : (
        <ul className="tags__list">
          {tags.map((tag) => (
            <li key={tag.tagId} className="tags__item" data-testid={`tag-${tag.name}`}>
              <span
                className="tags__swatch"
                aria-hidden="true"
                style={tag.colour === null || tag.colour === undefined ? undefined : { background: tag.colour }}
              />
              <span className="tags__name">{tag.name}</span>
              <span className="badge badge--quiet" title={tag.ruleRef ?? undefined}>
                {tag.source}
              </span>
              <button
                type="button"
                className="button button--small"
                aria-label={`Remove tag ${tag.name}`}
                onClick={() => writeNames(tags.filter((other) => other.tagId !== tag.tagId).map((other) => other.name))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="tags__add">
        <label className="field__label" htmlFor={`add-tag-${item.id}`}>
          Add a tag
        </label>
        <input
          id={`add-tag-${item.id}`}
          className="field__input"
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
          }}
        />
        <button type="button" className="button button--small" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
};
