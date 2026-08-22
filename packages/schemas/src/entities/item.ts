/**
 * Item — the library record (`spec/data-model.md` §3.4).
 *
 * An item exists independently of whether any file is attached. Facets hang off it: the
 * bibliographic facet for literature, the office facet for the invoices and letters that make up
 * the other half of a real library. Both may be present, and neither need be (invariant I1).
 */
import * as z from 'zod';

import {
  CountSchema,
  IdSchema,
  LongTextSchema,
  PublicIdSchema,
  ShortTextSchema,
  TimestampSchema,
} from '../primitives.js';
import { ItemTypeSchema, LibraryStateSchema } from '../vocabularies.js';
import { AttachmentSchema } from './attachment.js';
import { BibliographicFacetCreateSchema, BibliographicFacetSchema, BibliographicFacetUpdateSchema } from './bibliographic.js';
import { ItemCreatorInputSchema, ItemCreatorSchema } from './creator.js';
import { OfficeFacetCreateSchema, OfficeFacetSchema, OfficeFacetUpdateSchema } from './office.js';
import { ItemTagSchema } from './tag.js';

const itemWritableShape = {
  itemType: ItemTypeSchema,
  title: ShortTextSchema.nullish().meta({
    description:
      'Display title for every facet. Mirrors the bibliographic title when that facet exists, so ' +
      'that a list view never joins a facet table to render a row (I3).',
  }),
  extra: LongTextSchema.nullish().meta({
    description: "Zotero's free-text Extra field, preserved verbatim for round-tripping (P10).",
  }),
  sourceSystem: z
    .string()
    .max(64)
    .nullish()
    .meta({ description: '`zotero`, `paperless`, `bibtex`, `ris`, `connector`, …' }),
  sourceId: z
    .string()
    .max(255)
    .nullish()
    .meta({
      description:
        'The identifier in that system. Together with `sourceSystem` this is what makes the ' +
        'importers idempotent: a re-run updates the existing row rather than creating a twin (P9).',
    }),
} as const;

const itemServerShape = {
  id: IdSchema,
  publicId: PublicIdSchema,
  ownerUserId: IdSchema,
  libraryState: LibraryStateSchema,
  mergedIntoItemId: IdSchema.nullish().meta({
    description: 'Set when this item lost a dedup merge. Such an item is always trashed too (I2).',
  }),
  promotedFromShadowWorkId: IdSchema.nullish(),
  version: z
    .number()
    .int()
    .min(1)
    .meta({ description: 'Optimistic concurrency. Exposed as an ETag; a stale conditional write is rejected, not merged (P1).' }),
  dateAdded: TimestampSchema,
  dateModified: TimestampSchema,
  trashedAt: TimestampSchema.nullish(),
} as const;

/** Related records the API may expand into an item response on request. */
const itemExpansionShape = {
  bibliographic: BibliographicFacetSchema.nullish(),
  office: OfficeFacetSchema.nullish(),
  creators: z.array(ItemCreatorSchema).max(10_000).optional(),
  tags: z.array(ItemTagSchema).max(1000).optional(),
  collectionIds: z.array(IdSchema).max(1000).optional(),
  attachments: z.array(AttachmentSchema).max(1000).optional(),
  noteIds: z.array(IdSchema).max(1000).optional(),
} as const;

export const ItemSchema = z
  .strictObject({ ...itemServerShape, ...itemWritableShape, ...itemExpansionShape })
  .meta({
    id: 'Item',
    title: 'Item',
    description:
      'The library record — the thing a user thinks of as "an entry". Facets, creators, tags, ' +
      'collections and attachments are expanded on request; a bare item is the row itself.',
  });

export const ItemCreateSchema = z
  .strictObject({
    ...itemWritableShape,
    bibliographic: BibliographicFacetCreateSchema.optional(),
    office: OfficeFacetCreateSchema.optional(),
    creators: z.array(ItemCreatorInputSchema).max(10_000).optional(),
    tagNames: z.array(ShortTextSchema).max(1000).optional().meta({
      description: 'Tags by name. Unknown names are created; known ones are reused.',
    }),
    collectionIds: z.array(IdSchema).max(1000).optional(),
    dateAdded: TimestampSchema.optional().meta({ description: 'Importers preserve the original; ordinary writes leave it unset.' }),
  })
  .meta({ id: 'ItemCreate', title: 'ItemCreate', unusedIO: 'input' });

/**
 * A partial write. Facet updates are themselves partial, and every field written by hand takes a
 * `manual` provenance row and a lock with it (P4-1).
 */
export const ItemUpdateSchema = z
  .strictObject({
    ...itemWritableShape,
    bibliographic: BibliographicFacetUpdateSchema,
    office: OfficeFacetUpdateSchema,
    creators: z.array(ItemCreatorInputSchema).max(10_000),
    tagNames: z.array(ShortTextSchema).max(1000),
    collectionIds: z.array(IdSchema).max(1000),
  })
  .partial()
  .meta({ id: 'ItemUpdate', title: 'ItemUpdate', unusedIO: 'input' });

/** The row shape a list endpoint returns: enough to render a library row, and nothing more. */
export const ItemSummarySchema = z
  .strictObject({
    id: IdSchema,
    publicId: PublicIdSchema,
    itemType: ItemTypeSchema,
    title: ShortTextSchema.nullish(),
    creatorSummary: ShortTextSchema.nullish().meta({ description: 'Rendered author string, e.g. "Ravaud et al.".' }),
    issuedYear: z.number().int().min(1).max(2999).nullish(),
    containerTitle: ShortTextSchema.nullish(),
    attachmentCount: CountSchema,
    dateModified: TimestampSchema,
  })
  .meta({ id: 'ItemSummary', title: 'ItemSummary' });

export type Item = z.infer<typeof ItemSchema>;
export type ItemCreate = z.infer<typeof ItemCreateSchema>;
export type ItemUpdate = z.infer<typeof ItemUpdateSchema>;
export type ItemSummary = z.infer<typeof ItemSummarySchema>;
