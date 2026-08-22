/**
 * Zotero's multipart date onto EDTF.
 *
 * Zotero stores a date as `YYYY-MM-DD ` followed by whatever the user or the translator actually
 * wrote: `2019-08-00 August 2019`, `0000-00-00 n.d.`, `2019-00-00 2019–2021`. The numeric part is
 * Zotero's own parse, with `00` for a component it could not determine; the trailing part is the
 * source string, and Zotero keeps it because its parse is lossy.
 *
 * Recueil stores `issued_date` as EDTF plus the derived `issued_year` and `issued_month`
 * (`spec/data-model.md` §3.5). The numeric part maps onto EDTF exactly. The source string does not
 * always, and where it does not — a range, a circa, a spelled-out month, an `n.d.` — it is kept in
 * the `zotero_date_raw` custom field rather than dropped, because a migration that quietly loses
 * "2019–2021" is a migration that has to be checked by hand.
 */

export interface MappedDate {
  /** EDTF, as `item_bibliographic.issued_date` wants it. Null when Zotero determined no year. */
  edtf: string | null;
  year: number | null;
  month: number | null;
  /** The user-visible string Zotero kept, trimmed. Null when there was none. */
  raw: string | null;
  /**
   * True when `raw` says something `edtf` does not — a range, a qualifier, a spelled-out month, or
   * no parseable date at all. The importer preserves those in a custom field.
   */
  rawIsLossy: boolean;
}

const MULTIPART = /^(\d{4})-(\d{2})-(\d{2})(?:\s+([\s\S]*))?$/u;

/** Parse one `itemData` date value. */
export const mapZoteroDate = (value: string | null | undefined): MappedDate => {
  const text = (value ?? '').trim();
  if (text === '') return { edtf: null, year: null, month: null, raw: null, rawIsLossy: false };

  const match = MULTIPART.exec(text);
  if (match === null) {
    // Not Zotero's multipart shape at all: an older database, or a hand-edited row.
    const bare = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/u.exec(text);
    if (bare === null) return { edtf: null, year: null, month: null, raw: text, rawIsLossy: true };
    const year = Number.parseInt(bare[1] as string, 10);
    const month = bare[2] === undefined ? null : Number.parseInt(bare[2], 10);
    const day = bare[3] === undefined ? null : Number.parseInt(bare[3], 10);
    return { edtf: composeEdtf(year, month, day), year, month, raw: null, rawIsLossy: false };
  }

  const year = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  const day = Number.parseInt(match[3] as string, 10);
  const raw = (match[4] ?? '').trim();

  const resolvedYear = year === 0 ? null : year;
  const resolvedMonth = month === 0 ? null : month;
  const resolvedDay = day === 0 ? null : day;
  const edtf = resolvedYear === null ? null : composeEdtf(resolvedYear, resolvedMonth, resolvedDay);

  return {
    edtf,
    year: resolvedYear,
    month: resolvedMonth,
    raw: raw === '' ? null : raw,
    rawIsLossy: raw !== '' && !reproducesEdtf(raw, edtf, resolvedYear, resolvedMonth, resolvedDay),
  };
};

const composeEdtf = (year: number, month: number | null, day: number | null): string => {
  const yyyy = String(year).padStart(4, '0');
  if (month === null) return yyyy;
  const mm = String(month).padStart(2, '0');
  if (day === null) return `${yyyy}-${mm}`;
  return `${yyyy}-${mm}-${String(day).padStart(2, '0')}`;
};

/**
 * Whether the source string says no more than the EDTF does.
 *
 * Deliberately strict: anything that is not the EDTF itself, or the bare numbers it was built
 * from, counts as saying more. Being wrong in this direction costs one preserved string; being
 * wrong in the other costs the information.
 */
const reproducesEdtf = (
  raw: string,
  edtf: string | null,
  year: number | null,
  month: number | null,
  day: number | null,
): boolean => {
  if (edtf === null) return false;
  const compact = raw.replace(/\s+/gu, '');
  if (compact === edtf) return true;
  if (month === null && day === null && compact === String(year)) return true;
  if (day === null && month !== null && compact === `${year}-${String(month).padStart(2, '0')}`) return true;
  return false;
};

/**
 * Zotero's `accessDate`, which is a plain SQL timestamp in UTC, onto the fixed-width form
 * `spec/data-model.md` §1.1 requires.
 */
export const mapZoteroTimestamp = (value: string | null | undefined): string | null => {
  const text = (value ?? '').trim();
  if (text === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(text);
  if (match === null) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const [, yyyy, mm, dd, hh, mi, ss] = match as unknown as string[];
  const parsed = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
