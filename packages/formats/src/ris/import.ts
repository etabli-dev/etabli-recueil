/**
 * RIS import.
 *
 * The grammar is forgiving in practice and this parser matches that: one or three spaces before the
 * hyphen, a missing trailing space after `ER`, CRLF or LF, and continuation lines that belong to
 * the previous tag are all accepted, because every one of them appears in files real databases
 * emit. What is not accepted is silence: a tag this importer has no field for is reported.
 */
import { formatEdtf, parseRisDate } from '../dates.js';
import {
  normaliseDoi,
  normaliseIsbn,
  normaliseIssn,
  normaliseLanguageTag,
  normaliseUrl,
} from '../identifiers.js';
import { LossReport } from '../loss.js';
import type { ImportResult } from '../loss.js';
import { creatorFromNameParts, parseRisName } from '../names.js';
import type { FormatAttachment, FormatBibliographic, FormatCreator, FormatRecord } from '../record.js';
import { RIS_TYPES_REVERSED } from '../mapping/types.js';

/** One `TY … ER` block, tags in file order, repeats preserved. */
export interface RawRisRecord {
  readonly tags: readonly (readonly [string, string])[];
  /** One-based line number of the `TY` tag, for the loss report. */
  readonly line: number;
}

const TAG_LINE = /^([A-Z][A-Z0-9])\s{1,3}-\s?(.*)$/u;

/** Split a RIS file into raw records. Never throws; junk between records is reported by the caller. */
export const parseRisFile = (source: string): { readonly records: readonly RawRisRecord[]; readonly stray: readonly string[] } => {
  const records: RawRisRecord[] = [];
  const stray: string[] = [];
  let current: { tags: [string, string][]; line: number } | undefined;
  let last: [string, string] | undefined;

  const lines = source.split(/\r\n|\n|\r/u);
  for (const [position, line] of lines.entries()) {
    const match = TAG_LINE.exec(line);
    if (match === null) {
      if (line.trim().length === 0) continue;
      if (last !== undefined) last[1] = `${last[1]} ${line.trim()}`.trim();
      else stray.push(line.trim());
      continue;
    }
    const tag = match[1] as string;
    const value = (match[2] as string).trim();
    if (tag === 'TY') {
      if (current !== undefined) records.push(current);
      current = { tags: [], line: position + 1 };
    }
    if (current === undefined) {
      stray.push(line.trim());
      continue;
    }
    if (tag === 'ER') {
      records.push(current);
      current = undefined;
      last = undefined;
      continue;
    }
    const pair: [string, string] = [tag, value];
    current.tags.push(pair);
    last = pair;
  }
  if (current !== undefined) records.push(current);
  return { records, stray };
};

const HANDLED = new Set([
  'TY', 'ID', 'AU', 'A1', 'A2', 'A3', 'A4', 'ED', 'TI', 'T1', 'ST', 'T2', 'JO', 'JF', 'J2', 'JA',
  'T3', 'VL', 'IS', 'CP', 'SP', 'EP', 'ET', 'PB', 'CY', 'AD', 'PY', 'Y1', 'DA', 'Y2', 'SN', 'DO',
  'UR', 'AB', 'N2', 'KW', 'LA', 'N1', 'L1', 'ER',
]);

