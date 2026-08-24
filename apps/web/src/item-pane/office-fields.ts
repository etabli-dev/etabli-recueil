/**
 * The office facet, as the item pane edits it.
 *
 * CONCEPT.md §5.2 gives the facet five members — correspondent, document date, ASN, amount,
 * reference number — and `spec/data-model.md` §3.7 adds the document type and the three dates that
 * an invoice actually needs (due, and the period it covers). Invariant O1 keeps the list closed:
 * anything beyond it is a custom field, not a new column, so this table is the whole editable
 * surface and will stay that size.
 *
 * The amount is not in the table. Money is an integer of minor units plus an ISO-4217 code, and
 * `ck_item_office_amount` requires both or neither — so it is edited by one control that writes
 * both in one patch, rather than by two rows that can each be saved into a state the server must
 * refuse. `AMOUNT_FIELD_PATHS` names the two paths that control owns, so the lock and provenance
 * display can find them.
 */
import type { OfficeFacetUpdate } from '@recueil/schemas';

import type { FieldDescriptor } from './fields.js';

export type OfficeFieldPath = keyof OfficeFacetUpdate;

export interface OfficeFieldDescriptor extends FieldDescriptor {
  path: OfficeFieldPath;
}

/** The two columns the amount control writes together. */
export const AMOUNT_FIELD_PATHS = ['amountMinor', 'amountCurrency'] as const;

export const OFFICE_FIELDS: readonly OfficeFieldDescriptor[] = [
  {
    path: 'correspondent',
    label: 'Correspondent',
    group: 'Correspondent',
    kind: 'text',
    hint: 'Who sent it, as printed. Grouping uses a normalised copy the server maintains.',
  },
  {
    path: 'officeDocumentType',
    label: 'Document type',
    group: 'Correspondent',
    kind: 'text',
    hint: 'A slug: invoice, letter, contract, receipt, statement, payslip, tax, medical, other.',
  },

  {
    path: 'documentDate',
    label: 'Document date',
    group: 'Dates',
    kind: 'text',
    hint: 'YYYY-MM-DD, as printed on the document. Not the date it was ingested.',
  },
  { path: 'dueDate', label: 'Due', group: 'Dates', kind: 'text', hint: 'YYYY-MM-DD.' },
  {
    path: 'periodStart',
    label: 'Period from',
    group: 'Dates',
    kind: 'text',
    hint: 'YYYY-MM-DD. The billing or cover period this document is about.',
  },
  { path: 'periodEnd', label: 'Period to', group: 'Dates', kind: 'text', hint: 'YYYY-MM-DD.' },

  {
    path: 'asn',
    label: 'ASN',
    group: 'References',
    kind: 'number',
    hint: 'Paperless archive serial number — the number written on the paper. Unique in the library.',
  },
  {
    path: 'referenceNumber',
    label: 'Reference number',
    group: 'References',
    kind: 'text',
    hint: 'The correspondent’s own reference: an invoice number, a case number, a policy number.',
  },
];

/** The descriptors grouped for rendering, in table order. */
export const officeFieldGroups = (): { group: string; fields: OfficeFieldDescriptor[] }[] => {
  const groups: { group: string; fields: OfficeFieldDescriptor[] }[] = [];
  for (const field of OFFICE_FIELDS) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.group === field.group) last.fields.push(field);
    else groups.push({ group: field.group, fields: [field] });
  }
  return groups;
};

/* -------------------------------------------------------------------------------------------- */
/* Money                                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * How many decimal places a currency has.
 *
 * Asked of the runtime rather than kept in a table here, because the answer is CLDR data that
 * changes and that Node and every browser already ship: JPY has none, KWD has three, and a
 * hard-coded two would silently multiply a Kuwaiti invoice by ten. An unknown code falls back to
 * two, which is what `Intl` itself does for an unrecognised currency.
 */
export const currencyExponent = (currency: string): number => {
  try {
    const format = new Intl.NumberFormat('en-GB', { style: 'currency', currency });
    // `maximumFractionDigits` is optional in the type because it is absent for some option sets;
    // for a currency format it is always resolved, and two is the right answer if it ever is not.
    return format.resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};

/** Minor units as a person types them: 129900 EUR → "1299.00". */
export const minorToDecimal = (minor: number, currency: string): string => {
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(minor);
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
};

export type AmountParse =
  | { ok: true; minor: number | null }
  | { ok: false; message: string };

/**
 * A typed amount as minor units.
 *
 * Parsed by hand rather than through `Number`, because `Number('1.005') * 100` is `100.49999…` and
 * an invoice that rounds to the wrong cent is a bug nobody finds until the reconciliation. The
 * digits are counted, padded and read as an integer, so nothing is ever a float.
 */
export const decimalToMinor = (raw: string, currency: string): AmountParse => {
  const trimmed = raw.trim().replace(/\s/gu, '');
  if (trimmed === '') return { ok: true, minor: null };

  const match = /^(-?)(\d*)(?:[.,](\d*))?$/u.exec(trimmed);
  if (match === null) return { ok: false, message: 'must be a number, for instance 1299.00' };

  const sign = match[1] ?? '';
  const whole = match[2] ?? '';
  const fraction = match[3] ?? '';
  if (whole === '' && fraction === '') return { ok: false, message: 'must be a number, for instance 1299.00' };

  const exponent = currencyExponent(currency);
  if (fraction.length > exponent) {
    return {
      ok: false,
      message:
        exponent === 0
          ? `${currency} has no decimal places`
          : `${currency} has ${String(exponent)} decimal places, not ${String(fraction.length)}`,
    };
  }

  const digits = `${whole === '' ? '0' : whole}${fraction.padEnd(exponent, '0')}`;
  const minor = Number(`${sign}${digits}`);
  if (!Number.isSafeInteger(minor)) return { ok: false, message: 'is too large to record exactly' };
  return { ok: true, minor };
};
