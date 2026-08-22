/**
 * CSL-JSON export.
 *
 * CSL-JSON is the richest of the four for dates and names and the poorest for everything that is
 * not a citation: it is the input format of a citation processor, so it has `date-parts` that can
 * hold a partial date and a range, structured names that can hold a particle and a suffix, and no
 * concept whatever of a file on disk.
 *
 * Variables are written in a fixed order (`CSL_VARIABLE_ORDER`) because `JSON.stringify` preserves
 * insertion order and a `.json` file in a repository deserves a stable diff for the same reason a
 * `.bib` file does.
 */
import { formatEdtfPoint, parseEdtf, toDateParts } from '../dates.js';
import { LossReport } from '../loss.js';
import type { ExportResult } from '../loss.js';
import { formatCslName } from '../names.js';
import { creatorsWithRole, recordTitle, trimmed } from '../record.js';
import type { FormatRecord } from '../record.js';
import { disambiguate } from '../keys/generate.js';
import type { GenerateKeyOptions } from '../keys/generate.js';
import { CSL_FALLBACK_TYPE, CSL_TYPES } from '../mapping/types.js';
import { CSL_VARIABLE_ORDER } from './types.js';
import type { CslDate, CslItem } from './types.js';

export interface CslExportOptions {
  readonly keys?: ReadonlyMap<string, string> | undefined;
  readonly keyOptions?: GenerateKeyOptions | undefined;
  /** Indentation for the rendered JSON. Default two spaces; `0` for a single line. */
  readonly indent?: number | undefined;
}

export interface CslExportResult extends ExportResult {
  /** The items themselves, for a caller that wants to hand them to citeproc rather than a file. */
  readonly items: readonly CslItem[];
}

/** Fields the contract holds that CSL 1.0.2 has no variable for. */
const UNREPRESENTABLE: readonly (readonly [string, string])[] = [
  ['arxivId', 'CSL has no arXiv variable'],
  ['openalexId', 'CSL has no OpenAlex variable'],
  ['semanticScholarId', 'CSL has no Semantic Scholar variable'],
  ['issnL', 'CSL has one ISSN variable'],
  ['dataciteDoi', 'CSL has one DOI variable'],
  ['handle', 'CSL has no Handle variable'],
  ['oaStatus', 'CSL has no open-access variable'],
  ['publishedVersionDoi', 'CSL has no variable for the published version of a preprint'],
  ['retractionNoticeDoi', 'CSL has no retraction variable'],
  ['licence', 'CSL 1.0.2 has no licence variable'],
  ['citationKeyFormula', 'the formula is library state, not bibliographic data'],
];

const cslDate = (edtf: string | null | undefined): CslDate | undefined => {
  const parsed = parseEdtf(edtf);
  if (parsed === undefined) return undefined;
  const parts: number[][] = [];
  if (parsed.start !== undefined) parts.push(toDateParts(parsed.start));
  if (parsed.end !== undefined) parts.push(toDateParts(parsed.end));
  if (parts.length === 0) return undefined;
  const date: CslDate = { 'date-parts': parts };
  if (parsed.circa) date.circa = true;
  return date;
};

