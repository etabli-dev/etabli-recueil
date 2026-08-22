/**
 * CSL-JSON import.
 *
 * The input is JSON, so there is no grammar to get wrong; the work is entirely in the mapping, and
 * in being honest about the variables that have no home. A CSL-JSON file produced by Zotero carries
 * a dozen variables Recueil has no column for, and every one of them is reported.
 */
import { formatEdtf, fromDateParts } from '../dates.js';
import {
  normaliseDoi,
  normaliseIsbn,
  normaliseIssn,
  normaliseLanguageTag,
  normalisePmcid,
  normalisePmid,
  normaliseUrl,
} from '../identifiers.js';
import type { Normalised } from '../identifiers.js';
import { LossReport } from '../loss.js';
import type { ImportResult } from '../loss.js';
import { creatorFromNameParts, parseCslName } from '../names.js';
import type { FormatBibliographic, FormatCreator, FormatRecord } from '../record.js';
import { CSL_TYPES, CSL_TYPES_REVERSED } from '../mapping/types.js';
import type { CslDate, CslItem, CslName } from './types.js';

/** Variables this importer maps. Everything else in an item is reported. */
const HANDLED = new Set([
  'id', 'type', 'citation-key', 'author', 'editor', 'translator', 'title', 'title-short',
  'container-title', 'container-title-short', 'collection-title', 'collection-number', 'volume',
  'issue', 'page', 'page-first', 'number-of-pages', 'edition', 'version', 'genre', 'publisher',
  'publisher-place', 'issued', 'available-date', 'accessed', 'DOI', 'ISBN', 'ISSN', 'PMID',
  'PMCID', 'URL', 'abstract', 'keyword', 'language', 'note',
]);

const asText = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0 ? text : undefined;
  }
  if (typeof value === 'number') return String(value);
  return undefined;
};

const asNames = (value: unknown): CslName[] =>
  Array.isArray(value) ? value.filter((entry): entry is CslName => typeof entry === 'object' && entry !== null) : [];

const asDate = (value: unknown): CslDate | undefined =>
  typeof value === 'object' && value !== null ? (value as CslDate) : undefined;

const edtfFromCsl = (date: CslDate): string | undefined => {
  const parts = date['date-parts'];
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const start = fromDateParts(parts[0] ?? []);
  if (start === undefined) return undefined;
  const end = parts.length > 1 ? fromDateParts(parts[1] ?? []) : undefined;
  const circa = date.circa === true || date.circa === 1 || date.circa === '1' || date.circa === 'true';
  return formatEdtf({ start, end, circa, openStart: false, openEnd: false, raw: '' });
};

