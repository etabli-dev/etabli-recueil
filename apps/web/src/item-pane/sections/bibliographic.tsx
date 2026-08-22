/**
 * The bibliographic section: the editable facet, with provenance and lock state per field.
 *
 * The write is deliberately narrow. `PATCH /items/{id}` takes a partial `ItemUpdate`, and a manual
 * write locks every field it touches (P4-1) — so the patch carries the one field that changed and
 * nothing else. Echoing the whole facet back would lock all seventy of its fields against every
 * resolver, permanently, as a side effect of correcting a typo.
 */
import { useState } from 'react';
import type { BibliographicFacetUpdate, FieldProvenanceEntry, Item } from '@recueil/schemas';

import { ErrorState } from '../../components/states.js';
import { useUnlockFields, useUpdateItem } from '../../api/queries.js';
import { FieldRow } from '../field-row.js';
import { bibliographicFieldGroups } from '../fields.js';
import type { BibliographicFieldPath } from '../fields.js';
import type { ItemPaneSectionProps } from '../registry.js';

export const BibliographicSection = ({ item }: ItemPaneSectionProps): JSX.Element => {
  const facet = item.bibliographic ?? null;
  const update = useUpdateItem(item.id);
  const unlock = useUnlockFields(item.id);
  const [pendingField, setPendingField] = useState<string | null>(null);

  if (facet === null) {
    return <p className="section__note">This item has no bibliographic facet.</p>;
  }

  const locked = new Set<string>(facet.lockedFields ?? []);
  for (const [path, entry] of Object.entries(facet.provenance ?? {})) {
    if ((entry as FieldProvenanceEntry).locked) locked.add(path);
  }

  const commit = (path: BibliographicFieldPath, value: string | number | null): void => {
    setPendingField(path);
    const bibliographic = { [path]: value } as BibliographicFacetUpdate;
    update.mutate(
      { patch: { bibliographic }, expectedVersion: item.version },
      { onSettled: () => setPendingField(null) },
    );
  };

  return (
    <div className="bibliographic">
      {update.isError ? (
        <ErrorState label="The change was not saved" error={update.error} onRetry={() => update.reset()} />
      ) : null}
      {unlock.isError ? <ErrorState label="The field was not unlocked" error={unlock.error} /> : null}

      {bibliographicFieldGroups().map(({ group, fields }) => (
        <fieldset key={group} className="field-group">
          <legend>{group}</legend>
          {fields.map((descriptor) => (
            <FieldRow
              key={descriptor.path}
              descriptor={descriptor}
              value={(facet as Record<string, unknown>)[descriptor.path]}
              provenance={facet.provenance?.[descriptor.path]}
              locked={locked.has(descriptor.path)}
              saving={pendingField === descriptor.path && update.isPending}
              onCommit={(value) => commit(descriptor.path, value)}
              onUnlock={() => unlock.mutate([descriptor.path])}
            />
          ))}
        </fieldset>
      ))}

      <CreatorList item={item} />
    </div>
  );
};

/**
 * The author list, read-only in Phase 1.
 *
 * Reordering, splitting and merging creators is identity resolution, which belongs with the
 * disambiguation work in Phase 5 rather than being half-built here.
 */
const CreatorList = ({ item }: { item: Item }): JSX.Element => {
  const creators = item.creators ?? [];
  if (creators.length === 0) {
    return (
      <div className="field-group">
        <p className="section__note">No creators recorded.</p>
      </div>
    );
  }
  return (
    <fieldset className="field-group">
      <legend>Creators</legend>
      <ol className="creators">
        {creators.map((creator) => (
          <li key={`${creator.ordinal}-${creator.creatorId ?? creator.rawName ?? ''}`}>
            <span className="creators__name">
              {creator.creator?.displayName ?? creator.rawName ?? 'Unnamed creator'}
            </span>
            <span className="creators__role">{creator.role}</span>
            {creator.affiliationRaw === null || creator.affiliationRaw === undefined ? null : (
              <span className="creators__affiliation">{creator.affiliationRaw}</span>
            )}
          </li>
        ))}
      </ol>
    </fieldset>
  );
};
