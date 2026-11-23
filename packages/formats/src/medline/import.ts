/**
 * PubMed's MEDLINE format (`.nbib`, "Save → Format: PubMed"), the export systematic reviewers
 * take from PubMed (CONCEPT §5.10 item 2).
 *
 * A record is a block of `TAG - value` lines, the tag left-aligned in four columns; continuation
 * lines are indented six spaces; records are separated by a blank line. The tags read here are the
 * ones the bibliographic contract carries; the rest are reported as dropped, as every importer
 * here does.
 */
import { formatEdtf } from '../dates.js';
import { normaliseDoi, normaliseIssn, normalisePmid } from '../identifiers.js';
import { LossReport } from '../loss.js';
import type { ImportResult } from '../loss.js';
import { creatorFromNameParts, parseRisName } from '../names.js';
import type { FormatBibliographic, FormatCreator, FormatRecord } from '../record.js';

const TAG_LINE = /^([A-Z][A-Z0-9]{0,3})\s*-\s(.*)$/u;
const CONTINUATION = /^\s{6}(.*)$/u;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** ISO 639-2 codes PubMed uses, to the BCP 47 tags the contract stores. */
const LANGUAGES: Record<string, string> = { eng: 'en', ger: 'de', fre: 'fr', spa: 'es', ita: 'it', por: 'pt', dut: 'nl', rus: 'ru', chi: 'zh', jpn: 'ja', pol: 'pl', swe: 'sv', dan: 'da', nor: 'no', kor: 'ko', tur: 'tr' };

/** The publication types that decide the item type; everything else is a journal article. */
const TYPE_FROM_PT: [RegExp, string][] = [
  [/^Preprint$/iu, 'preprint'],
  [/^Congress$/iu, 'conference_paper'],
  [/^(Book|Monograph)$/iu, 'book'],
  [/^Book Chapter$/iu, 'chapter'],
  [/^Dataset$/iu, 'dataset'],
];

const HANDLED = new Set(['PMID', 'TI', 'BTI', 'AB', 'AU', 'FAU', 'CN', 'DP', 'TA', 'JT', 'VI', 'IP', 'PG', 'AID', 'LID', 'IS', 'LA', 'PT', 'MH', 'OT', 'PMC', 'OWN', 'STAT', 'DCOM', 'LR', 'EDAT', 'MHDA', 'CRDT', 'PHST', 'PST', 'SO', 'JID', 'SB', 'AD', 'AUID', 'GR', 'CI', 'COIS', 'EIN', 'CIN', 'RN', 'DEP', 'PL']);

export interface RawMedlineRecord {
  readonly tags: readonly (readonly [string, string])[];
  readonly line: number;
}

export const parseMedlineFile = (source: string): RawMedlineRecord[] => {
  const records: RawMedlineRecord[] = [];
  let current: { tags: [string, string][]; line: number } | undefined;
  for (const [position, line] of source.split(/\r\n|\n|\r/u).entries()) {
    if (line.trim() === '') {
      if (current !== undefined && current.tags.length > 0) records.push(current);
      current = undefined;
      continue;
    }
    const tag = TAG_LINE.exec(line);
    if (tag !== null) {
      current ??= { tags: [], line: position + 1 };
      current.tags.push([tag[1]!, tag[2]!.trim()]);
      continue;
    }
    const continued = CONTINUATION.exec(line);
    const last = current?.tags.at(-1);
    if (continued !== null && last !== undefined) last[1] = `${last[1]} ${continued[1]!.trim()}`;
  }
  if (current !== undefined && current.tags.length > 0) records.push(current);
  return records;
};

const parseDp = (value: string): { year: number; month?: number; day?: number } | undefined => {
  const match = /^(\d{4})(?:\s+([A-Za-z]{3})[a-z]*(?:-[A-Za-z]+)?(?:\s+(\d{1,2}))?)?/u.exec(value.trim());
  if (match === null) return undefined;
  const month = match[2] === undefined ? undefined : MONTHS[match[2].toLowerCase()];
  return { year: Number.parseInt(match[1]!, 10), ...(month === undefined ? {} : { month }), ...(month === undefined || match[3] === undefined ? {} : { day: Number.parseInt(match[3], 10) }) };
};

/** `101-9` → 101 and 109; PubMed abbreviates the last page. */
const expandPages = (pages: string): { first?: number; last?: number } => {
  const match = /^(\d+)(?:-(\d+))?/u.exec(pages);
  if (match === null) return {};
  const first = Number.parseInt(match[1]!, 10);
  if (match[2] === undefined) return { first };
  const tail = match[2];
  const last = tail.length < match[1]!.length ? Number.parseInt(match[1]!.slice(0, match[1]!.length - tail.length) + tail, 10) : Number.parseInt(tail, 10);
  return { first, last };
};

