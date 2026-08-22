/**
 * Collection — the hierarchical filing structure, and saved searches (`spec/data-model.md` §4.1).
 *
 * A saved search is a collection whose membership is a query rather than a list, which keeps the
 * UI, the API, the `.bib` endpoint and the export path identical for both (CONCEPT.md §5.7).
 */
import * as z from 'zod';

import {
  CountSchema,
  HexColourSchema,
  IdSchema,
  JsonObjectSchema,
  PublicIdSchema,
  ShortTextSchema,
  TimestampSchema,
} from '../primitives.js';
import { CollectionKindSchema, QueryBackendSchema } from '../vocabularies.js';

const collectionWritableShape = {
  name: ShortTextSchema,
  parentId: IdSchema.nullish().meta({ description: 'Null for a root. The hierarchy is a forest (C1).' }),
  kind: CollectionKindSchema.optional().meta({ description: 'Defaults to `manual`.' }),
  query: JsonObjectSchema.nullish().meta({
    description: 'Required when `kind` is `smart`: the saved search in the structured query form.',
  }),
  queryBackend: QueryBackendSchema.nullish().meta({
    description: 'Recorded so a saved search built against one index is not reinterpreted by another (ADR-0011).',
  }),
  description: ShortTextSchema.nullish(),
  colour: HexColourSchema.nullish(),
  position: CountSchema.optional().meta({ description: 'Sort order among siblings.' }),
} as const;

const checkSmartQuery = (
  value: { kind?: string; query?: unknown },
  ctx: z.RefinementCtx,
): void => {
  const hasQuery = value.query !== undefined && value.query !== null;
  if (value.kind === 'smart' && !hasQuery) {
    ctx.addIssue({
      code: 'custom',
      message: 'a smart collection is defined by its query (ck_collections_smart)',
      path: ['query'],
    });
  }
  if (value.kind !== undefined && value.kind !== 'smart' && hasQuery) {
    ctx.addIssue({
      code: 'custom',
      message: 'only a smart collection carries a query (ck_collections_smart)',
      path: ['query'],
    });
  }
};

export const CollectionSchema = z
  .strictObject({
    id: IdSchema,
    publicId: PublicIdSchema.meta({ description: 'Used in `.bib` feed URLs.' }),
    nameNormalised: ShortTextSchema,
    ownerUserId: IdSchema,
    depth: CountSchema.meta({ description: 'Root is 0. Denormalised, rewritten for the whole subtree on move (C4).' }),
    itemCount: CountSchema.optional().meta({ description: 'Live members, when the caller asked for counts.' }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    trashedAt: TimestampSchema.nullish(),
    ...collectionWritableShape,
    kind: CollectionKindSchema,
    position: CountSchema,
  })
  .superRefine(checkSmartQuery)
  .meta({
    id: 'Collection',
    title: 'Collection',
    description:
      'A node in the filing hierarchy, or a saved search. Trashing a collection trashes its ' +
      'descendants but never its items (C3).',
  });

export const CollectionCreateSchema = z
  .strictObject(collectionWritableShape)
  .superRefine(checkSmartQuery)
  .meta({ id: 'CollectionCreate', title: 'CollectionCreate', unusedIO: 'input' });

export const CollectionUpdateSchema = z
  .strictObject(collectionWritableShape)
  .partial()
  .superRefine(checkSmartQuery)
  .meta({ id: 'CollectionUpdate', title: 'CollectionUpdate', unusedIO: 'input' });

/** Membership of a manual collection (`spec/data-model.md` §4.2). */
export const CollectionMembershipSchema = z
  .strictObject({
    collectionId: IdSchema,
    itemId: IdSchema,
    position: CountSchema,
    addedAt: TimestampSchema,
    addedByUserId: IdSchema.nullish(),
    source: z.string().max(32),
  })
  .meta({ id: 'CollectionMembership', title: 'CollectionMembership' });

export type Collection = z.infer<typeof CollectionSchema>;
export type CollectionCreate = z.infer<typeof CollectionCreateSchema>;
export type CollectionUpdate = z.infer<typeof CollectionUpdateSchema>;
export type CollectionMembership = z.infer<typeof CollectionMembershipSchema>;
