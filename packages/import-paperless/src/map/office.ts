/**
 * The Office facet: what Paperless has, and where the two things it does not have come from.
 *
 * `spec/data-model.md` §3.7 gives the facet correspondent, document date, ASN, reference number,
 * amount, due date and period. Paperless natively has three of those — correspondent, created date
 * and archive serial number — and the rest live, if they live anywhere, in the user's own custom
 * fields. So the mapping is in two halves.
 *
 * **The native half is fixed.** `correspondent` → `correspondent`, `created` → `document_date`,
 * `archive_serial_number` → `asn`. Nothing is inferred and nothing is guessed.
 *
 * **The custom-field half is nominated, then defaulted, and always reported.** A caller may name
 * the Paperless field that holds the reference number, the amount, the due date or the period; when
 * they do not, `chooseFacetSources` looks for one by name, using a bilingual table, and takes it
 * *only if exactly one field matches*. Two candidates means the importer does not know, so it takes
 * neither and says so — P3, flag rather than guess. Every value that reaches a facet column also
 * stays on its custom field, so the nomination is a convenience and never a move.
 *
 * **A correspondent is required and Paperless does not always have one.** `item_office.correspondent`
 * is `NOT NULL` because the facet exists to answer "who is this from"; a Paperless document with
 * `correspondent: null` therefore gets the placeholder in `missingCorrespondentLabel` and is counted
 * in the report. It is a count rather than one review entry per document because on a real install
 * the number is in the hundreds and a review queue with four hundred identical entries in it is a
 * review queue nobody reads.
 */
import { normalise } from '@recueil/core';

import type { PaperlessCustomField, PaperlessDocument } from '../client/types.js';
import { documentDateOf } from './dates.js';
import { parseMonetary } from './money.js';
import { slugify } from './slug.js';

/** The placeholder a document with no Paperless correspondent gets. */
export const DEFAULT_MISSING_CORRESPONDENT = 'Unknown correspondent';

/**
 * Names that mean "the reference number on this document", slugged.
 *
 * English and German, because the install this was written for is German. A field is only taken
 * when its slug is one of these exactly — a field called `Rechnungsnummer alt` is not the reference
 * number, and prefix matching would say it was.
 */
export const REFERENCE_NUMBER_FIELD_SLUGS: ReadonlySet<string> = new Set([
  'reference',
  'reference_number',
  'referenz',
  'referenznummer',
  'invoice_number',
  'rechnungsnummer',
  'belegnummer',
  'vorgangsnummer',
  'aktenzeichen',
  'kundennummer',
  'vertragsnummer',
]);

/** Names that mean "the amount on this document", slugged. Only used among `monetary` fields. */
export const AMOUNT_FIELD_SLUGS: ReadonlySet<string> = new Set([
  'amount',
  'total',
  'total_amount',
  'sum',
  'betrag',
  'gesamtbetrag',
  'summe',
  'rechnungsbetrag',
  'preis',
]);

/** Names that mean "when this is due", slugged. Only used among `date` fields. */
export const DUE_DATE_FIELD_SLUGS: ReadonlySet<string> = new Set([
  'due',
  'due_date',
  'faellig',
  'faelligkeit',
  'faelligkeitsdatum',
  'zahlungsziel',
]);

/** Names that mean "the period this covers", slugged. Only used among `date` fields. */
export const PERIOD_START_FIELD_SLUGS: ReadonlySet<string> = new Set([
  'period_start',
  'from',
  'valid_from',
  'zeitraum_von',
  'von',
  'gueltig_ab',
  'beginn',
]);

export const PERIOD_END_FIELD_SLUGS: ReadonlySet<string> = new Set([
  'period_end',
  'to',
  'valid_to',
  'valid_until',
  'zeitraum_bis',
  'bis',
  'gueltig_bis',
  'ende',
]);

/** Which Paperless custom field feeds which facet column, and how each was decided. */
export interface FacetSources {
  referenceNumberFieldId: number | null;
  amountFieldId: number | null;
  dueDateFieldId: number | null;
  periodStartFieldId: number | null;
  periodEndFieldId: number | null;
  /** One line per column, saying what was chosen and why. Printed in the report verbatim. */
  decisions: FacetSourceDecision[];
}