const buildRecord = (raw: RawMedlineRecord, index: number, report: LossReport): FormatRecord => {
  const all = (tag: string): string[] => raw.tags.filter(([name]) => name === tag).map(([, value]) => value);
  const one = (tag: string): string | undefined => all(tag)[0];
  const pmid = one('PMID');
  const key = pmid === undefined ? undefined : `pmid${pmid}`;
  const bib: Record<string, unknown> = {};
  const set = (field: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return;
    bib[field] = value;
  };

  const creators: FormatCreator[] = [];
  const full = all('FAU');
  for (const name of full.length > 0 ? full : all('AU')) {
    const creator = creatorFromNameParts(parseRisName(full.length > 0 ? name : name.replace(/^(\S+(?:\s\S+)*?)\s([A-Z]{1,3})$/u, '$1, $2')), 'author');
    if (creator !== undefined) creators.push(creator);
  }
  for (const group of all('CN')) creators.push({ role: 'author', kind: 'organisation', literalName: group });

  const title = (one('TI') ?? one('BTI'))?.replace(/\.$/u, '');
  set('title', title);
  set('abstract', one('AB'));
  set('containerTitle', one('JT'));
  set('containerShort', one('TA'));
  set('volume', one('VI'));
  set('issue', one('IP'));
  const pages = one('PG');
  if (pages !== undefined) {
    set('pages', pages);
    const { first, last } = expandPages(pages);
    set('pageFirst', first);
    set('pageLast', last);
  }
  const dp = one('DP');
  const date = dp === undefined ? undefined : parseDp(dp);
  if (date !== undefined) {
    set('issuedDate', formatEdtf({ start: date, circa: false, openStart: false, openEnd: false, raw: dp! }));
    set('issuedYear', date.year);
    set('issuedMonth', date.month);
  } else if (dp !== undefined) report.add(index, 'DP', 'no four-digit year in the `DP` tag', dp, key);

  if (pmid !== undefined) {
    const normalised = normalisePmid(pmid);
    if (normalised.ok) set('pmid', normalised.value);
    else report.add(index, 'PMID', normalised.reason ?? 'not a PMID', pmid, key);
  }
  const pmc = one('PMC');
  if (pmc !== undefined && /^PMC\d+$/u.test(pmc)) set('pmcid', pmc);
  const doiRaw = [...all('AID'), ...all('LID')].find((value) => /\[doi\]$/u.test(value))?.replace(/\s*\[doi\]$/u, '');
  if (doiRaw !== undefined) {
    const doi = normaliseDoi(doiRaw);
    if (doi.ok) set('doi', doi.value);
    else report.add(index, 'AID', doi.reason ?? 'not a DOI', doiRaw, key);
  }
  for (const issnRaw of all('IS')) {
    const issn = normaliseIssn(issnRaw.replace(/\s*\(.*\)$/u, ''));
    if (!issn.ok) continue;
    if (/\(Electronic\)/u.test(issnRaw)) set('eissn', issn.value);
    else if (bib['issn'] === undefined) set('issn', issn.value);
  }
  const language = one('LA');
  if (language !== undefined) {
    const tag = LANGUAGES[language.toLowerCase()];
    if (tag === undefined) report.add(index, 'LA', 'no language tag known for this PubMed code', language, key);
    else set('languageCode', tag);
  }

  const types = all('PT');
  const itemType = TYPE_FROM_PT.find(([pattern]) => types.some((type) => pattern.test(type)))?.[1] ?? (one('BTI') !== undefined ? 'book' : 'article');

  for (const [tag, value] of raw.tags) {
    if (HANDLED.has(tag)) continue;
    report.add(index, tag, 'no contract field for this MEDLINE tag', value, key);
  }

  return {
    ...(key === undefined ? {} : { id: key }),
    itemType,
    title,
    creators,
    // MeSH headings and author keywords, as the other importers carry keywords.
    keywords: [...all('MH').map((heading) => heading.replace(/\*/gu, '')), ...all('OT')],
    bibliographic: bib as FormatBibliographic,
  };
};

/** Parse a MEDLINE/NBIB file into records. */
export const importMedline = (source: string): ImportResult => {
  const report = new LossReport('import', 'medline');
  const records = parseMedlineFile(source).map((raw, index) => buildRecord(raw, index, report));
  return { records, losses: report.entries };
};