const buildItem = (
  record: FormatRecord,
  index: number,
  key: string,
  report: LossReport,
): CslItem => {
  const bib = record.bibliographic ?? {};
  const draft = new Map<string, unknown>();
  const put = (name: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.length === 0) return;
    if (Array.isArray(value) && value.length === 0) return;
    draft.set(name, value);
  };

  const override = trimmed(bib.cslType);
  const mapped = CSL_TYPES[record.itemType];
  if (override === undefined && mapped === undefined) {
    report.add(index, 'itemType', 'no CSL type for this item type; exported as `document`', record.itemType, key);
  }
  if (override === undefined && mapped === CSL_FALLBACK_TYPE && record.itemType !== 'note' && record.itemType !== 'attachment_only') {
    report.add(index, 'itemType', 'CSL has no type for this item type; it collapses to `document`', record.itemType, key);
  }
  put('id', key);
  put('type', override ?? mapped ?? CSL_FALLBACK_TYPE);
  put('citation-key', key);

  put('author', creatorsWithRole(record, 'author').map(formatCslName));
  put('editor', creatorsWithRole(record, 'editor').map(formatCslName));
  put('translator', creatorsWithRole(record, 'translator').map(formatCslName));
  for (const creator of record.creators ?? []) {
    if (creator.role === 'author' || creator.role === 'editor' || creator.role === 'translator') continue;
    report.add(index, `creators.${creator.role}`, 'this package maps authors, editors and translators to CSL name variables', creator.familyName ?? creator.literalName, key);
  }

  const title = recordTitle(record);
  const subtitle = trimmed(bib.subtitle);
  put('title', subtitle === undefined ? title : `${title ?? ''}: ${subtitle}`);
  if (subtitle !== undefined) {
    report.add(index, 'subtitle', 'CSL has one title variable; the subtitle is appended after a colon and cannot be split apart again', subtitle, key);
  }
  put('title-short', trimmed(bib.shortTitle));
  put('container-title', trimmed(bib.containerTitle));
  put('container-title-short', trimmed(bib.containerShort));
  put('collection-title', trimmed(bib.collectionTitle));
  put('collection-number', trimmed(bib.collectionNumber));
  put('volume', trimmed(bib.volume));
  put('issue', trimmed(bib.issue));
  put('page', trimmed(bib.pages));
  put('page-first', typeof bib.pageFirst === 'number' ? String(bib.pageFirst) : undefined);
  put('number-of-pages', typeof bib.numberOfPages === 'number' ? String(bib.numberOfPages) : undefined);
  put('edition', trimmed(bib.edition));
  put('version', trimmed(bib.versionLabel));
  if (record.itemType === 'preprint') put('genre', 'preprint');
  put('publisher', trimmed(bib.publisher));
  put('publisher-place', trimmed(bib.publisherPlace));

  const issued = cslDate(bib.issuedDate);
  if (issued !== undefined) put('issued', issued);
  else if (typeof bib.issuedYear === 'number') put('issued', { 'date-parts': [[bib.issuedYear]] });
  const parsedIssued = parseEdtf(bib.issuedDate);
  if (parsedIssued?.openStart === true || parsedIssued?.openEnd === true) {
    report.add(index, 'issuedDate', 'CSL `date-parts` cannot express an open-ended interval', bib.issuedDate, key);
  }
  put('available-date', cslDate(bib.availableDate));
  const accessed = trimmed(bib.accessedAt);
  if (accessed !== undefined) {
    put('accessed', cslDate(accessed.slice(0, 10)));
    if (!accessed.endsWith('T00:00:00.000Z')) {
      report.add(index, 'accessedAt', 'CSL `accessed` is a calendar date; the time of day is dropped', accessed, key);
    }
  }

  put('DOI', trimmed(bib.doi));
  put('ISBN', trimmed(bib.isbn));
  put('ISSN', trimmed(bib.issn) ?? trimmed(bib.eissn));
  if (trimmed(bib.issn) !== undefined && trimmed(bib.eissn) !== undefined) {
    report.add(index, 'eissn', 'CSL has one ISSN variable, taken by the print ISSN', bib.eissn, key);
  }
  put('PMID', trimmed(bib.pmid));
  put('PMCID', trimmed(bib.pmcid));
  put('URL', trimmed(bib.url) ?? trimmed(bib.oaUrl));
  if (trimmed(bib.url) !== undefined && trimmed(bib.oaUrl) !== undefined) {
    report.add(index, 'oaUrl', 'CSL has one URL variable, taken by the canonical URL', bib.oaUrl, key);
  }

  put('abstract', trimmed(bib.abstract));
  const keywords = (record.keywords ?? []).map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0);
  put('keyword', keywords.length === 0 ? undefined : keywords.join(', '));
  put('language', trimmed(bib.languageCode));

  const notes = (record.notes ?? []).map((note) => note.trim()).filter((note) => note.length > 0);
  put('note', trimmed(record.extra));
  if (notes.length > 0) {
    report.add(index, 'notes', 'CSL has one `note` variable, taken by the Extra field', notes.length, key);
  }

  if ((record.attachments ?? []).length > 0) {
    report.add(index, 'attachments', 'CSL-JSON is a citation-processor input and has no file variable', (record.attachments ?? []).length, key);
  }

  const bibRecord = bib as Record<string, unknown>;
  for (const [field, reason] of UNREPRESENTABLE) {
    report.addIfPresent(index, field, reason, bibRecord[field], key);
  }

  const item: Record<string, unknown> = {};
  for (const name of CSL_VARIABLE_ORDER) {
    if (draft.has(name)) item[name] = draft.get(name);
  }
  for (const [name, value] of draft) {
    if (!(name in item)) item[name] = value;
  }
  return item as CslItem;
};

const resolveKeys = (records: readonly FormatRecord[], options: CslExportOptions): readonly string[] => {
  if (options.keys !== undefined) {
    const supplied = options.keys;
    return records.map((record, index) => {
      const byId = record.id === undefined ? undefined : supplied.get(record.id);
      return byId ?? trimmed(record.bibliographic?.citationKey) ?? `item${index + 1}`;
    });
  }
  const assignments = disambiguate(records, options.keyOptions ?? {});
  const byId = new Map(assignments.map((assignment) => [assignment.id, assignment.key]));
  return records.map((record, index) => byId.get(record.id ?? String(index)) ?? `item${index + 1}`);
};

/** Serialise records to CSL-JSON. */
export const exportCslJson = (
  records: readonly FormatRecord[],
  options: CslExportOptions = {},
): CslExportResult => {
  const report = new LossReport('export', 'csl-json');
  const keys = resolveKeys(records, options);
  const items = records.map((record, index) => buildItem(record, index, keys[index] as string, report));
  const indent = options.indent ?? 2;
  return { items, text: `${JSON.stringify(items, null, indent)}\n`, losses: report.entries };
};

/** The date helper, exported so a caller rendering one date need not build a whole item. */
export const toCslDate = (edtf: string | null | undefined): CslDate | undefined => cslDate(edtf);

/** `2019-04-01` from a CSL date, for a caller that wants the contract's spelling back. */
export const cslDateToEdtf = (date: CslDate): string | undefined => {
  const parts = date['date-parts'];
  const firstPart = parts?.[0];
  if (firstPart === undefined) return undefined;
  const [year, month, day] = firstPart;
  if (year === undefined) return undefined;
  return formatEdtfPoint({ year, month, day });
};
