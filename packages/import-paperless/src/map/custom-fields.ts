/**
 * Paperless custom fields onto Recueil custom fields (`spec/data-model.md` §4.6, §4.7).
 *
 * CONCEPT §6 asks for "Paperless custom fields → Recueil custom fields with their types preserved",
 * and the two vocabularies line up almost exactly, which is the reason this file is a table rather
 * than an argument. `data_type` is `editable=False` on the Paperless model and immutable on the
 * Recueil one (CF1), so the pairing below is stable in both directions: a field that arrives as
 * `integer` will still be an integer next year, on both sides.
 *
 * Two of the ten need a decision.
 *
 * **`select`.** Paperless stores the chosen option's *id* — a random sixteen-character string — and
 * keeps the human label in `extra_data.select_options`. Recueil's `choice` stores the value itself
 * and validates it against `config.choices`. Storing the id would carry the data across and lose
 * its meaning: nobody can read `xQ4kP2mNvB8jL7wA`, and an export would be gibberish. So the label
 * is what is stored, the ids are kept in `config.paperlessOptionIds` so the mapping is reversible
 * (P10), and a value whose id is not in the option list becomes a skipped record with a reason
 * rather than a silently dropped field.
 *
 * **`documentlink`.** Paperless stores a list of document ids; Recueil's `item_reference` holds one
 * id per slot and repeats through `ordinal` (FV3). So the field is defined `isRepeatable` and one
 * value is written per link. A link whose target is not in this import — a document the token
 * cannot see, or one deleted between the list and the read — cannot be written, because
 * `item_reference` is a real foreign key; it becomes a review entry naming both ends.
 *
 * Nothing here writes anything. It decides, and returns what it decided, so that `import.ts` can
 * report every decision and the tests can assert on them without a database.
 */
import type { CustomFieldDataType } from '@recueil/core';
import type { FieldValueContent } from '@recueil/schemas';

import type {
  PaperlessCustomField,
  PaperlessCustomFieldDataType,
  PaperlessSelectOption,
} from '../client/types.js';
import { parseMonetary, toMajorUnits } from './money.js';
import { toDocumentDate } from './dates.js';

/** Paperless `data_type` → Recueil `dataType`. Total over `PAPERLESS_CUSTOM_FIELD_DATA_TYPES`. */
export const DATA_TYPE_MAP: Readonly<Record<PaperlessCustomFieldDataType, CustomFieldDataType>> = {
  string: 'text',
  longtext: 'long_text',
  url: 'url',
  date: 'date',
  boolean: 'boolean',
  integer: 'integer',
  float: 'number',
  monetary: 'monetary',
  select: 'choice',
  documentlink: 'item_reference',
};

/** What one Paperless custom field becomes, before it is written. */
export interface CustomFieldPlan {
  paperlessId: number;
  /** The name exactly as Paperless holds it. */
  name: string;
  paperlessDataType: PaperlessCustomFieldDataType;
  /** `custom_fields.field_key`, unique in the library. */
  fieldKey: string;
  dataType: CustomFieldDataType;
  /** `custom_fields.config`. */
  config: Record<string, unknown>;
  isRepeatable: boolean;
  /** Option id → label, for a `select` field. Empty for every other type. */
  optionLabels: ReadonlyMap<string, string>;
  /**
   * Set on a `monetary` field whose values do not share one currency.
   *
   * Recueil records a monetary field's currency once, on the field (`config.currency`), because
   * `decodeContent` reads it from there; Paperless records it per value. Where every value agrees —
   * which is the ordinary case, and the only one a `default_currency` can express — the currency is
   * carried on the field and nothing is lost. Where they disagree, the number is carried and the
   * code is not, and this sentence is what the report prints instead of pretending otherwise.
   */
  currencyLossReason: string | null;
  /** Set when the Paperless type is not one this version knows; the field is not defined. */
  unsupportedReason: string | null;
}

/**
 * Plan one Paperless custom field.
 *
 * `fieldKey` is decided by the caller, because uniqueness is a property of the whole set and this
 * function sees one field.
 */
