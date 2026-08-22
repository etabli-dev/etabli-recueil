/**
 * The office facet — `Item.Office` in CONCEPT.md §5.2, `item_office` in `spec/data-model.md` §3.7.
 *
 * This is the Paperless-ngx mapping: correspondent, document date, archive serial number, amount
 * and reference number. Invariant O1 keeps it small on purpose — anything beyond this set is a
 * custom field, not a new column.
 */
import * as z from 'zod';

import {
  CalendarDateSchema,
  CurrencyCodeSchema,
  IdSchema,
  ShortTextSchema,
  TimestampSchema,
} from '../primitives.js';
import { FieldProvenanceMapSchema, LockedFieldsSchema } from '../provenance.js';
import { OfficeDocumentTypeSchema } from '../vocabularies.js';

const officeWritableShape = {
  correspondent: ShortTextSchema.meta({ description: 'Free text, as extracted or entered.' }),
  correspondentCreatorId: IdSchema.nullish().meta({
    description: 'Optional promotion of the correspondent to an organisation creator record.',
  }),
  officeDocumentType: OfficeDocumentTypeSchema.nullish(),
  documentDate: CalendarDateSchema.nullish().meta({
    description: 'The date printed on the document, which is not the ingest date.',
  }),
  asn: z
    .number()
    .int()
    .min(1)
    .nullish()
    .meta({ description: 'Paperless archive serial number. Unique across live items.' }),
  referenceNumber: z.string().max(255).nullish(),
  amountMinor: z
    .number()
    .int()
    .nullish()
    .meta({ description: 'Minor units. Never a float — money is an integer plus a currency code.' }),
  amountCurrency: CurrencyCodeSchema.nullish(),
  dueDate: CalendarDateSchema.nullish(),
  periodStart: CalendarDateSchema.nullish(),
  periodEnd: CalendarDateSchema.nullish(),
} as const;

const officeDerivedShape = {
  correspondentNormalised: ShortTextSchema.nullish().meta({
    description: 'NFKC, casefolded, whitespace-collapsed. Maintained by the application for grouping and rules.',
  }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  provenance: FieldProvenanceMapSchema.optional(),
  lockedFields: LockedFieldsSchema.optional(),
} as const;

const checkOfficeInvariants = (
  value: {
    amountMinor?: number | null;
    amountCurrency?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
  },
  ctx: z.RefinementCtx,
): void => {
  const hasAmount = value.amountMinor !== undefined && value.amountMinor !== null;
  const hasCurrency = value.amountCurrency !== undefined && value.amountCurrency !== null;
  if (hasAmount !== hasCurrency) {
    ctx.addIssue({
      code: 'custom',
      message: 'an amount needs a currency and a currency needs an amount (ck_item_office_amount)',
      path: [hasAmount ? 'amountCurrency' : 'amountMinor'],
    });
  }
  if (
    typeof value.periodStart === 'string' &&
    typeof value.periodEnd === 'string' &&
    value.periodEnd < value.periodStart
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'periodEnd must not be before periodStart (ck_item_office_period)',
      path: ['periodEnd'],
    });
  }
};

export const OfficeFacetSchema = z
  .strictObject({ ...officeWritableShape, ...officeDerivedShape })
  .superRefine(checkOfficeInvariants)
  .meta({
    id: 'OfficeFacet',
    title: 'OfficeFacet',
    description: 'The private/office facet of an item — the Paperless-ngx mapping (CONCEPT.md §5.2).',
  });

export const OfficeFacetCreateSchema = z
  .strictObject(officeWritableShape)
  .superRefine(checkOfficeInvariants)
  .meta({ id: 'OfficeFacetCreate', title: 'OfficeFacetCreate', unusedIO: 'input' });

export const OfficeFacetUpdateSchema = z
  .strictObject(officeWritableShape)
  .partial()
  .superRefine(checkOfficeInvariants)
  .meta({ id: 'OfficeFacetUpdate', title: 'OfficeFacetUpdate', unusedIO: 'input' });

export type OfficeFacet = z.infer<typeof OfficeFacetSchema>;
export type OfficeFacetCreate = z.infer<typeof OfficeFacetCreateSchema>;
export type OfficeFacetUpdate = z.infer<typeof OfficeFacetUpdateSchema>;
