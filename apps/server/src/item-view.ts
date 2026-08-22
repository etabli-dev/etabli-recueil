/**
 * Assembling the item a client actually asked for.
 *
 * `GET /items/{id}` returns one record composed of six tables — the item row, its two facets, its
 * creators, its tags, its collection memberships, its attachments and the ids of its notes — and
 * that composition is needed identically by the item routes, the connector, and the export
 * selection. It lives here so there is one of it.
 *
 * The provenance maps are attached to the facets rather than offered separately, because the
 * contract puts them there (`BibliographicFacet.provenance`, `.lockedFields`) and because the
 * question a client asks is "where did this field come from", not "give me a provenance table".
 * They cost one indexed query each and are omitted when the caller did not ask.
 */
import type { Recueil } from '@recueil/core';
import type { Item } from '@recueil/schemas';

import {
  attachmentsFor,
  collectionIdsFor,
  itemTagsFor,
  noteIdsFor,
} from './queries.js';
import { itemToWire } from './wire.js';

export interface ItemViewOptions {
  /** Include a trashed item rather than treating it as absent (P5). */
  readonly includeTrashed?: boolean;
  /** Attach the per-field provenance maps and the lock lists to the facets (P4). */
  readonly withProvenance?: boolean;
}

/** The full item, as `GET /items/{id}` renders it. */
export const loadItemView = (recueil: Recueil, id: string, options: ItemViewOptions = {}): Item => {
  const record = recueil.library.getItem(id, {
    ...(options.includeTrashed === undefined ? {} : { includeTrashed: options.includeTrashed }),
  });

  return renderItemView(recueil, record, options);
};

/** The same, for a record already in hand — a create or an update has just returned one. */
export const renderItemView = (
  recueil: Recueil,
  record: ReturnType<Recueil['library']['getItem']>,
  options: ItemViewOptions = {},
): Item => {
  const id = record.item.id;
  const withProvenance = options.withProvenance === true;

  return itemToWire(record, {
    creators: recueil.creators.forItem(id),
    tags: itemTagsFor(recueil.db, id),
    collectionIds: collectionIdsFor(recueil.db, id),
    attachments: attachmentsFor(recueil.db, id, {
      ...(options.includeTrashed === undefined ? {} : { includeTrashed: options.includeTrashed }),
    }),
    noteIds: noteIdsFor(recueil.db, id),
    ...(withProvenance && record.bibliographic !== null
      ? {
          bibliographicContext: {
            provenance: recueil.provenance.map('item_bibliographic', id),
            lockedFields: recueil.provenance.lockedFields('item_bibliographic', id),
          },
        }
      : {}),
    ...(withProvenance && record.office !== null
      ? {
          officeContext: {
            provenance: recueil.provenance.map('item_office', id),
            lockedFields: recueil.provenance.lockedFields('item_office', id),
          },
        }
      : {}),
  });
};
