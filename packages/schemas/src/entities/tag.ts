/**
 * Tag — a flat, free-text label (`spec/data-model.md` §4.3).
 *
 * Distinct from a Term: a tag is something the user typed, a term is a controlled-vocabulary
 * entry. The optional `termId` binding is what lets a co-word map roll tags up through a
 * thesaurus (CONCEPT.md §5.8).
 */
import * as z from 'zod';

import {
  ConfidenceSchema,
  CountSchema,
  HexColourSchema,
  IdSchema,
  ShortTextSchema,
  TimestampSchema,
} from '../primitives.js';
import { AssignmentSourceSchema, TagSchemeSchema } from '../vocabularies.js';

const tagWritableShape = {
  name: ShortTextSchema.meta({ description: 'As typed.' }),
  colour: HexColourSchema.nullish(),
  scheme: TagSchemeSchema.optional().meta({ description: 'Defaults to `manual`.' }),
  termId: IdSchema.nullish().meta({ description: 'Optional controlled-vocabulary binding.' }),
  position: CountSchema.optional().meta({ description: 'Pinned-tag ordering.' }),
} as const;

export const TagSchema = z
  .strictObject({
    id: IdSchema,
    nameNormalised: ShortTextSchema.meta({
      description: 'NFKC, casefolded, whitespace-collapsed. The uniqueness key, maintained by the application.',
    }),
    ownerUserId: IdSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    trashedAt: TimestampSchema.nullish(),
    ...tagWritableShape,
    scheme: TagSchemeSchema,
    position: CountSchema,
  })
  .meta({
    id: 'Tag',
    title: 'Tag',
    description: 'A free-text label. Renaming a tag is an update, not a create-and-remap: assignments follow (TG1).',
  });

export const TagCreateSchema = z
  .strictObject(tagWritableShape)
  .meta({ id: 'TagCreate', title: 'TagCreate', unusedIO: 'input' });

export const TagUpdateSchema = z
  .strictObject(tagWritableShape)
  .partial()
  .meta({ id: 'TagUpdate', title: 'TagUpdate', unusedIO: 'input' });

/** A tag as it hangs off an item, with the reason it is there (P4, "why is this tagged"). */
export const ItemTagSchema = z
  .strictObject({
    tagId: IdSchema,
    name: ShortTextSchema,
    colour: HexColourSchema.nullish(),
    source: AssignmentSourceSchema,
    ruleRef: z
      .string()
      .max(128)
      .nullish()
      .meta({ description: 'The ingestion rule that applied it (CONCEPT.md §5.3 stage 8).' }),
    confidence: ConfidenceSchema.nullish(),
    addedAt: TimestampSchema,
  })
  .meta({ id: 'ItemTag', title: 'ItemTag' });

export type Tag = z.infer<typeof TagSchema>;
export type TagCreate = z.infer<typeof TagCreateSchema>;
export type TagUpdate = z.infer<typeof TagUpdateSchema>;
export type ItemTag = z.infer<typeof ItemTagSchema>;
