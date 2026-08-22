/**
 * Custom fields and their typed values (§4.6, §4.7).
 *
 * One mechanism carries three things — Paperless-ngx custom fields, user-defined library fields and
 * systematic-review extraction variables — which is what lets CONCEPT §5.10 say extraction forms
 * are "generated from custom-field schemas" rather than describing a second, parallel machinery.
 *
 * The value is stored in a **typed column**, chosen by the field's `data_type`, and not in one
 * stringly-typed blob. That is the whole reason this service is worth having:
 *
 * - **FV1.** The populated `value_*` column is determined by `custom_fields.data_type`. A value
 *   whose type does not match its field is refused at the boundary, with the field, the declared
 *   type and the offered type in the error — not discovered later by an analytics export that
 *   inferred a column type from the first thousand rows.
 * - **FV3.** `ordinal > 0` requires `is_repeatable`.
 * - **CF1.** `data_type` and `field_key` are immutable once the field exists. Changing a type is a
 *   create-plus-migrate operation, never an in-place `ALTER`.
 * - **CF2.** Deleting a field is refused while values exist; it is disabled instead.
 *
 * Validation runs against `@recueil/schemas`'s `FieldValueContentSchema` — the same discriminated
 * union the API validates with — and then against the field's own `config`: `choices` for a choice
 * field, `min`/`max` for a number, `targetItemTypes` for a reference. Two checks, because the first
 * says "this is a well-formed number" and the second says "this is a number this field allows".
 */
import {
  CustomFieldDataTypeSchema,
  FieldValueContentSchema,
  SLUG_PATTERN,
} from '@recueil/schemas';
import type { FieldValueContent } from '@recueil/schemas';
import { and, asc, count, eq, gt } from 'drizzle-orm';

import type { RecueilDatabase } from '../db/client.js';
import { customFields, fieldValues, items } from '../db/schema.js';
import type { CustomFieldRow, FieldValueRow } from '../db/schema.js';
import { ConflictError, InvariantError, NotFoundError, ValidationError } from '../errors.js';
import { newId } from '../ids.js';
import { scopeKey } from '../normalise.js';
import { nowTimestamp } from '../time.js';
import type { Actor } from './actor.js';
import type { AuditService } from './audit.js';
import { diffFields } from './audit.js';

export type CustomFieldDataType = (typeof CustomFieldDataTypeSchema)['options'][number];
export type CustomFieldScope = 'library' | 'review';

export interface DefineCustomFieldInput {
  fieldKey: string;
  name: string;
  description?: string | null;
  dataType: CustomFieldDataType;
  /** Type-dependent: `choices`, `min`, `max`, `step`, `unit`, `currency`, `targetItemTypes`. */
  config?: Record<string, unknown>;
  /** Null means "any item type". */
  appliesToItemTypes?: string[] | null;
  isRequired?: boolean;
  isRepeatable?: boolean;
  scope?: CustomFieldScope;
  position?: number;
}

/** `fieldKey` and `dataType` are absent by design: both are immutable (CF1). */
export interface UpdateCustomFieldInput {
  name?: string;
  description?: string | null;
  config?: Record<string, unknown>;
  appliesToItemTypes?: string[] | null;
  isRequired?: boolean;
  isRepeatable?: boolean;
  position?: number;
}

export interface SetFieldValueInput {
  /** Either identifier works; `fieldKey` is what an importer and a form have to hand. */
  fieldId?: string;
  fieldKey?: string;
  itemId: string;
  /** The typed value. Omit — with `isBlank` — to record an explicit "not reported". */
  content?: FieldValueContent | null;
  /** The repeatable group instance: `arm:intervention`, `outcome:mortality_30d`. */
  groupKey?: string | null;
  ordinal?: number;
  isBlank?: boolean;
}

/** A stored value, decoded back into the typed union the contract speaks. */
export interface DecodedFieldValue {
  row: FieldValueRow;
  field: CustomFieldRow;
  content: FieldValueContent | null;
}