export interface FacetSourceDecision {
  column: 'reference_number' | 'amount' | 'due_date' | 'period_start' | 'period_end';
  /** `nominated` by the caller, `matched` by name, `ambiguous`, or `none`. */
  outcome: 'nominated' | 'matched' | 'ambiguous' | 'none';
  fieldId: number | null;
  fieldName: string | null;
  detail: string;
}

/** What a caller may nominate, by Paperless field id or by exact field name. */
export interface FacetSourceNominations {
  referenceNumberField?: number | string | null;
  amountField?: number | string | null;
  dueDateField?: number | string | null;
  periodStartField?: number | string | null;
  periodEndField?: number | string | null;
}

/** Work out, once per run, which custom field feeds which facet column. */
export const chooseFacetSources = (
  fields: readonly PaperlessCustomField[],
  nominations: FacetSourceNominations = {},
): FacetSources => {
  const decisions: FacetSourceDecision[] = [];

  const pick = (
    column: FacetSourceDecision['column'],
    nominated: number | string | null | undefined,
    slugs: ReadonlySet<string>,
    accepts: (field: PaperlessCustomField) => boolean,
  ): number | null => {
    if (nominated !== null && nominated !== undefined) {
      const found = fields.find((field) =>
        typeof nominated === 'number' ? field.id === nominated : field.name === nominated,
      );
      if (found === undefined) {
        decisions.push({
          column,
          outcome: 'none',
          fieldId: null,
          fieldName: null,
          detail: `No Paperless custom field matches the nominated '${String(nominated)}'.`,
        });
        return null;
      }
      if (!accepts(found)) {
        decisions.push({
          column,
          outcome: 'none',
          fieldId: found.id,
          fieldName: found.name,
          detail:
            `'${found.name}' is a '${found.data_type}' field, which cannot feed ${column}. The ` +
            'value stays on its own custom field.',
        });
        return null;
      }
      decisions.push({
        column,
        outcome: 'nominated',
        fieldId: found.id,
        fieldName: found.name,
        detail: `Nominated by the caller.`,
      });
      return found.id;
    }

    const candidates = fields.filter((field) => accepts(field) && slugs.has(slugify(field.name)));
    if (candidates.length === 1) {
      const only = candidates[0] as PaperlessCustomField;
      decisions.push({
        column,
        outcome: 'matched',
        fieldId: only.id,
        fieldName: only.name,
        detail: `Matched on the field name '${only.name}'.`,
      });
      return only.id;
    }
    if (candidates.length > 1) {
      decisions.push({
        column,
        outcome: 'ambiguous',
        fieldId: null,
        fieldName: null,
        detail:
          `${candidates.length} custom fields could be ${column} ` +
          `(${candidates.map((field) => `'${field.name}'`).join(', ')}). Taking none: nominate one ` +
          'explicitly. Every value is still on its own custom field.',
      });
      return null;
    }
    decisions.push({
      column,
      outcome: 'none',
      fieldId: null,
      fieldName: null,
      detail: 'No Paperless custom field looks like this column.',
    });
    return null;
  };

  const textish = (field: PaperlessCustomField): boolean =>
    field.data_type === 'string' || field.data_type === 'integer' || field.data_type === 'longtext';
  const monetary = (field: PaperlessCustomField): boolean => field.data_type === 'monetary';
  const dateish = (field: PaperlessCustomField): boolean => field.data_type === 'date';

  return {
    referenceNumberFieldId: pick(
      'reference_number',
      nominations.referenceNumberField,
      REFERENCE_NUMBER_FIELD_SLUGS,
      textish,
    ),
    amountFieldId: pick('amount', nominations.amountField, AMOUNT_FIELD_SLUGS, monetary),
    dueDateFieldId: pick('due_date', nominations.dueDateField, DUE_DATE_FIELD_SLUGS, dateish),
    periodStartFieldId: pick(
      'period_start',
      nominations.periodStartField,
      PERIOD_START_FIELD_SLUGS,
      dateish,
    ),
    periodEndFieldId: pick('period_end', nominations.periodEndField, PERIOD_END_FIELD_SLUGS, dateish),
    decisions,
  };
};

/** The office facet of one document, as columns. */
export interface MappedOffice {
  correspondent: string;
  correspondentNormalised: string;
  /** True when there was no Paperless correspondent and the placeholder was used. */
  correspondentIsPlaceholder: boolean;
  documentDate: string | null;
  asn: number | null;
  referenceNumber: string | null;
  amountMinor: number | null;
  amountCurrency: string | null;
  dueDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Facet values Paperless had but that could not be represented, with reasons. */
  notes: string[];
}