export const planCustomField = (
  field: PaperlessCustomField,
  fieldKey: string,
  options: {
    defaultCurrency?: string | null;
    /**
     * Every currency code seen in this field's values across the whole library.
     *
     * The importer has the document list before it defines a field, so it can answer "do these
     * values agree about their currency?" — which is the only way to carry a per-value code into a
     * per-field column honestly.
     */
    observedCurrencies?: ReadonlySet<string>;
  } = {},
): CustomFieldPlan => {
  const dataType = DATA_TYPE_MAP[field.data_type];
  const optionLabels = new Map<string, string>();

  if (dataType === undefined) {
    return {
      paperlessId: field.id,
      name: field.name,
      paperlessDataType: field.data_type,
      fieldKey,
      dataType: 'text',
      config: {},
      isRepeatable: false,
      optionLabels,
      currencyLossReason: null,
      unsupportedReason:
        `Paperless data type '${String(field.data_type)}' is not one this importer was written ` +
        'against. Its values are carried nowhere rather than into a column that means something ' +
        'else.',
    };
  }

  const config: Record<string, unknown> = {
    paperlessFieldId: field.id,
    paperlessDataType: field.data_type,
  };

  if (field.data_type === 'select') {
    const options_ = selectOptions(field);
    for (const option of options_) optionLabels.set(option.id, option.label);
    config['choices'] = options_.map((option) => option.label);
    // Kept so that the migration is reversible: label → id, without asking Paperless again.
    config['paperlessOptionIds'] = Object.fromEntries(
      options_.map((option) => [option.label, option.id]),
    );
  }

  let currencyLossReason: string | null = null;
  if (field.data_type === 'monetary') {
    const declared = field.extra_data?.default_currency ?? null;
    const observed = [...(options.observedCurrencies ?? new Set<string>())].sort();

    // Order of preference: what the field declares, then the one currency every value agrees on,
    // then what the caller supplied. Never a guess between two codes that disagree.
    const currency =
      declared !== null && declared !== ''
        ? declared
        : observed.length === 1
          ? (observed[0] as string)
          : (options.defaultCurrency ?? null);

    if (currency !== null && currency !== '') config['currency'] = currency.toUpperCase();

    if (observed.length > 1) {
      currencyLossReason =
        `'${field.name}' holds values in ${observed.length} currencies (${observed.join(', ')}). ` +
        'Recueil records a monetary currency once per field, so the amounts are carried and the ' +
        'codes are not. Split the field in Paperless, one currency each, if the codes matter.';
    }
  }

  if (field.data_type === 'documentlink') {
    config['targetItemTypes'] = [];
  }

  return {
    paperlessId: field.id,
    name: field.name,
    paperlessDataType: field.data_type,
    fieldKey,
    dataType,
    config,
    isRepeatable: field.data_type === 'documentlink',
    optionLabels,
    currencyLossReason,
    unsupportedReason: null,
  };
};

/** One value, ready to be written into one slot. */
export interface PlannedValue {
  ordinal: number;
  content: FieldValueContent;
}

export type ValuePlan =
  | { kind: 'values'; values: PlannedValue[] }
  /** Paperless holds the field on the document with an explicit empty value (§4.7's `is_blank`). */
  | { kind: 'blank' }
  /** Nothing to write, and nothing lost: Paperless has no value here. */
  | { kind: 'absent' }
  | { kind: 'skipped'; reason: string }
  /** A `documentlink` some of whose targets are not in this library. */
  | { kind: 'partial'; values: PlannedValue[]; unresolved: number[]; reason: string };

export interface ValueContext {
  /** Paperless document id → Recueil item id, for `documentlink`. */
  resolveDocument: (paperlessDocumentId: number) => string | undefined;
  defaultCurrency?: string | null;
}

/**
 * Turn one Paperless value into the typed content Recueil stores.
 *
 * Everything that cannot be represented comes back as `skipped` with a sentence saying why, never
 * as `absent`: "Paperless had nothing here" and "Paperless had something this importer could not
 * carry" are different facts and the report counts them apart.
 */