const buildRecord = (item: CslItem, index: number, report: LossReport): FormatRecord => {
  const key = asText(item['citation-key']) ?? asText(item.id);
  const cslType = asText(item.type) ?? 'document';
  const itemType = CSL_TYPES_REVERSED[cslType];
  if (itemType === undefined) {
    report.add(index, 'type', `unknown CSL type \`${cslType}\`; imported as a report`, cslType, key);
  }
  const genre = asText(item.genre);
  const resolvedType = itemType === 'article' && genre?.toLowerCase() === 'preprint' ? 'preprint' : itemType ?? 'report';

  const bib: Record<string, unknown> = {};
  const set = (field: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.length === 0) return;
    bib[field] = value;
  };
  const setNormalised = (field: string, raw: string | undefined, normalise: (value: string) => Normalised): void => {
    if (raw === undefined) return;
    const outcome = normalise(raw);
    if (outcome.ok) set(field, outcome.value);
    else report.add(index, field, outcome.reason, raw, key);
  };

  const creators: FormatCreator[] = [];
  const addNames = (value: unknown, role: FormatCreator['role']): void => {
    for (const name of asNames(value)) {
      const creator = creatorFromNameParts(parseCslName(name), role);
      if (creator !== undefined) creators.push(creator);
    }
  };
  addNames(item.author, 'author');
  addNames(item.editor, 'editor');
  addNames(item.translator, 'translator');

  const title = asText(item.title);
  set('title', title);
  set('shortTitle', asText(item['title-short']));
  set('containerTitle', asText(item['container-title']));
  set('containerShort', asText(item['container-title-short']));
  set('collectionTitle', asText(item['collection-title']));
  set('collectionNumber', asText(item['collection-number']));
  set('volume', asText(item.volume));
  set('issue', asText(item.issue));

  const page = asText(item.page);
  set('pages', page);
  const pageFirst = asText(item['page-first']);
  if (pageFirst !== undefined && /^\d+$/u.test(pageFirst)) set('pageFirst', Number.parseInt(pageFirst, 10));
  if (page !== undefined) {
    const range = /^\s*(\d+)\s*(?:--|–|-)\s*(\d+)\s*$/u.exec(page);
    if (range !== null) {
      if (bib.pageFirst === undefined) set('pageFirst', Number.parseInt(range[1] as string, 10));
      set('pageLast', Number.parseInt(range[2] as string, 10));
    } else if (/^\s*\d+\s*$/u.test(page) && bib.pageFirst === undefined) {
      set('pageFirst', Number.parseInt(page.trim(), 10));
    }
  }
  const total = asText(item['number-of-pages']);
  if (total !== undefined && /^\d+$/u.test(total)) set('numberOfPages', Number.parseInt(total, 10));
  set('edition', asText(item.edition));
  set('versionLabel', asText(item.version));
  set('publisher', asText(item.publisher));
  set('publisherPlace', asText(item['publisher-place']));
  /* Keep the CSL type only when it is finer than the round trip would reproduce: `article-magazine`
     maps to `article`, whose forward mapping is `article-journal`, so the original has to be kept. */
  if (CSL_TYPES[resolvedType] !== cslType) set('cslType', cslType);
  if (genre !== undefined && resolvedType !== 'preprint') {
    report.add(index, 'genre', 'the contract has no genre field', genre, key);
  }

  const issued = asDate(item.issued);
  if (issued !== undefined) {
    const edtf = edtfFromCsl(issued);
    if (edtf === undefined) {
      report.add(index, 'issued', 'the issued date has no usable `date-parts`', asText(issued.raw) ?? asText(issued.literal), key);
    } else {
      set('issuedDate', edtf);
      const start = fromDateParts(issued['date-parts']?.[0] ?? []);
      set('issuedYear', start?.year);
      set('issuedMonth', start?.month);
    }
    if (issued.season !== undefined) {
      report.add(index, 'issued.season', 'the contract has no season on a date', issued.season, key);
    }
  }
  const available = asDate(item['available-date']);
  if (available !== undefined) set('availableDate', edtfFromCsl(available));
  const accessed = asDate(item.accessed);
  if (accessed !== undefined) {
    const parts = fromDateParts(accessed['date-parts']?.[0] ?? []);
    if (parts !== undefined) {
      const month = String(parts.month ?? 1).padStart(2, '0');
      const day = String(parts.day ?? 1).padStart(2, '0');
      set('accessedAt', `${String(parts.year).padStart(4, '0')}-${month}-${day}T00:00:00.000Z`);
    }
  }

  setNormalised('doi', asText(item.DOI), normaliseDoi);
  setNormalised('isbn', asText(item.ISBN), normaliseIsbn);
  setNormalised('issn', asText(item.ISSN), normaliseIssn);
  setNormalised('pmid', asText(item.PMID), normalisePmid);
  setNormalised('pmcid', asText(item.PMCID), normalisePmcid);
  setNormalised('url', asText(item.URL), normaliseUrl);
  setNormalised('languageCode', asText(item.language), normaliseLanguageTag);
  set('abstract', asText(item.abstract));

  if (key !== undefined) {
    set('citationKey', key);
    set('citationKeyLocked', true);
  }

  for (const name of Object.keys(item)) {
    if (HANDLED.has(name)) continue;
    report.add(index, name, 'no contract field for this CSL variable', item[name], key);
  }

  const keywords = (asText(item.keyword) ?? '')
    .split(',')
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);

  return {
    id: key ?? `item${index + 1}`,
    itemType: resolvedType,
    title,
    extra: asText(item.note),
    creators,
    attachments: [],
    keywords,
    notes: [],
    bibliographic: bib as FormatBibliographic,
  };
};

/**
 * Parse CSL-JSON. Accepts an array of items, a single item, or the JSON text of either.
 *
 * Malformed JSON is a loss entry with an empty record list, not an exception: an importer reading a
 * directory of files should report the bad one and carry on with the rest.
 */
export const importCslJson = (source: string | readonly CslItem[] | CslItem): ImportResult => {
  const report = new LossReport('import', 'csl-json');
  let parsed: unknown = source;
  if (typeof source === 'string') {
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      report.add(0, '@syntax', `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return { records: [], losses: report.entries };
    }
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const records: FormatRecord[] = [];
  for (const [index, candidate] of items.entries()) {
    if (typeof candidate !== 'object' || candidate === null) {
      report.add(index, '@item', 'not a CSL-JSON object', candidate);
      continue;
    }
    records.push(buildRecord(candidate as CslItem, index, report));
  }
  return { records, losses: report.entries };
};
