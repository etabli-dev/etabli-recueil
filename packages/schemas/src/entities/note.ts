/**
 * Note — markdown attached to an item, or standalone (`spec/data-model.md` §4.8).
 *
 * Also the destination for IMAP message bodies (CONCEPT.md §5.3) and for Citavi-style quotes and
 * thoughts. `contentMarkdown` is always populated, including for HTML imports, so the search index
 * and the export path read one field (N1); the original HTML is kept beside it so a Zotero note
 * round-trips losslessly (P10).
 */
import * as z from 'zod';

import {
  IdSchema,
  LongTextSchema,
  PublicIdSchema,
  ShortTextSchema,
  TimestampSchema,
} from '../primitives.js';
import { NoteKindSchema, NoteSourceFormatSchema } from '../vocabularies.js';

const noteWritableShape = {
  itemId: IdSchema.nullish().meta({ description: 'Null for a standalone note.' }),
  parentAnnotationId: IdSchema.nullish().meta({ description: 'A note written from a highlight keeps the link.' }),
  title: ShortTextSchema.nullish().meta({
    description: 'Derived from the first heading or line, and stored, so lists need no parsing.',
  }),
  contentMarkdown: LongTextSchema.meta({ description: 'The canonical content.' }),
  sourceFormat: NoteSourceFormatSchema.optional().meta({ description: 'Defaults to `markdown`.' }),
  contentOriginal: LongTextSchema.nullish().meta({
    description: 'The imported HTML when `sourceFormat` is `html`, kept verbatim (P10).',
  }),
  noteKind: NoteKindSchema.optional().meta({ description: 'Defaults to `note`.' }),
} as const;

const checkOriginalFormat = (
  value: { sourceFormat?: string; contentOriginal?: string | null },
  ctx: z.RefinementCtx,
): void => {
  const hasOriginal = typeof value.contentOriginal === 'string' && value.contentOriginal.length > 0;
  if (hasOriginal && value.sourceFormat !== undefined && value.sourceFormat !== 'html') {
    ctx.addIssue({
      code: 'custom',
      message: 'contentOriginal is the preserved HTML, so sourceFormat must be html',
      path: ['sourceFormat'],
    });
  }
};

export const NoteSchema = z
  .strictObject({
    id: IdSchema,
    publicId: PublicIdSchema,
    ownerUserId: IdSchema,
    version: z.number().int().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    trashedAt: TimestampSchema.nullish(),
    ...noteWritableShape,
    sourceFormat: NoteSourceFormatSchema,
    noteKind: NoteKindSchema,
  })
  .superRefine(checkOriginalFormat)
  .meta({ id: 'Note', title: 'Note', description: 'A markdown note, attached to an item or standalone.' });

export const NoteCreateSchema = z
  .strictObject(noteWritableShape)
  .superRefine(checkOriginalFormat)
  .meta({ id: 'NoteCreate', title: 'NoteCreate', unusedIO: 'input' });

export const NoteUpdateSchema = z
  .strictObject(noteWritableShape)
  .partial()
  .superRefine(checkOriginalFormat)
  .meta({ id: 'NoteUpdate', title: 'NoteUpdate', unusedIO: 'input' });

export type Note = z.infer<typeof NoteSchema>;
export type NoteCreate = z.infer<typeof NoteCreateSchema>;
export type NoteUpdate = z.infer<typeof NoteUpdateSchema>;