export class CustomFieldService {
  constructor(
    private readonly db: RecueilDatabase,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------------------------- */
  /* Field definitions                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  define(input: DefineCustomFieldInput, actor: Actor): CustomFieldRow {
    if (!SLUG_PATTERN.test(input.fieldKey)) {
      throw new ValidationError(
        `Field key '${input.fieldKey}' is not a slug. It is the API name, the export name and the ` +
          'Parquet column name, so the shape is fixed: lowercase, starting with a letter, ' +
          'underscores only (§4.6).',
        { fieldKey: input.fieldKey },
      );
    }
    const dataType = CustomFieldDataTypeSchema.safeParse(input.dataType);
    if (!dataType.success) {
      throw new ValidationError(
        `Unknown custom-field data type '${String(input.dataType)}'.`,
        { dataType: input.dataType, known: CustomFieldDataTypeSchema.options },
      );
    }
    if (input.name.trim() === '') throw new ValidationError('A custom field needs a display name.');

    const config = input.config ?? {};
    validateFieldConfig(dataType.data, config);

    return this.db.transaction((tx) => {
      const clash = tx
        .select()
        .from(customFields)
        .where(eq(customFields.fieldKey, input.fieldKey))
        .get();
      if (clash !== undefined) {
        throw new ConflictError(`A custom field with key '${input.fieldKey}' already exists.`, {
          fieldKey: input.fieldKey,
          fieldId: clash.id,
        });
      }

      const now = nowTimestamp();
      const row: CustomFieldRow = {
        id: newId(),
        fieldKey: input.fieldKey,
        name: input.name.trim(),
        description: input.description ?? null,
        dataType: dataType.data,
        config: JSON.stringify(config),
        appliesToItemTypes:
          input.appliesToItemTypes === undefined || input.appliesToItemTypes === null
            ? null
            : JSON.stringify(input.appliesToItemTypes),
        isRequired: input.isRequired ?? false,
        isRepeatable: input.isRepeatable ?? false,
        scope: input.scope ?? 'library',
        position: input.position ?? 0,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(customFields).values(row).run();

      this.audit.record(
        {
          actor,
          action: 'custom_field.defined',
          entityType: 'custom_field',
          entityId: row.id,
          after: { fieldKey: row.fieldKey, dataType: row.dataType, scope: row.scope },
        },
        tx,
      );

      return row;
    });
  }

  getField(id: string): CustomFieldRow {
    const row = this.db.select().from(customFields).where(eq(customFields.id, id)).get();
    if (row === undefined) throw new NotFoundError('custom_field', id);
    return row;
  }

  getFieldByKey(fieldKey: string): CustomFieldRow {
    const row = this.db.select().from(customFields).where(eq(customFields.fieldKey, fieldKey)).get();
    if (row === undefined) throw new NotFoundError('custom_field', fieldKey);
    return row;
  }

  listFields(options: { scope?: CustomFieldScope } = {}): CustomFieldRow[] {
    return this.db
      .select()
      .from(customFields)
      .where(options.scope === undefined ? undefined : eq(customFields.scope, options.scope))
      .orderBy(asc(customFields.position), asc(customFields.fieldKey))
      .all();
  }

  /** Everything but the key and the type: both are immutable once the field exists (CF1). */
  updateField(id: string, patch: UpdateCustomFieldInput, actor: Actor): CustomFieldRow {
    return this.db.transaction((tx) => {
      const current = tx.select().from(customFields).where(eq(customFields.id, id)).get();
      if (current === undefined) throw new NotFoundError('custom_field', id);

      if (patch.config !== undefined) validateFieldConfig(current.dataType, patch.config);

      if (patch.isRepeatable === false && current.isRepeatable) {
        const repeated = tx
          .select({ value: count() })
          .from(fieldValues)
          .where(and(eq(fieldValues.fieldId, id), gt(fieldValues.ordinal, 0)))
          .get();
        if ((repeated?.value ?? 0) > 0) {
          throw new InvariantError(
            'FV3',
            `Field '${current.fieldKey}' has values at ordinal > 0; it cannot stop being repeatable ` +
              'while they exist.',
            { fieldId: id, fieldKey: current.fieldKey },
          );
        }
      }

      const now = nowTimestamp();
      const next = {
        name: patch.name === undefined ? current.name : patch.name.trim(),
        description: patch.description !== undefined ? patch.description : current.description,
        config: patch.config === undefined ? current.config : JSON.stringify(patch.config),
        appliesToItemTypes:
          patch.appliesToItemTypes === undefined
            ? current.appliesToItemTypes
            : patch.appliesToItemTypes === null
              ? null
              : JSON.stringify(patch.appliesToItemTypes),
        isRequired: patch.isRequired ?? current.isRequired,
        isRepeatable: patch.isRepeatable ?? current.isRepeatable,
        position: patch.position ?? current.position,
        updatedAt: now,
      };
      if (next.name === '') throw new ValidationError('A custom field needs a display name.');

      tx.update(customFields).set(next).where(eq(customFields.id, id)).run();

      const delta = diffFields(current as unknown as Record<string, unknown>, {
        name: next.name,
        description: next.description,
        config: next.config,
        isRequired: next.isRequired,
        isRepeatable: next.isRepeatable,
        position: next.position,
      });
      this.audit.record(
        {
          actor,
          action: 'custom_field.updated',
          entityType: 'custom_field',
          entityId: id,
          before: delta.before,
          after: delta.after,
        },
        tx,
      );

      return { ...current, ...next };
    });
  }

  /**
   * Remove a field definition (CF2).
   *
   * Refused while any value exists, and the error says how many. A field with values is disabled by
   * taking it off the forms that use it, not by deleting the column its data lives in.
   */
  removeField(id: string, actor: Actor): void {
    this.db.transaction((tx) => {
      const current = tx.select().from(customFields).where(eq(customFields.id, id)).get();
      if (current === undefined) throw new NotFoundError('custom_field', id);

      const existing =
        tx.select({ value: count() }).from(fieldValues).where(eq(fieldValues.fieldId, id)).get()
          ?.value ?? 0;
      if (existing > 0) {
        throw new InvariantError(
          'CF2',
          `Custom field '${current.fieldKey}' still has ${existing} value(s). Deleting a field is ` +
            'refused while values exist; disable it instead.',
          { fieldId: id, fieldKey: current.fieldKey, valueCount: existing },
        );
      }

      tx.delete(customFields).where(eq(customFields.id, id)).run();
      this.audit.record(
        {
          actor,
          action: 'custom_field.removed',
          entityType: 'custom_field',
          entityId: id,
          before: { fieldKey: current.fieldKey, dataType: current.dataType },
        },
        tx,
      );
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Values                                                                                      */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Write one value into one slot.
   *
   * The slot is `(field, item, group, ordinal)` — the Phase 1 key; the review and form dimensions
   * arrive with `0007_sr` (§4.7, FV2). Writing the same slot twice updates it, which is what makes
   * a re-run of an extraction or an importer idempotent (P9).
   */
  setValue(input: SetFieldValueInput, actor: Actor): DecodedFieldValue {
    return this.db.transaction((tx) => {
      const field = this.resolveField(tx, input);

      const item = tx.select().from(items).where(eq(items.id, input.itemId)).get();
      if (item === undefined) throw new NotFoundError('item', input.itemId);

      const ordinal = input.ordinal ?? 0;
      if (!Number.isInteger(ordinal) || ordinal < 0) {
        throw new ValidationError(`Ordinal must be a non-negative integer, got ${String(ordinal)}.`);
      }
      if (ordinal > 0 && !field.isRepeatable) {
        throw new InvariantError(
          'FV3',
          `Field '${field.fieldKey}' is not repeatable, so ordinal must be 0 (got ${ordinal}).`,
          { fieldId: field.id, fieldKey: field.fieldKey, ordinal },
        );
      }

      if (field.appliesToItemTypes !== null) {
        const allowed = parseStringArray(field.appliesToItemTypes);
        if (allowed.length > 0 && !allowed.includes(item.itemType)) {
          throw new ValidationError(
            `Field '${field.fieldKey}' does not apply to items of type '${item.itemType}'.`,
            { fieldKey: field.fieldKey, itemType: item.itemType, appliesToItemTypes: allowed },
          );
        }
      }

      const isBlank = input.isBlank ?? false;
      const hasContent = input.content !== undefined && input.content !== null;
      if (hasContent && isBlank) {
        throw new ValidationError(
          'A value is either recorded or explicitly blank, never both (ck_field_values_one_value).',
        );
      }
      if (!hasContent && !isBlank) {
        throw new ValidationError(
          'A field value needs content, or isBlank set to record "not reported" ' +
            '(ck_field_values_one_value).',
        );
      }

      const columns = hasContent
        ? this.encode(field, input.content as FieldValueContent, tx)
        : EMPTY_VALUE_COLUMNS;

      const groupKey = input.groupKey ?? null;
      const now = nowTimestamp();

      const existing = tx
        .select()
        .from(fieldValues)
        .where(
          and(
            eq(fieldValues.fieldId, field.id),
            eq(fieldValues.itemId, input.itemId),
            eq(fieldValues.groupScopeKey, scopeKey(groupKey)),
            eq(fieldValues.ordinal, ordinal),
          ),
        )
        .get();

      const row: FieldValueRow = {
        id: existing?.id ?? newId(),
        fieldId: field.id,
        itemId: input.itemId,
        groupKey,
        groupScopeKey: scopeKey(groupKey),
        ordinal,
        ...columns,
        isBlank,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        createdByUserId: existing?.createdByUserId ?? actor.userId ?? null,
      };

      if (existing === undefined) {
        tx.insert(fieldValues).values(row).run();
      } else {
        tx.update(fieldValues)
          .set({ ...columns, isBlank, updatedAt: now })
          .where(eq(fieldValues.id, row.id))
          .run();
      }

      this.audit.record(
        {
          actor,
          action: existing === undefined ? 'field_value.created' : 'field_value.updated',
          entityType: 'field_value',
          entityId: row.id,
          before: existing === undefined ? null : { content: decodeContent(field, existing) },
          after: {
            fieldKey: field.fieldKey,
            itemId: input.itemId,
            groupKey,
            ordinal,
            content: hasContent ? input.content : null,
            isBlank,
          },
        },
        tx,
      );

      return { row, field, content: decodeContent(field, row) };
    });
  }

  /** One slot's value, or undefined when it has never been written. */
  getValue(
    input: Pick<SetFieldValueInput, 'fieldId' | 'fieldKey' | 'itemId' | 'groupKey' | 'ordinal'>,
  ): DecodedFieldValue | undefined {
    const field = this.resolveField(this.db, input);
    const row = this.db
      .select()
      .from(fieldValues)
      .where(
        and(
          eq(fieldValues.fieldId, field.id),
          eq(fieldValues.itemId, input.itemId),
          eq(fieldValues.groupScopeKey, scopeKey(input.groupKey ?? null)),
          eq(fieldValues.ordinal, input.ordinal ?? 0),
        ),
      )
      .get();
    if (row === undefined) return undefined;
    return { row, field, content: decodeContent(field, row) };
  }

  /** Every value on an item, decoded, in field order. */
  listValues(itemId: string): DecodedFieldValue[] {
    const rows = this.db
      .select({ value: fieldValues, field: customFields })
      .from(fieldValues)
      .innerJoin(customFields, eq(customFields.id, fieldValues.fieldId))
      .where(eq(fieldValues.itemId, itemId))
      .orderBy(asc(customFields.position), asc(customFields.fieldKey), asc(fieldValues.ordinal))
      .all();
    return rows.map((row) => ({
      row: row.value,
      field: row.field,
      content: decodeContent(row.field, row.value),
    }));
  }

  /**
   * Clear one slot.
   *
   * The row is hard-deleted, because the absence of a row is the model's way of saying "not yet
   * extracted" — which is a different fact from `is_blank`, "recorded as not reported" (§4.7).
   */
  clearValue(
    input: Pick<SetFieldValueInput, 'fieldId' | 'fieldKey' | 'itemId' | 'groupKey' | 'ordinal'>,
    actor: Actor,
  ): boolean {
    return this.db.transaction((tx) => {
      const field = this.resolveField(tx, input);
      const existing = tx
        .select()
        .from(fieldValues)
        .where(
          and(
            eq(fieldValues.fieldId, field.id),
            eq(fieldValues.itemId, input.itemId),
            eq(fieldValues.groupScopeKey, scopeKey(input.groupKey ?? null)),
            eq(fieldValues.ordinal, input.ordinal ?? 0),
          ),
        )
        .get();
      if (existing === undefined) return false;

      tx.delete(fieldValues).where(eq(fieldValues.id, existing.id)).run();
      this.audit.record(
        {
          actor,
          action: 'field_value.cleared',
          entityType: 'field_value',
          entityId: existing.id,
          before: {
            fieldKey: field.fieldKey,
            itemId: input.itemId,
            content: decodeContent(field, existing),
          },
        },
        tx,
      );
      return true;
    });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Internals                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  private resolveField(
    tx: Pick<RecueilDatabase, 'select'>,
    input: Pick<SetFieldValueInput, 'fieldId' | 'fieldKey'>,
  ): CustomFieldRow {
    if (input.fieldId !== undefined) {
      const row = tx.select().from(customFields).where(eq(customFields.id, input.fieldId)).get();
      if (row === undefined) throw new NotFoundError('custom_field', input.fieldId);
      return row;
    }
    if (input.fieldKey !== undefined) {
      const row = tx.select().from(customFields).where(eq(customFields.fieldKey, input.fieldKey)).get();
      if (row === undefined) throw new NotFoundError('custom_field', input.fieldKey);
      return row;
    }
    throw new ValidationError('Name the field: pass either fieldId or fieldKey.');
  }

  /**
   * Turn a typed value into the one column that holds it (FV1).
   *
   * Two gates, in order. `FieldValueContentSchema` says the value is a well-formed instance of the
   * type it claims; the type must then equal the field's declared type; and the field's `config`
   * says whether this particular value is one the field allows.
   */
  private encode(
    field: CustomFieldRow,
    content: FieldValueContent,
    tx: Pick<RecueilDatabase, 'select'>,
  ): ValueColumns {
    const parsed = FieldValueContentSchema.safeParse(content);
    if (!parsed.success) {
      throw new ValidationError(
        `The value offered for '${field.fieldKey}' is not a well-formed ` +
          `${String((content as { type?: unknown }).type ?? 'value')}: ` +
          parsed.error.issues.map((issue) => issue.message).join('; '),
        { fieldKey: field.fieldKey, issues: parsed.error.issues },
      );
    }
    const value = parsed.data;

    if (value.type !== field.dataType) {
      throw new InvariantError(
        'FV1',
        `Field '${field.fieldKey}' is declared '${field.dataType}', so a '${value.type}' value ` +
          'cannot be stored in it. The populated column is determined by the field definition.',
        { fieldKey: field.fieldKey, declared: field.dataType, offered: value.type },
      );
    }

    const config = parseConfig(field.config);

    switch (value.type) {
      case 'text':
      case 'long_text':
      case 'url':
        checkPattern(field, config, value.value);
        return { ...EMPTY_VALUE_COLUMNS, valueText: value.value };

      case 'choice': {
        const choices = configChoices(config);
        if (choices.length > 0 && !choices.includes(value.value)) {
          throw new ValidationError(
            `'${value.value}' is not one of the choices for '${field.fieldKey}'.`,
            { fieldKey: field.fieldKey, value: value.value, choices },
          );
        }
        return { ...EMPTY_VALUE_COLUMNS, valueText: value.value };
      }

      case 'multi_choice': {
        const choices = configChoices(config);
        if (choices.length > 0) {
          const unknown = value.value.filter((entry) => !choices.includes(entry));
          if (unknown.length > 0) {
            throw new ValidationError(
              `${unknown.map((entry) => `'${entry}'`).join(', ')} ` +
                `${unknown.length === 1 ? 'is not one of the choices' : 'are not choices'} for ` +
                `'${field.fieldKey}'.`,
              { fieldKey: field.fieldKey, unknown, choices },
            );
          }
        }
        return { ...EMPTY_VALUE_COLUMNS, valueJson: JSON.stringify(value.value) };
      }

      case 'number':
        checkRange(field, config, value.value);
        return { ...EMPTY_VALUE_COLUMNS, valueNumber: value.value };

      case 'monetary':
        checkRange(field, config, value.value);
        return { ...EMPTY_VALUE_COLUMNS, valueNumber: value.value };

      case 'integer':
        checkRange(field, config, value.value);
        return { ...EMPTY_VALUE_COLUMNS, valueInteger: value.value };

      case 'boolean':
        return { ...EMPTY_VALUE_COLUMNS, valueBoolean: value.value };

      case 'date':
      case 'datetime':
        return { ...EMPTY_VALUE_COLUMNS, valueDate: value.value };

      case 'json':
        return { ...EMPTY_VALUE_COLUMNS, valueJson: JSON.stringify(value.value) };

      case 'item_reference': {
        const target = tx.select().from(items).where(eq(items.id, value.value)).get();
        if (target === undefined) throw new NotFoundError('item', value.value);
        const targetTypes = parseStringArray(
          typeof config['targetItemTypes'] === 'string'
            ? config['targetItemTypes']
            : JSON.stringify(config['targetItemTypes'] ?? null),
        );
        if (targetTypes.length > 0 && !targetTypes.includes(target.itemType)) {
          throw new ValidationError(
            `Field '${field.fieldKey}' references items of type ` +
              `${targetTypes.map((entry) => `'${entry}'`).join(', ')}, not '${target.itemType}'.`,
            { fieldKey: field.fieldKey, targetItemTypes: targetTypes, itemType: target.itemType },
          );
        }
        return { ...EMPTY_VALUE_COLUMNS, valueItemId: value.value };
      }
    }
  }
}

/* ---------------------------------------------------------------------------------------- */
/* Encoding helpers                                                                            */
/* ---------------------------------------------------------------------------------------- */

interface ValueColumns {
  valueText: string | null;
  valueNumber: number | null;
  valueInteger: number | null;
  valueBoolean: boolean | null;
  valueDate: string | null;
  valueJson: string | null;
  valueItemId: string | null;
}

const EMPTY_VALUE_COLUMNS: ValueColumns = {
  valueText: null,
  valueNumber: null,
  valueInteger: null,
  valueBoolean: null,
  valueDate: null,
  valueJson: null,
  valueItemId: null,
};

/** The stored columns, read back as the typed union the contract speaks. */
export const decodeContent = (
  field: CustomFieldRow,
  row: FieldValueRow,
): FieldValueContent | null => {
  if (row.isBlank) return null;

  switch (field.dataType) {
    case 'text':
    case 'long_text':
    case 'choice':
    case 'url':
      return row.valueText === null
        ? null
        : ({ type: field.dataType, value: row.valueText } as FieldValueContent);
    case 'number':
      return row.valueNumber === null ? null : { type: 'number', value: row.valueNumber };
    case 'monetary': {
      if (row.valueNumber === null) return null;
      const currency = parseConfig(field.config)['currency'];
      return {
        type: 'monetary',
        value: row.valueNumber,
        ...(typeof currency === 'string' ? { currency } : {}),
      };
    }
    case 'integer':
      return row.valueInteger === null ? null : { type: 'integer', value: row.valueInteger };
    case 'boolean':
      return row.valueBoolean === null ? null : { type: 'boolean', value: row.valueBoolean };
    case 'date':
      return row.valueDate === null ? null : { type: 'date', value: row.valueDate };
    case 'datetime':
      return row.valueDate === null ? null : { type: 'datetime', value: row.valueDate };
    case 'multi_choice': {
      if (row.valueJson === null) return null;
      return { type: 'multi_choice', value: parseStringArray(row.valueJson) };
    }
    case 'json': {
      if (row.valueJson === null) return null;
      return { type: 'json', value: JSON.parse(row.valueJson) as never };
    }
    case 'item_reference':
      return row.valueItemId === null ? null : { type: 'item_reference', value: row.valueItemId };
    default:
      return null;
  }
};

const parseConfig = (json: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
};

const parseStringArray = (json: string | null): string[] => {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
};

const configChoices = (config: Record<string, unknown>): string[] => {
  const choices = config['choices'];
  if (!Array.isArray(choices)) return [];
  return choices.filter((entry): entry is string => typeof entry === 'string');
};

const checkRange = (
  field: CustomFieldRow,
  config: Record<string, unknown>,
  value: number,
): void => {
  const min = config['min'];
  const max = config['max'];
  if (typeof min === 'number' && value < min) {
    throw new ValidationError(`'${field.fieldKey}' has a minimum of ${min}; got ${value}.`, {
      fieldKey: field.fieldKey,
      min,
      value,
    });
  }
  if (typeof max === 'number' && value > max) {
    throw new ValidationError(`'${field.fieldKey}' has a maximum of ${max}; got ${value}.`, {
      fieldKey: field.fieldKey,
      max,
      value,
    });
  }
};

const checkPattern = (
  field: CustomFieldRow,
  config: Record<string, unknown>,
  value: string,
): void => {
  const pattern = config['pattern'];
  if (typeof pattern !== 'string' || pattern === '') return;
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, 'u');
  } catch {
    // A field configured with a broken pattern must not make every write to it fail; the config
    // is the bug, and the `completeness` check is where a bad definition is reported.
    return;
  }
  if (!expression.test(value)) {
    throw new ValidationError(`'${field.fieldKey}' requires values matching /${pattern}/.`, {
      fieldKey: field.fieldKey,
      pattern,
    });
  }
};

/** The config keys each data type understands, checked at definition time so typos surface early. */
const validateFieldConfig = (
  dataType: CustomFieldDataType,
  config: Record<string, unknown>,
): void => {
  if (dataType === 'choice' || dataType === 'multi_choice') {
    const choices = config['choices'];
    if (choices !== undefined && !Array.isArray(choices)) {
      throw new ValidationError("A choice field's `choices` config must be an array of strings.", {
        dataType,
      });
    }
  }
  for (const key of ['min', 'max', 'step'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'number') {
      throw new ValidationError(`\`${key}\` must be a number.`, { dataType, key });
    }
  }
  if (config['currency'] !== undefined && typeof config['currency'] !== 'string') {
    throw new ValidationError('`currency` must be an ISO-4217 code.', { dataType });
  }
};
