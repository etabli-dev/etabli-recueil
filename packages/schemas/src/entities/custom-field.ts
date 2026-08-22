/**
 * CustomField and FieldValue (`spec/data-model.md` §4.6, §4.7).
 *
 * One mechanism carries three things: Paperless-ngx custom fields, user-defined library fields and
 * systematic-review extraction variables. That is why CONCEPT.md §5.10 can say extraction forms
 * are "generated from custom-field schemas" rather than describing a second, parallel machinery.
 *
 * The value is a discriminated union on the field's data type rather than a stringly-typed blob,
 * so that numbers sort, dates range-query and the Parquet export emits a correctly typed column
 * without inference (ADR-0008).
 */
import * as z from 'zod';

import {
  CalendarDateSchema,
  CountSchema,
  CurrencyCodeSchema,
  IdSchema,
  JsonObjectSchema,
  JsonValueSchema,
  LongTextSchema,
  ShortTextSchema,
  SlugSchema,
  TimestampSchema,
  UrlSchema,
} from '../primitives.js';
import { CustomFieldDataTypeSchema, CustomFieldScopeSchema } from '../vocabularies.js';

export const FieldKeySchema = SlugSchema.meta({
  id: 'FieldKey',
  title: 'FieldKey',
  description: 'Stable slug, used in the API, in exports and as the Parquet column name.',
  examples: ['sample_size'],
});

/* -------------------------------------------------------------------------------------------- */
/* The field definition                                                                            */
/* -------------------------------------------------------------------------------------------- */

const customFieldWritableShape = {
  fieldKey: FieldKeySchema,
  name: ShortTextSchema.meta({ description: 'Display label.' }),
  description: ShortTextSchema.nullish(),
  dataType: CustomFieldDataTypeSchema,
  config: JsonObjectSchema.optional().meta({
    description:
      'Type-dependent: `choices`, `min`, `max`, `step`, `unit`, `currency`, `pattern`, and ' +
      '`targetItemTypes` for references.',
  }),
  appliesToItemTypes: z
    .array(SlugSchema)
    .max(128)
    .nullish()
    .meta({ description: 'Null means "any item type".' }),
  isRequired: z
    .boolean()
    .optional()
    .meta({ description: 'Advisory: enforced by the `completeness` check, not by SQL, because requiredness is per item type.' }),
  isRepeatable: z.boolean().optional(),
  scope: CustomFieldScopeSchema.optional().meta({ description: 'Defaults to `library`. `review` fields appear only on extraction forms.' }),
  position: CountSchema.optional(),
} as const;

export const CustomFieldSchema = z
  .strictObject({
    id: IdSchema,
    pluginId: IdSchema.nullish().meta({ description: 'Set when a plugin declared the field.' }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    ...customFieldWritableShape,
    config: JsonObjectSchema,
    isRequired: z.boolean(),
    isRepeatable: z.boolean(),
    scope: CustomFieldScopeSchema,
    position: CountSchema,
  })
  .meta({
    id: 'CustomField',
    title: 'CustomField',
    description:
      'A user- or plugin-defined typed field. The data type is immutable once any value exists: ' +
      'changing it is a create-plus-migrate operation, never an in-place alteration (CF1).',
  });

export const CustomFieldCreateSchema = z
  .strictObject(customFieldWritableShape)
  .meta({ id: 'CustomFieldCreate', title: 'CustomFieldCreate', unusedIO: 'input' });

/** `fieldKey` and `dataType` are absent by design: both are immutable (CF1). */
export const CustomFieldUpdateSchema = z
  .strictObject({
    name: ShortTextSchema,
    description: ShortTextSchema.nullish(),
    config: JsonObjectSchema,
    appliesToItemTypes: z.array(SlugSchema).max(128).nullish(),
    isRequired: z.boolean(),
    isRepeatable: z.boolean(),
    position: CountSchema,
  })
  .partial()
  .meta({ id: 'CustomFieldUpdate', title: 'CustomFieldUpdate', unusedIO: 'input' });

/* -------------------------------------------------------------------------------------------- */
/* The value                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * The typed value itself. The discriminant is the field's data type, so a value can be validated
 * against its definition with a single lookup, and a mismatched pair fails at the boundary rather
 * than in the analytics export (invariant FV1).
 */
export const FieldValueContentSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), value: z.string().max(4096) }),
    z.strictObject({ type: z.literal('long_text'), value: LongTextSchema }),
    z.strictObject({ type: z.literal('number'), value: z.number() }),
    z.strictObject({ type: z.literal('integer'), value: z.number().int() }),
    z.strictObject({ type: z.literal('boolean'), value: z.boolean() }),
    z.strictObject({ type: z.literal('date'), value: CalendarDateSchema }),
    z.strictObject({ type: z.literal('datetime'), value: TimestampSchema }),
    z.strictObject({ type: z.literal('choice'), value: z.string().max(255) }),
    z.strictObject({ type: z.literal('multi_choice'), value: z.array(z.string().max(255)).max(256) }),
    z.strictObject({ type: z.literal('json'), value: JsonValueSchema }),
    z.strictObject({ type: z.literal('item_reference'), value: IdSchema }),
    z.strictObject({ type: z.literal('url'), value: UrlSchema }),
    z.strictObject({
      type: z.literal('monetary'),
      value: z.number().meta({ description: 'Major units. `config.currency` names the unit.' }),
      currency: CurrencyCodeSchema.optional(),
    }),
  ])
  .meta({
    id: 'FieldValueContent',
    title: 'FieldValueContent',
    description: 'A custom-field value, discriminated by the data type of its field.',
  });