export interface OfficeContext {
  correspondentName: string | null;
  sources: FacetSources;
  /** Paperless field id → the raw value on this document. */
  values: ReadonlyMap<number, unknown>;
  /** Paperless field id → its definition, for the monetary default currency. */
  fields: ReadonlyMap<number, PaperlessCustomField>;
  missingCorrespondentLabel?: string;
  defaultCurrency?: string | null;
}

/** Build the office facet for one Paperless document. */
export const mapOffice = (document: PaperlessDocument, context: OfficeContext): MappedOffice => {
  const notes: string[] = [];

  const named = context.correspondentName?.trim() ?? '';
  const correspondent =
    named === '' ? (context.missingCorrespondentLabel ?? DEFAULT_MISSING_CORRESPONDENT) : named;

  const referenceNumber = readReference(context, notes);
  const money = readAmount(context, notes);
  const dueDate = readDate(context, context.sources.dueDateFieldId, 'due_date', notes);
  let periodStart = readDate(context, context.sources.periodStartFieldId, 'period_start', notes);
  let periodEnd = readDate(context, context.sources.periodEndFieldId, 'period_end', notes);

  // `ck_item_office_period` refuses an end before a start. A pair the wrong way round is a data
  // error in Paperless, not a reason to abandon the whole facet, so both are dropped and named.
  if (periodStart !== null && periodEnd !== null && periodEnd < periodStart) {
    notes.push(
      `The period runs backwards in Paperless (${periodStart} to ${periodEnd}); ` +
        'ck_item_office_period refuses it, so neither end was written. Both are on their own ' +
        'custom fields.',
    );
    periodStart = null;
    periodEnd = null;
  }

  const asn =
    typeof document.archive_serial_number === 'number' &&
    Number.isSafeInteger(document.archive_serial_number)
      ? document.archive_serial_number
      : null;

  return {
    correspondent,
    correspondentNormalised: normalise(correspondent),
    correspondentIsPlaceholder: named === '',
    documentDate: documentDateOf(document),
    asn,
    referenceNumber,
    amountMinor: money.minor,
    amountCurrency: money.currency,
    dueDate,
    periodStart,
    periodEnd,
    notes,
  };
};

/* ================================================================================================ */

const readReference = (context: OfficeContext, notes: string[]): string | null => {
  const id = context.sources.referenceNumberFieldId;
  if (id === null) return null;
  const raw = context.values.get(id);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return String(raw);
  if (typeof raw !== 'string') {
    notes.push(`The nominated reference-number field holds a ${typeof raw}, which is not a reference.`);
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
};

const readAmount = (
  context: OfficeContext,
  notes: string[],
): { minor: number | null; currency: string | null } => {
  const id = context.sources.amountFieldId;
  if (id === null) return { minor: null, currency: null };

  const raw = context.values.get(id);
  if (raw === null || raw === undefined) return { minor: null, currency: null };

  const field = context.fields.get(id);
  const money = parseMonetary(raw, {
    defaultCurrency: field?.extra_data?.default_currency ?? context.defaultCurrency ?? null,
  });
  if (money === null) {
    notes.push(`The nominated amount field holds '${String(raw)}', which is not a monetary value.`);
    return { minor: null, currency: null };
  }
  if (money.currency === null) {
    // `ck_item_office_amount` is `(amount_minor IS NULL) = (amount_currency IS NULL)`, so an amount
    // without a currency has nowhere to go. Picking one would change what the number means.
    notes.push(
      `The amount '${money.raw}' carries no currency, the field declares no ` +
        '`default_currency`, and the importer was given none. ck_item_office_amount requires ' +
        'both columns or neither, so the amount stays on its custom field only.',
    );
    return { minor: null, currency: null };
  }
  return { minor: money.minor, currency: money.currency };
};

const readDate = (
  context: OfficeContext,
  id: number | null,
  column: string,
  notes: string[],
): string | null => {
  if (id === null) return null;
  const raw = context.values.get(id);
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') {
    notes.push(`The nominated ${column} field holds a ${typeof raw}, which is not a date.`);
    return null;
  }
  const day = /^\d{4}-\d{2}-\d{2}$/u.test(raw.trim()) ? raw.trim() : null;
  if (day === null) {
    notes.push(`The nominated ${column} field holds '${raw}', which is not a calendar date.`);
    return null;
  }
  return day;
};
