/**
 * Annotation — a reading annotation as a first-class record in the W3C Web Annotation shape
 * (ADR-0009, ADR-0017, `spec/data-model.md` §4.9).
 *
 * The target is a **document**, not an item, because the annotation belongs to the bytes. That is
 * the whole point of ADR-0009: the underlying file is never rewritten, so its hash stays stable
 * (ADR-0004, invariant D3), the same annotation renders in PDF.js on every platform, and export to
 * embedded PDF annotations is a conversion producing a new document — never the storage format.
 *
 * Two shapes live here. `Annotation` is the Recueil record, which is what the API reads and
 * writes. `WebAnnotation` is the interchange projection: the same record as conformant Web
 * Annotation JSON-LD, which is what an export or a third-party reader consumes.
 */
import * as z from 'zod';

import {
  HexColourSchema,
  IdSchema,
  LongTextSchema,
  PublicIdSchema,
  ShortTextSchema,
  TimestampSchema,
  UrlSchema,
} from '../primitives.js';
import {
  AnnotationBodyFormatSchema,
  AnnotationMotivationSchema,
  AnnotationTypeSchema,
} from '../vocabularies.js';

/* -------------------------------------------------------------------------------------------- */
/* Selectors                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export const TextQuoteSelectorSchema = z
  .strictObject({
    type: z.literal('TextQuoteSelector'),
    exact: LongTextSchema,
    prefix: z.string().max(4096).optional(),
    suffix: z.string().max(4096).optional(),
  })
  .meta({
    id: 'TextQuoteSelector',
    title: 'TextQuoteSelector',
    description: 'W3C text quote selector: the quoted text with enough context to relocate it.',
  });

export const TextPositionSelectorSchema = z
  .strictObject({
    type: z.literal('TextPositionSelector'),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    if (value.end < value.start) {
      ctx.addIssue({ code: 'custom', message: 'end must not precede start', path: ['end'] });
    }
  })
  .meta({
    id: 'TextPositionSelector',
    title: 'TextPositionSelector',
    description: 'W3C text position selector, over the extracted text layer.',
  });

export const FragmentSelectorSchema = z
  .strictObject({
    type: z.literal('FragmentSelector'),
    conformsTo: z
      .string()
      .max(255)
      .optional()
      .meta({ description: 'The fragment specification, e.g. `http://tools.ietf.org/rfc/rfc3778` for PDF.' }),
    value: z.string().max(255).meta({ description: 'The fragment itself, e.g. `page=7`.', examples: ['page=7'] }),
  })
  .meta({
    id: 'FragmentSelector',
    title: 'FragmentSelector',
    description: 'W3C fragment selector. For PDFs this carries the page, and it resolves without any text layer.',
  });

/**
 * A rectangle in PDF user-space units, origin bottom-left, as PDF itself measures.
 *
 * Recueil extension to the W3C selector set. §4.9 is explicit that the selector is "the one place
 * where the model is deliberately document-format-dependent"; area and ink annotations have no
 * standard selector, and inventing an opaque one would defeat P10.
 */
export const RectangleSelectorSchema = z
  .strictObject({
    type: z.literal('RectangleSelector'),
    pageIndex: z.number().int().min(0).meta({ description: 'Zero-based physical page.' }),
    rectangles: z
      .array(
        z.strictObject({
          x: z.number(),
          y: z.number(),
          width: z.number().min(0),
          height: z.number().min(0),
        }),
      )
      .min(1)
      .max(1024),
  })
  .meta({
    id: 'RectangleSelector',
    title: 'RectangleSelector',
    description:
      'Recueil extension: page-anchored rectangles in PDF user-space units. Resolvable without ' +
      'the text layer, which is what invariant AN4 requires of every annotation.',
  });

/** Recueil extension: freehand ink, as page-anchored polylines. */
export const InkSelectorSchema = z
  .strictObject({
    type: z.literal('InkSelector'),
    pageIndex: z.number().int().min(0),
    paths: z
      .array(z.array(z.strictObject({ x: z.number(), y: z.number() })).min(2).max(4096))
      .min(1)
      .max(256),
    strokeWidth: z.number().min(0).optional(),
  })
  .meta({ id: 'InkSelector', title: 'InkSelector', description: 'Recueil extension: freehand ink as page-anchored polylines.' });