const fieldValueWritableShape = {
  fieldId: IdSchema,
  itemId: IdSchema,
  reviewId: IdSchema.nullish().meta({
    description:
      'Null means library data; set means extraction data for that review, so the same item can ' +
      'hold different values of the same field in two reviews without collision (FV2).',
  }),
  extractionFormId: IdSchema.nullish(),
  groupKey: z
    .string()
    .max(128)
    .nullish()
    .meta({ description: 'The repeatable group instance: `arm:intervention`, `outcome:mortality_30d`.' }),
  ordinal: CountSchema.optional().meta({ description: 'Position within a repeatable field. Requires `isRepeatable` (FV3).' }),
  content: FieldValueContentSchema.nullish(),
  isBlank: z
    .boolean()
    .optional()
    .meta({
      description:
        'An explicit "not reported", which is a different fact from "not yet extracted" — the ' +
        'latter is the absence of the row entirely.',
    }),
} as const;

const checkExactlyOneValue = (
  value: { content?: unknown; isBlank?: boolean },
  ctx: z.RefinementCtx,
): void => {
  const hasContent = value.content !== undefined && value.content !== null;
  if (hasContent && value.isBlank === true) {
    ctx.addIssue({
      code: 'custom',
      message: 'a value is either recorded or explicitly blank, never both (ck_field_values_one_value)',
      path: ['isBlank'],
    });
  }
  if (!hasContent && value.isBlank !== true) {
    ctx.addIssue({
      code: 'custom',
      message: 'a field value needs content, or isBlank set to record "not reported" (ck_field_values_one_value)',
      path: ['content'],
    });
  }
};

export const FieldValueSchema = z
  .strictObject({
    id: IdSchema,
    fieldKey: FieldKeySchema.optional().meta({ description: 'The field slug, echoed so a reader needs no second lookup.' }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    createdByUserId: IdSchema.nullish(),
    ...fieldValueWritableShape,
    ordinal: CountSchema,
    isBlank: z.boolean(),
  })
  .superRefine(checkExactlyOneValue)
  .meta({ id: 'FieldValue', title: 'FieldValue', description: 'One value of one custom field on one item.' });

export const FieldValueCreateSchema = z
  .strictObject(fieldValueWritableShape)
  .superRefine(checkExactlyOneValue)
  .meta({ id: 'FieldValueCreate', title: 'FieldValueCreate', unusedIO: 'input' });

export const FieldValueUpdateSchema = z
  .strictObject({
    content: FieldValueContentSchema.nullish(),
    isBlank: z.boolean().optional(),
  })
  .superRefine(checkExactlyOneValue)
  .meta({ id: 'FieldValueUpdate', title: 'FieldValueUpdate', unusedIO: 'input' });

export type CustomField = z.infer<typeof CustomFieldSchema>;
export type CustomFieldCreate = z.infer<typeof CustomFieldCreateSchema>;
export type CustomFieldUpdate = z.infer<typeof CustomFieldUpdateSchema>;
export type FieldValueContent = z.infer<typeof FieldValueContentSchema>;
export type FieldValue = z.infer<typeof FieldValueSchema>;
export type FieldValueCreate = z.infer<typeof FieldValueCreateSchema>;
export type FieldValueUpdate = z.infer<typeof FieldValueUpdateSchema>;
