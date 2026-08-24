/**
 * Paperless monetary values onto `item_office.amount_minor` / `amount_currency`.
 *
 * Paperless stores a monetary custom field as a **string**, and its own validator (
 * `CustomFieldInstanceSerializer.validate`) accepts two forms:
 *
 * - the current one, `^[A-Z]{3}-?\d+(\.\d{1,2})$` — a three-letter ISO-4217 code, an optional minus
 *   *after* the code, then a decimal with one or two places: `GBP123.45`, `EUR-89.90`;
 * - the legacy one, a bare decimal with up to two places and no code at all: `123.45`.
 *
 * Recueil stores minor units as an integer and the currency separately (§1.1: "Minor units. Never
 * `REAL`"), and `ck_item_office_amount` requires both columns or neither. So a legacy value with no
 * currency cannot go into the facet unless a currency is supplied from somewhere, and the somewhere
 * is `extra_data.default_currency` on the field definition, then the importer's `defaultCurrency`
 * option, and then nowhere: the value stays on the custom field, the facet columns stay null, and
 * the report says how many did that. Guessing a currency would silently change what a number means.
 *
 * **Minor units are computed as digits, not as arithmetic.** `Math.round(89.9 * 100)` is 8990 by
 * luck and `Math.round(1.005 * 100)` is 100 by binary rounding; parsing `"89.90"` as the digit
 * string it is gives 8990 always. That is the reason the value travels as a string all the way
 * down to here.
 *
 * The number of minor units in a major unit is not universally 100 — JPY has none, KWD has three —
 * so the exponent comes from a table and defaults to 2. Paperless itself always writes two decimal
 * places, so a JPY amount reaches this function as `JPY1200.00`; the table is what turns that into
 * 1200 minor units rather than 120000.
 */

/** ISO-4217 currencies whose minor unit is not 1/100. Everything absent from this table is 2. */
const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = {
  BHD: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

/** How many minor units make one major unit, as a power of ten. */
export const minorUnitExponent = (currency: string): number =>
  MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;

export interface ParsedMoney {
  /** The signed amount in minor units. */
  minor: number;
  /** ISO-4217, three uppercase letters, or null when the value carried none. */
  currency: string | null;
  /** The value exactly as Paperless held it. */
  raw: string;
}

/** `GBP123.45` → 12345 GBP; `-89.9` → −8990 with no currency; anything else → null. */
export const parseMonetary = (
  value: unknown,
  options: { defaultCurrency?: string | null } = {},
): ParsedMoney | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // A server that answered with a JSON number rather than a string. Formatting it back to two
    // places and re-parsing keeps one code path for the digits.
    return parseMonetary(value.toFixed(2), options);
  }
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (raw === '') return null;

  const parts = /^([A-Za-z]{3})?\s*(-)?\s*(\d+)(?:[.,](\d{1,6}))?$/u.exec(raw);
  if (parts === null) return null;

  const currency = normaliseCurrency(parts[1] ?? options.defaultCurrency ?? null);
  const negative = parts[2] === '-';
  const whole = parts[3] ?? '0';
  const fraction = parts[4] ?? '';

  const exponent = currency === null ? 2 : minorUnitExponent(currency);

  // Pad or truncate the fractional digits to the currency's exponent. Truncation only ever happens
  // on a value with more places than the currency has, which Paperless's own validator rejects; it
  // is here so that a hand-edited database row cannot produce a wrong number silently.
  const scaled = `${fraction}${'0'.repeat(exponent)}`.slice(0, exponent);
  const digits = `${whole}${scaled}`;

  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return null;

  return { minor: negative ? -minor : minor, currency, raw };
};

/** `eur` → `EUR`; anything that is not three letters → null. */
export const normaliseCurrency = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{3}$/u.test(trimmed) ? trimmed : null;
};

/**
 * Minor units back to the major-unit number `FieldValueContent` of type `monetary` wants.
 *
 * The custom-field contract stores the major-unit value as a JSON number (`value: number`, with
 * `config.currency` naming the unit), so the digits have to become a float somewhere. Doing it here,
 * once, from an integer and an exponent, is exact for every amount below 2^53 minor units.
 */
export const toMajorUnits = (minor: number, currency: string | null): number =>
  minor / 10 ** (currency === null ? 2 : minorUnitExponent(currency));