export const planValue = (
  plan: CustomFieldPlan,
  raw: unknown,
  context: ValueContext,
): ValuePlan => {
  if (plan.unsupportedReason !== null) return { kind: 'skipped', reason: plan.unsupportedReason };
  if (raw === null || raw === undefined) return { kind: 'blank' };

  switch (plan.paperlessDataType) {
    case 'string':
      return textValue(plan, raw, 'text', 4096);

    case 'longtext':
      return textValue(plan, raw, 'long_text', 65_536);

    case 'url': {
      if (typeof raw !== 'string') return wrongShape(plan, raw, 'a string');
      const trimmed = raw.trim();
      if (trimmed === '') return { kind: 'blank' };
      try {
        // `UrlSchema` is what the write will be validated against; parsing here means the report
        // names the field rather than the run failing on it.
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return {
            kind: 'skipped',
            reason: `'${plan.name}' holds a \`${parsed.protocol}\` URL; Recueil's \`url\` type is http(s).`,
          };
        }
      } catch {
        return { kind: 'skipped', reason: `'${plan.name}' holds '${clip(trimmed)}', which is not a URL.` };
      }
      return single({ type: 'url', value: trimmed });
    }

    case 'date': {
      if (typeof raw !== 'string') return wrongShape(plan, raw, 'a date string');
      const day = toDocumentDate(raw);
      if (day === null) {
        return { kind: 'skipped', reason: `'${plan.name}' holds '${clip(raw)}', which is not a date.` };
      }
      return single({ type: 'date', value: day });
    }

    case 'boolean': {
      if (typeof raw !== 'boolean') return wrongShape(plan, raw, 'a boolean');
      return single({ type: 'boolean', value: raw });
    }

    case 'integer': {
      const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return wrongShape(plan, raw, 'an integer');
      }
      return single({ type: 'integer', value });
    }

    case 'float': {
      const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return wrongShape(plan, raw, 'a number');
      }
      return single({ type: 'number', value });
    }

    case 'monetary': {
      const configured = typeof plan.config['currency'] === 'string' ? plan.config['currency'] : null;
      const money = parseMonetary(raw, { defaultCurrency: configured ?? context.defaultCurrency ?? null });
      if (money === null) {
        return {
          kind: 'skipped',
          reason: `'${plan.name}' holds '${clip(String(raw))}', which is not a Paperless monetary value.`,
        };
      }
      const content: FieldValueContent =
        money.currency === null
          ? { type: 'monetary', value: toMajorUnits(money.minor, null) }
          : { type: 'monetary', value: toMajorUnits(money.minor, money.currency), currency: money.currency };
      return single(content);
    }

    case 'select': {
      if (typeof raw !== 'string') return wrongShape(plan, raw, 'a select option id');
      const label = plan.optionLabels.get(raw);
      if (label === undefined) {
        return {
          kind: 'skipped',
          reason:
            `'${plan.name}' holds option id '${clip(raw)}', which is not in the field's ` +
            `select_options (${plan.optionLabels.size} option(s) known). Paperless keeps the label ` +
            'on the field definition, so an id with no option has no meaning left to carry.',
        };
      }
      return single({ type: 'choice', value: label });
    }

    case 'documentlink': {
      if (!Array.isArray(raw)) return wrongShape(plan, raw, 'an array of document ids');
      const values: PlannedValue[] = [];
      const unresolved: number[] = [];
      for (const entry of raw) {
        if (typeof entry !== 'number' || !Number.isSafeInteger(entry)) {
          unresolved.push(Number.NaN);
          continue;
        }
        const itemId = context.resolveDocument(entry);
        if (itemId === undefined) {
          unresolved.push(entry);
          continue;
        }
        values.push({ ordinal: values.length, content: { type: 'item_reference', value: itemId } });
      }
      if (unresolved.length === 0) {
        return values.length === 0 ? { kind: 'blank' } : { kind: 'values', values };
      }
      return {
        kind: 'partial',
        values,
        unresolved: unresolved.filter((entry) => Number.isSafeInteger(entry)),
        reason:
          `'${plan.name}' links to ${unresolved.length} Paperless document(s) that are not in this ` +
          'import. A document link is a real foreign key in Recueil, so the missing ends are left ' +
          'out and listed here rather than written as dangling ids.',
      };
    }
  }
};

/* ================================================================================================ */

const selectOptions = (field: PaperlessCustomField): PaperlessSelectOption[] => {
  const raw = field.extra_data?.select_options;
  if (!Array.isArray(raw)) return [];
  const out: PaperlessSelectOption[] = [];
  for (const option of raw) {
    if (typeof option !== 'object' || option === null) continue;
    const { id, label } = option as { id?: unknown; label?: unknown };
    if (typeof id !== 'string' || typeof label !== 'string' || label === '') continue;
    out.push({ id, label });
  }
  return out;
};

const single = (content: FieldValueContent): ValuePlan => ({
  kind: 'values',
  values: [{ ordinal: 0, content }],
});

const textValue = (
  plan: CustomFieldPlan,
  raw: unknown,
  type: 'text' | 'long_text',
  limit: number,
): ValuePlan => {
  if (typeof raw !== 'string') return wrongShape(plan, raw, 'a string');
  if (raw === '') return { kind: 'blank' };
  if (raw.length > limit) {
    return {
      kind: 'skipped',
      reason:
        `'${plan.name}' holds ${raw.length} characters and Recueil's \`${type}\` accepts ${limit}. ` +
        'Truncating would look like data and be a lie, so the value is left in Paperless.',
    };
  }
  return single(type === 'text' ? { type: 'text', value: raw } : { type: 'long_text', value: raw });
};

const wrongShape = (plan: CustomFieldPlan, raw: unknown, expected: string): ValuePlan => ({
  kind: 'skipped',
  reason:
    `'${plan.name}' is declared '${plan.paperlessDataType}' but its value is ` +
    `${describe(raw)} rather than ${expected}.`,
});

const describe = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return `an array of ${raw.length}`;
  return `a ${typeof raw} (${clip(String(raw))})`;
};

const clip = (value: string): string => (value.length > 60 ? `${value.slice(0, 57)}...` : value);