export const AnnotationSelectorSchema = z
  .discriminatedUnion('type', [
    TextQuoteSelectorSchema,
    TextPositionSelectorSchema,
    FragmentSelectorSchema,
    RectangleSelectorSchema,
    InkSelectorSchema,
  ])
  .meta({
    id: 'AnnotationSelector',
    title: 'AnnotationSelector',
    description: 'One selector. An annotation carries the whole set that located it.',
  });

/** Selectors that do not depend on the extracted text, and therefore satisfy invariant AN4. */
const TEXT_INDEPENDENT_SELECTORS = new Set(['FragmentSelector', 'RectangleSelector', 'InkSelector']);

export const AnnotationSelectorSetSchema = z
  .array(AnnotationSelectorSchema)
  .min(1)
  .max(16)
  .superRefine((selectors, ctx) => {
    if (!selectors.some((selector) => TEXT_INDEPENDENT_SELECTORS.has(selector.type))) {
      ctx.addIssue({
        code: 'custom',
        message:
          'at least one selector must resolve without the extracted text — a FragmentSelector page, ' +
          'rectangles or ink — so the annotation survives a text-layer change (AN4)',
        path: [],
      });
    }
  })
  .meta({
    id: 'AnnotationSelectorSet',
    title: 'AnnotationSelectorSet',
    description: 'The selectors that locate one annotation. At least one must not depend on the text layer (AN4).',
  });

/* -------------------------------------------------------------------------------------------- */
/* The record                                                                                      */
/* -------------------------------------------------------------------------------------------- */

const annotationWritableShape = {
  documentId: IdSchema.meta({ description: 'The W3C target source. The annotation belongs to the bytes (ADR-0009).' }),
  itemId: IdSchema.nullish().meta({ description: 'Reading context. A live attachment must exist for (itemId, documentId) (AN2).' }),
  attachmentId: IdSchema.nullish().meta({ description: 'The route by which the document was read.' }),
  annotationType: AnnotationTypeSchema,
  motivation: AnnotationMotivationSchema,
  selector: AnnotationSelectorSetSchema,
  bodyText: LongTextSchema.nullish().meta({ description: 'The comment attached to the annotation.' }),
  bodyFormat: AnnotationBodyFormatSchema.optional().meta({ description: 'Defaults to `markdown`.' }),
  colour: HexColourSchema.nullish(),
  pageIndex: z.number().int().min(0).nullish().meta({ description: 'Zero-based physical page.' }),
  pageLabel: z
    .string()
    .max(32)
    .nullish()
    .meta({ description: 'The printed page label, which is frequently not the physical index.' }),
  authorName: ShortTextSchema.nullish().meta({ description: 'For annotations imported from someone else.' }),
} as const;