const first = (tags: ReadonlyMap<string, string[]>, ...names: string[]): string | undefined => {
  for (const name of names) {
    const values = tags.get(name);
    const value = values?.[0];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
};

const buildRecord = (raw: RawRisRecord, index: number, report: LossReport): FormatRecord => {
  const tags = new Map<string, string[]>();
  for (const [tag, value] of raw.tags) {
    const bucket = tags.get(tag);
    if (bucket === undefined) tags.set(tag, [value]);
    else bucket.push(value);
  }

  const type = first(tags, 'TY') ?? 'GEN';
  const key = first(tags, 'ID');
  const itemType = RIS_TYPES_REVERSED[type];
  if (itemType === undefined) {
    report.add(index, 'TY', `unknown RIS reference type \`${type}\`; imported as a report`, type, key);
  }

  const bib: Record<string, unknown> = {};
  const set = (field: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.length === 0) return;
    bib[field] = value;
  };
  const setNormalised = (
    field: string,
    raw2: string | undefined,
    normalise: (value: string) => { ok: boolean; value?: string; reason?: string },
  ): void => {
    if (raw2 === undefined) return;
    const outcome = normalise(raw2) as { ok: boolean; value?: string; reason?: string };
    if (outcome.ok && outcome.value !== undefined) set(field, outcome.value);
    else report.add(index, field, outcome.reason ?? 'rejected by the contract', raw2, key);
  };

  const creators: FormatCreator[] = [];
  const addNames = (names: readonly string[] | undefined, role: FormatCreator['role']): void => {
    for (const name of names ?? []) {
      const creator = creatorFromNameParts(parseRisName(name), role);
      if (creator !== undefined) creators.push(creator);
    }
  };
  addNames(tags.get('AU') ?? tags.get('A1'), 'author');
  addNames(tags.get('A2') ?? tags.get('ED'), 'editor');
  addNames(tags.get('A4'), 'translator');
  addNames(tags.get('A3'), 'contributor');

  const title = first(tags, 'TI', 'T1');
  set('title', title);
  set('shortTitle', first(tags, 'ST'));
  set('containerTitle', first(tags, 'T2', 'JO', 'JF'));
  set('containerShort', first(tags, 'J2', 'JA'));
  set('collectionTitle', first(tags, 'T3'));
  set('volume', first(tags, 'VL'));
  set('issue', first(tags, 'IS', 'CP'));

  const start = first(tags, 'SP');
  const end = first(tags, 'EP');
  if (start !== undefined) {
    set('pages', end === undefined ? start : `${start}-${end}`);
    if (/^\d+$/u.test(start)) set('pageFirst', Number.parseInt(start, 10));
    if (end !== undefined && /^\d+$/u.test(end)) set('pageLast', Number.parseInt(end, 10));
  }
  set('edition', first(tags, 'ET'));
  set('publisher', first(tags, 'PB'));
  set('publisherPlace', first(tags, 'CY', 'AD'));

  const date = first(tags, 'DA');
  const parsedDate = date === undefined ? undefined : parseRisDate(date);
  const year = first(tags, 'PY', 'Y1');
  const yearNumber = year === undefined ? undefined : Number.parseInt((/(\d{4})/u.exec(year) ?? [])[1] ?? '', 10);
  if (parsedDate !== undefined) {
    set('issuedDate', formatEdtf({ start: parsedDate, circa: false, openStart: false, openEnd: false, raw: date ?? '' }));
    set('issuedYear', parsedDate.year);
    set('issuedMonth', parsedDate.month);
  } else if (yearNumber !== undefined && !Number.isNaN(yearNumber)) {
    set('issuedDate', String(yearNumber));
    set('issuedYear', yearNumber);
  } else if (year !== undefined) {
    report.add(index, 'PY', 'no four-digit year in the `PY` tag', year, key);
  }

  const accessed = first(tags, 'Y2');
  if (accessed !== undefined) {
    const parts = parseRisDate(accessed);
    if (parts === undefined) report.add(index, 'Y2', 'not a RIS date', accessed, key);
    else {
      const month = String(parts.month ?? 1).padStart(2, '0');
      const day = String(parts.day ?? 1).padStart(2, '0');
      set('accessedAt', `${String(parts.year).padStart(4, '0')}-${month}-${day}T00:00:00.000Z`);
    }
  }

  const sn = first(tags, 'SN');
  if (sn !== undefined) {
    const issn = normaliseIssn(sn);
    if (issn.ok) set('issn', issn.value);
    else {
      const isbn = normaliseIsbn(sn);
      if (isbn.ok) set('isbn', isbn.value);
      else report.add(index, 'SN', 'neither a valid ISSN nor a valid ISBN', sn, key);
    }
  }

  setNormalised('doi', first(tags, 'DO'), normaliseDoi);
  setNormalised('url', first(tags, 'UR'), normaliseUrl);
  setNormalised('languageCode', first(tags, 'LA'), normaliseLanguageTag);
  set('abstract', first(tags, 'AB', 'N2'));

  if (key !== undefined) {
    set('citationKey', key);
    set('citationKeyLocked', true);
  }

  const attachments: FormatAttachment[] = (tags.get('L1') ?? []).map((path) => ({ path, role: 'primary' }));
  const notes = tags.get('N1') ?? [];

  for (const [tag, value] of raw.tags) {
    if (HANDLED.has(tag)) continue;
    report.add(index, tag, 'no contract field for this RIS tag', value, key);
  }

  return {
    id: key ?? `record${index + 1}`,
    itemType: itemType ?? 'report',
    title,
    extra: notes[0],
    creators,
    attachments,
    keywords: tags.get('KW') ?? [],
    notes: notes.slice(1),
    bibliographic: bib as FormatBibliographic,
  };
};

/** Parse a RIS file into records. */
export const importRis = (source: string): ImportResult => {
  const report = new LossReport('import', 'ris');
  const { records: raw, stray } = parseRisFile(source);
  for (const line of stray) {
    report.add(0, '@syntax', 'a line outside any TY…ER record', line);
  }
  const records = raw.map((entry, index) => buildRecord(entry, index, report));
  return { records, losses: report.entries };
};
