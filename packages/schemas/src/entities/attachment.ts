/**
 * Attachment — the many-to-many between items and documents (`spec/data-model.md` §3.8).
 *
 * The role enum is the point of the table: an item can hold a scan, a supplement and a web
 * snapshot at once, and the same PDF shared by two items is still stored once (ADR-0004).
 *
 * `ck_attachments_link_mode` is reproduced here as a refinement, because a `linked_url` attachment
 * with no URL is a broken record the API should never accept in the first place.
 */
import * as z from 'zod';

import { CountSchema, IdSchema, ShortTextSchema, TimestampSchema, UrlSchema } from '../primitives.js';
import {
  AttachmentLinkModeSchema,
  AttachmentRoleSchema,
  AttachmentSourceSchema,
} from '../vocabularies.js';
import { MimeTypeSchema } from './document.js';

const attachmentWritableShape = {
  itemId: IdSchema,
  documentId: IdSchema.nullish().meta({
    description: 'Null only for `linked_url`, which has no bytes in any Recueil backend.',
  }),
  role: AttachmentRoleSchema,
  linkMode: AttachmentLinkModeSchema,
  title: ShortTextSchema.nullish().meta({ description: 'Display label; defaults to the document filename.' }),
  url: UrlSchema.nullish().meta({ description: 'Required for `linked_url`; the capture URL for a snapshot.' }),
  linkedPath: z
    .string()
    .max(4096)
    .nullish()
    .meta({ description: 'Required for `linked_file`; absolute path on the machine that owns the link.' }),
  contentTypeHint: MimeTypeSchema.nullish().meta({
    description: 'Declared MIME for linked attachments, where nothing can be sniffed.',
  }),
} as const;

const attachmentServerShape = {
  id: IdSchema,
  hasAnnotations: z
    .boolean()
    .meta({ description: 'Denormalised from annotations so the reader needs no join (AT4).' }),
  annotationCount: CountSchema,
  position: CountSchema.meta({ description: 'Sort order within the item.' }),
  source: AttachmentSourceSchema,
  addedAt: TimestampSchema,
  addedByUserId: IdSchema.nullish(),
  updatedAt: TimestampSchema,
  trashedAt: TimestampSchema.nullish(),
} as const;

const checkLinkMode = (
  value: {
    linkMode?: string;
    documentId?: string | null;
    url?: string | null;
    linkedPath?: string | null;
  },
  ctx: z.RefinementCtx,
): void => {
  const has = (candidate: unknown): boolean => candidate !== undefined && candidate !== null;
  switch (value.linkMode) {
    case 'stored':
      if (!has(value.documentId)) {
        ctx.addIssue({
          code: 'custom',
          message: 'a stored attachment must reference a document (ck_attachments_link_mode)',
          path: ['documentId'],
        });
      }
      break;
    case 'linked_url':
      if (!has(value.url)) {
        ctx.addIssue({
          code: 'custom',
          message: 'a linked_url attachment must carry a url (ck_attachments_link_mode)',
          path: ['url'],
        });
      }
      if (has(value.documentId)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'a linked_url attachment has no bytes, so it must not reference a document (ck_attachments_link_mode)',
          path: ['documentId'],
        });
      }
      break;
    case 'linked_file':
      if (!has(value.linkedPath)) {
        ctx.addIssue({
          code: 'custom',
          message: 'a linked_file attachment must carry a linkedPath (ck_attachments_link_mode)',
          path: ['linkedPath'],
        });
      }
      if (has(value.documentId)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'a linked_file attachment is outside the store, so it must not reference a document (ck_attachments_link_mode)',
          path: ['documentId'],
        });
      }
      break;
    default:
      break;
  }
};

export const AttachmentSchema = z
  .strictObject({ ...attachmentServerShape, ...attachmentWritableShape })
  .superRefine(checkLinkMode)
  .meta({
    id: 'Attachment',
    title: 'Attachment',
    description:
      'One file in one role for one item. Detaching soft-deletes this row only; the document ' +
      'survives, because storage reclamation is a separate, explicit operation (AT2).',
  });

export const AttachmentCreateSchema = z
  .strictObject({
    ...attachmentWritableShape,
    position: CountSchema.optional(),
    source: AttachmentSourceSchema.optional().meta({ description: 'Defaults to `manual`.' }),
  })
  .superRefine(checkLinkMode)
  .meta({ id: 'AttachmentCreate', title: 'AttachmentCreate', unusedIO: 'input' });

/** The item an attachment hangs off never changes by update; re-parenting is what a merge does. */
export const AttachmentUpdateSchema = z
  .strictObject({
    role: AttachmentRoleSchema,
    title: ShortTextSchema.nullish(),
    url: UrlSchema.nullish(),
    linkedPath: z.string().max(4096).nullish(),
    contentTypeHint: MimeTypeSchema.nullish(),
    position: CountSchema,
  })
  .partial()
  .meta({ id: 'AttachmentUpdate', title: 'AttachmentUpdate', unusedIO: 'input' });

export type Attachment = z.infer<typeof AttachmentSchema>;
export type AttachmentCreate = z.infer<typeof AttachmentCreateSchema>;
export type AttachmentUpdate = z.infer<typeof AttachmentUpdateSchema>;