const annotationServerShape = {
  id: IdSchema,
  publicId: PublicIdSchema,
  quotedText: LongTextSchema.nullish().meta({
    description: 'TextQuoteSelector.exact, lifted out of the selector so it can be full-text indexed.',
  }),
  prefixText: z.string().max(4096).nullish(),
  suffixText: z.string().max(4096).nullish(),
  positionSortKey: z
    .string()
    .max(64)
    .meta({ description: 'Fixed-width reading-order key (page, y, x) — the portable equivalent of Zotero sortIndex.' }),
  authorUserId: IdSchema.nullish(),
  isExternal: z
    .boolean()
    .meta({ description: 'True when extracted from annotations already embedded in the PDF at ingest.' }),
  externalRef: z
    .string()
    .max(255)
    .nullish()
    .meta({ description: "The embedded annotation's identity, so re-extraction does not duplicate (P9)." }),
  version: z.number().int().min(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  trashedAt: TimestampSchema.nullish(),
} as const;

const checkNoteHasBody = (
  value: { annotationType?: string; bodyText?: string | null },
  ctx: z.RefinementCtx,
): void => {
  if (value.annotationType === 'note' && !(typeof value.bodyText === 'string' && value.bodyText.length > 0)) {
    ctx.addIssue({
      code: 'custom',
      message: 'a note annotation is its body, so bodyText is required (ck_annotations_body)',
      path: ['bodyText'],
    });
  }
};

export const AnnotationSchema = z
  .strictObject({ ...annotationServerShape, ...annotationWritableShape, bodyFormat: AnnotationBodyFormatSchema })
  .superRefine(checkNoteHasBody)
  .meta({
    id: 'Annotation',
    title: 'Annotation',
    description:
      'A reading annotation as a record. The document bytes are never modified to store one; ' +
      'export to embedded PDF annotations produces a new document with its own hash (AN1).',
  });

export const AnnotationCreateSchema = z
  .strictObject({ ...annotationWritableShape, isExternal: z.boolean().optional(), externalRef: z.string().max(255).nullish() })
  .superRefine(checkNoteHasBody)
  .meta({ id: 'AnnotationCreate', title: 'AnnotationCreate', unusedIO: 'input' });

/** The target never moves: an annotation that belongs to different bytes is a different annotation. */
export const AnnotationUpdateSchema = z
  .strictObject({
    annotationType: AnnotationTypeSchema,
    motivation: AnnotationMotivationSchema,
    selector: AnnotationSelectorSetSchema,
    bodyText: LongTextSchema.nullish(),
    bodyFormat: AnnotationBodyFormatSchema,
    colour: HexColourSchema.nullish(),
    pageLabel: z.string().max(32).nullish(),
  })
  .partial()
  .superRefine(checkNoteHasBody)
  .meta({ id: 'AnnotationUpdate', title: 'AnnotationUpdate', unusedIO: 'input' });

/* -------------------------------------------------------------------------------------------- */
/* The interchange projection                                                                      */
/* -------------------------------------------------------------------------------------------- */

export const WEB_ANNOTATION_CONTEXT = 'http://www.w3.org/ns/anno.jsonld';

export const TextualBodySchema = z
  .strictObject({
    type: z.literal('TextualBody'),
    value: LongTextSchema,
    format: z.string().max(64).optional().meta({ examples: ['text/markdown'] }),
    language: z.string().max(32).optional(),
    purpose: AnnotationMotivationSchema.optional(),
  })
  .meta({ id: 'TextualBody', title: 'TextualBody' });

/**
 * The W3C Web Annotation JSON-LD form. This is what ADR-0009 means by "the storage format is the
 * W3C model": the record above is this document, normalised into columns, and this is what leaves
 * the library on export.
 */
export const WebAnnotationSchema = z
  .strictObject({
    '@context': z.literal(WEB_ANNOTATION_CONTEXT),
    id: UrlSchema.meta({ description: 'An absolute IRI for the annotation, e.g. the API URL of the record.' }),
    type: z.literal('Annotation'),
    motivation: AnnotationMotivationSchema,
    created: TimestampSchema,
    modified: TimestampSchema.optional(),
    creator: z
      .strictObject({
        id: z.string().max(512).optional(),
        type: z.enum(['Person', 'Organization', 'Software']).optional(),
        name: ShortTextSchema.optional(),
      })
      .optional(),
    body: z.array(TextualBodySchema).max(16).optional(),
    target: z.strictObject({
      source: z.string().max(512).meta({ description: 'The document IRI — `recueil:document/<id>` or an absolute URL.' }),
      selector: AnnotationSelectorSetSchema,
      styleClass: z.string().max(64).optional(),
    }),
    stylesheet: z
      .strictObject({ type: z.literal('CssStylesheet'), value: z.string().max(4096) })
      .optional(),
  })
  .meta({
    id: 'WebAnnotation',
    title: 'WebAnnotation',
    description: 'The W3C Web Annotation JSON-LD projection of an annotation record (ADR-0009).',
  });

export type AnnotationSelector = z.infer<typeof AnnotationSelectorSchema>;
export type AnnotationSelectorSet = z.infer<typeof AnnotationSelectorSetSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type AnnotationCreate = z.infer<typeof AnnotationCreateSchema>;
export type AnnotationUpdate = z.infer<typeof AnnotationUpdateSchema>;
export type WebAnnotation = z.infer<typeof WebAnnotationSchema>;
