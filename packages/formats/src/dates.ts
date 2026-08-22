/**
 * Bibliographic dates.
 *
 * The contract stores `issuedDate` as EDTF level 1 (`spec/data-model.md` §1.1) because a
 * publication date is routinely a year, sometimes a year and a month, occasionally approximate and
 * every so often a range. Each of the four formats can hold a different amount of that: CSL-JSON
 * has `date-parts` and can hold nearly all of it, BibLaTeX has an ISO-8601 `date` field and can
 * hold most, RIS has `PY` plus a `DA` of `YYYY/MM/DD/` and classic BibTeX has `year` and a `month`
 * that is conventionally a three-letter macro. This module is the one place that knows the shape,
 * so no exporter re-parses a date string by hand.
 */

/** A calendar point, as much of it as the source gave. */
export interface DateParts {
  readonly year: number;
  readonly month?: number | undefined;
  readonly day?: number | undefined;
}

/** A parsed EDTF value: one point, or two for an interval. */
export interface ParsedDate {
  readonly start?: DateParts | undefined;
  readonly end?: DateParts | undefined;
  /** `?`, `~` or `%` was present — CSL's `circa`, and nothing at all in the other three formats. */
  readonly circa: boolean;
  /** `../2019`: an interval with no beginning. No format but EDTF can say this. */
  readonly openStart: boolean;
  /** `2019/..`: an interval with no end. */
  readonly openEnd: boolean;
  readonly raw: string;
}

const parsePoint = (value: string): DateParts | undefined => {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?[?~%]?$/u.exec(value);
  if (match === null) return undefined;
  const year = Number.parseInt(match[1] as string, 10);
  const month = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
  const day = match[3] === undefined ? undefined : Number.parseInt(match[3], 10);
  return { year, month, day };
};

/** Parse the EDTF level-1 subset `EdtfDateSchema` accepts. Returns `undefined` for anything else. */
export const parseEdtf = (value: string | null | undefined): ParsedDate | undefined => {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (raw.length === 0) return undefined;
  const circa = /[?~%]/u.test(raw);

  if (raw.includes('/')) {
    const [left, right] = raw.split('/', 2) as [string, string];
    const openStart = left === '..';
    const openEnd = right === '..';
    const start = openStart ? undefined : parsePoint(left);
    const end = openEnd ? undefined : parsePoint(right);
    if (!openStart && start === undefined) return undefined;
    if (!openEnd && end === undefined) return undefined;
    return { start, end, circa, openStart, openEnd, raw };
  }

  const point = parsePoint(raw);
  if (point === undefined) return undefined;
  return { start: point, circa, openStart: false, openEnd: false, raw };
};

/** `[2019, 4, 1]` — the CSL `date-parts` tuple, trimmed to the precision that exists. */
export const toDateParts = (parts: DateParts): number[] => {
  const out: number[] = [parts.year];
  if (parts.month !== undefined) {
    out.push(parts.month);
    if (parts.day !== undefined) out.push(parts.day);
  }
  return out;
};

/** The inverse: a CSL `date-parts` tuple back to a point. Strings are tolerated; CSL emits both. */
export const fromDateParts = (parts: readonly (number | string)[]): DateParts | undefined => {
  const numbers = parts.map((part) => (typeof part === 'number' ? part : Number.parseInt(part, 10)));
  const [year, month, day] = numbers;
  if (year === undefined || Number.isNaN(year)) return undefined;
  return {
    year,
    month: month === undefined || Number.isNaN(month) ? undefined : month,
    day: day === undefined || Number.isNaN(day) ? undefined : day,
  };
};

/** `2019`, `2019-04`, `2019-04-01` — the EDTF spelling of one point. */
export const formatEdtfPoint = (parts: DateParts): string => {
  const year = String(parts.year).padStart(4, '0');
  if (parts.month === undefined) return year;
  const month = String(parts.month).padStart(2, '0');
  if (parts.day === undefined) return `${year}-${month}`;
  return `${year}-${month}-${String(parts.day).padStart(2, '0')}`;
};

/** Rebuild an EDTF string from a parsed date, so an importer can write the contract's own shape. */
export const formatEdtf = (date: ParsedDate): string | undefined => {
  const start = date.start === undefined ? undefined : formatEdtfPoint(date.start);
  const end = date.end === undefined ? undefined : formatEdtfPoint(date.end);
  const qualifier = date.circa ? '~' : '';
  if (date.openStart) return end === undefined ? undefined : `../${end}${qualifier}`;
  if (date.openEnd) return start === undefined ? undefined : `${start}${qualifier}/..`;
  if (start === undefined) return undefined;
  if (end === undefined) return `${start}${qualifier}`;
  return `${start}${qualifier}/${end}${qualifier}`;
};

/** The three-letter month macros classic BibTeX expects: `month = jan`, unbraced. */
export const BIBTEX_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;

/** `4` → `apr`. Out-of-range input yields `undefined` rather than a nonsense macro. */
export const bibtexMonth = (month: number | undefined): string | undefined => {
  if (month === undefined || !Number.isInteger(month) || month < 1 || month > 12) return undefined;
  return BIBTEX_MONTHS[month - 1];
};

/** `apr`, `April`, `4`, `04` → `4`. What a `.bib` file's `month` field actually contains. */
export const parseBibtexMonth = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  if (text.length === 0) return undefined;
  const numeric = /^(\d{1,2})$/u.exec(text);
  if (numeric !== null) {
    const month = Number.parseInt(numeric[1] as string, 10);
    return month >= 1 && month <= 12 ? month : undefined;
  }
  const index = BIBTEX_MONTHS.findIndex((name) => text.startsWith(name));
  return index === -1 ? undefined : index + 1;
};

/** `2019/04/01/` — the RIS `DA` tag. Trailing slashes are part of the format, not a mistake. */
export const risDate = (parts: DateParts): string => {
  const month = parts.month === undefined ? '' : String(parts.month).padStart(2, '0');
  const day = parts.day === undefined ? '' : String(parts.day).padStart(2, '0');
  return `${String(parts.year).padStart(4, '0')}/${month}/${day}/`;
};

/** Parse a RIS `DA` or `Y2` value. Everything after the third field is a free-text season label. */
export const parseRisDate = (value: string): DateParts | undefined => {
  const fields = value.split('/');
  const year = Number.parseInt((fields[0] ?? '').trim(), 10);
  if (Number.isNaN(year)) return undefined;
  const month = Number.parseInt((fields[1] ?? '').trim(), 10);
  const day = Number.parseInt((fields[2] ?? '').trim(), 10);
  return {
    year,
    month: Number.isNaN(month) ? undefined : month,
    day: Number.isNaN(day) ? undefined : day,
  };
};

/** The year a citation key uses (ADR-0016, segment `year`). */
export const issuedYear = (
  issuedDate: string | null | undefined,
  fallback: number | null | undefined,
): number | undefined => {
  const parsed = parseEdtf(issuedDate);
  const year = parsed?.start?.year ?? parsed?.end?.year;
  if (year !== undefined) return year;
  return typeof fallback === 'number' ? fallback : undefined;
};
