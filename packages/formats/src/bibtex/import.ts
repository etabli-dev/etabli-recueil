/**
 * BibTeX and BibLaTeX import — the mirror of `export.ts` (P10).
 *
 * "Mirror" is a testable claim, not a slogan: the round-trip test in `test/roundtrip.test.ts`
 * exports a record, parses it back and asserts equality on every field the format can express, and
 * asserts a loss entry for every field it cannot. That is why this module accepts both dialects
 * without being told which it is reading — a real library contains files written by four different
 * tools — and why an unrecognised field produces a loss entry instead of being skipped.
 *
 * Keys arriving here are **pinned**: ADR-0016 requires that a key already sitting in a manuscript
 * survive the import untouched, so every imported entry sets `citationKeyLocked`.
 */
import { formatEdtf, parseBibtexMonth, parseEdtf } from '../dates.js';
import {
  normaliseArxivId,
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
import { creatorFromNameParts, parseBibtexName, splitBibtexNameList } from '../names.js';
import type { FormatAttachment, FormatBibliographic, FormatCreator, FormatRecord } from '../record.js';
import { collapseWhitespace, residualMacros, unescapeLatex } from '../text/latex.js';
import { BIBTEX_TYPES_REVERSED } from '../mapping/types.js';
import { parseFileField } from './fields.js';
import { parseBibtexFile, resolveCrossReferences } from './parse.js';
import type { RawBibEntry } from './parse.js';

export interface BibtexImportOptions {
  /**
   * Which dialect the loss report is filed under. Parsing is dialect-agnostic; this only labels
   * the entries, so a caller reading a mixed directory can still tell the two apart.
   */
  readonly format?: 'bibtex' | 'biblatex' | undefined;
}

/** Fields this importer knows what to do with. Everything else is reported. */
const HANDLED = new Set([
  'author', 'editor', 'translator', 'title', 'subtitle', 'shorttitle', 'booktitle', 'booksubtitle',
  'journal', 'journaltitle', 'shortjournal', 'series', 'volume', 'number', 'issue', 'pages',
  'pagetotal', 'edition', 'version', 'publisher', 'institution', 'school', 'organization',
  'address', 'location', 'type', 'year', 'month', 'date', 'urldate', 'doi', 'isbn', 'issn',
  'eprint', 'eprinttype', 'eprintclass', 'archiveprefix', 'primaryclass', 'pmid', 'pmcid', 'url',
  'abstract', 'keywords', 'language', 'langid', 'note', 'annotation', 'annote', 'file', 'crossref',
]);

const ARTICLE_LIKE = new Set(['article', 'periodical', 'suppperiodical']);

const text = (entry: RawBibEntry, name: string): string | undefined => {
  const raw = entry.fields.get(name);
  if (raw === undefined) return undefined;
  const value = collapseWhitespace(unescapeLatex(raw));
  return value.length > 0 ? value : undefined;
};

const namesOf = (entry: RawBibEntry, field: string, role: FormatCreator['role']): FormatCreator[] => {
  const raw = entry.fields.get(field);
  if (raw === undefined) return [];
  return splitBibtexNameList(raw)
    .map((name) => creatorFromNameParts(parseBibtexName(name), role))
    .filter((creator): creator is FormatCreator => creator !== undefined);
};

const PAGE_RANGE = /^\s*(\d+)\s*(?:--|–|-)\s*(\d+)\s*$/u;

const buildRecord = (
  entry: RawBibEntry,
  index: number,
  report: LossReport,
): FormatRecord => {
  const key = entry.key;
  const itemType = BIBTEX_TYPES_REVERSED[entry.type] ?? 'report';
  if (BIBTEX_TYPES_REVERSED[entry.type] === undefined) {
    report.add(index, entry.type, 'unknown entry type; imported as a report', entry.type, key);
  }

  const bib: Record<string, unknown> = {};
  const set = (field: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.length === 0) return;
    bib[field] = value;
  };
  const setNormalised = (field: string, raw: string | undefined, result: (value: string) => Normalised): void => {
    if (raw === undefined) return;
    const outcome = result(raw);
    if (outcome.ok) set(field, outcome.value);
    else report.add(index, field, outcome.reason, raw, key);
  };

  /* Title -------------------------------------------------------------------------------- */
  const title = text(entry, 'title');
  set('title', title);
  set('subtitle', text(entry, 'subtitle') ?? text(entry, 'booksubtitle'));
  set('shortTitle', text(entry, 'shorttitle'));

  /* Container ----------------------------------------------------------------------------- */
  set('containerTitle', text(entry, 'booktitle') ?? text(entry, 'journaltitle') ?? text(entry, 'journal'));
  set('containerShort', text(entry, 'shortjournal'));
  set('collectionTitle', text(entry, 'series'));

  /* Numbering ------------------------------------------------------------------------------ */
  set('volume', text(entry, 'volume'));
  const number = text(entry, 'number');
  const issue = text(entry, 'issue');
  if (ARTICLE_LIKE.has(entry.type)) {
    set('issue', issue ?? number);
  } else {
    set('collectionNumber', number);
    set('issue', issue);
  }

  const pages = text(entry, 'pages');
  if (pages !== undefined) {
    set('pages', pages.replace(/\s*(?:--+|–|—)\s*/gu, '-'));
    const range = PAGE_RANGE.exec(pages);
    if (range !== null) {
      set('pageFirst', Number.parseInt(range[1] as string, 10));
      set('pageLast', Number.parseInt(range[2] as string, 10));
    } else if (/^\s*\d+\s*$/u.test(pages)) {
      set('pageFirst', Number.parseInt(pages.trim(), 10));
    }
  }
  const pagetotal = text(entry, 'pagetotal');
  if (pagetotal !== undefined && /^\d+$/u.test(pagetotal)) set('numberOfPages', Number.parseInt(pagetotal, 10));
  set('edition', text(entry, 'edition'));
  set('versionLabel', text(entry, 'version'));

  /* Publication ---------------------------------------------------------------------------- */
  set('publisher', text(entry, 'publisher') ?? text(entry, 'institution') ?? text(entry, 'school') ?? text(entry, 'organization'));
  set('publisherPlace', text(entry, 'location') ?? text(entry, 'address'));

  /* Dates ---------------------------------------------------------------------------------- */
  const date = text(entry, 'date');
  const parsedDate = date === undefined ? undefined : parseEdtf(date);
  if (date !== undefined && parsedDate === undefined) {
    report.add(index, 'date', 'the `date` field is not an EDTF/ISO-8601 date the contract accepts', date, key);
  }
  if (parsedDate !== undefined) {
    const edtf = formatEdtf(parsedDate);
    set('issuedDate', edtf);
    if (parsedDate.start !== undefined) {
      set('issuedYear', parsedDate.start.year);
      set('issuedMonth', parsedDate.start.month);
    }
  } else {
    const year = text(entry, 'year');
    const month = parseBibtexMonth(text(entry, 'month'));
    if (year !== undefined) {
      const numeric = /(\d{4})/u.exec(year);
      if (numeric === null) {
        report.add(index, 'year', 'no four-digit year in the `year` field', year, key);
      } else {
        const yearNumber = Number.parseInt(numeric[1] as string, 10);
        set('issuedYear', yearNumber);
        set('issuedDate', month === undefined ? String(yearNumber) : `${yearNumber}-${String(month).padStart(2, '0')}`);
        set('issuedMonth', month);
      }
    }
  }
  const urldate = text(entry, 'urldate');
  if (urldate !== undefined) {
    const day = /^(\d{4}-\d{2}-\d{2})/u.exec(urldate);
    if (day === null) report.add(index, 'urldate', 'not a YYYY-MM-DD access date', urldate, key);
    else set('accessedAt', `${day[1] as string}T00:00:00.000Z`);
  }

  /* Identifiers ---------------------------------------------------------------------------- */
  setNormalised('doi', text(entry, 'doi'), normaliseDoi);
  setNormalised('isbn', text(entry, 'isbn'), normaliseIsbn);
  setNormalised('issn', text(entry, 'issn'), normaliseIssn);
  setNormalised('pmid', text(entry, 'pmid'), normalisePmid);
  setNormalised('pmcid', text(entry, 'pmcid'), normalisePmcid);
  setNormalised('url', text(entry, 'url'), normaliseUrl);

  const eprint = text(entry, 'eprint');
  const eprintType = (text(entry, 'eprinttype') ?? text(entry, 'archiveprefix') ?? '').toLowerCase();
  if (eprint !== undefined) {
    if (eprintType === '' || eprintType === 'arxiv') setNormalised('arxivId', eprint, normaliseArxivId);
    else if (eprintType === 'pubmed') setNormalised('pmid', eprint, normalisePmid);
    else report.add(index, 'eprint', `no contract field for an eprint of type \`${eprintType}\``, eprint, key);
  }

  /* Text ------------------------------------------------------------------------------------ */
  set('abstract', text(entry, 'abstract'));
  setNormalised('languageCode', text(entry, 'langid') ?? text(entry, 'language'), normaliseLanguageTag);

  set('citationKey', key.length > 0 ? key : undefined);
  if (key.length > 0) set('citationKeyLocked', true);

  /* Attachments ------------------------------------------------------------------------------ */
  const fileField = entry.fields.get('file');
  const attachments: FormatAttachment[] = fileField === undefined
    ? []
    : parseFileField(fileField).map((file) => ({
        path: file.path,
        title: file.title,
        mimeType: file.mimeType,
        role: 'primary',
      }));

  const keywords = (text(entry, 'keywords') ?? '')
    .split(/[,;]/u)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);

  const notes = [text(entry, 'annotation'), text(entry, 'annote')].filter(
    (note): note is string => note !== undefined,
  );

  const creators = [
    ...namesOf(entry, 'author', 'author'),
    ...namesOf(entry, 'editor', 'editor'),
    ...namesOf(entry, 'translator', 'translator'),
  ];

  /* Unhandled fields, and macros nothing could decode ---------------------------------------- */
  for (const [field, value] of entry.fields) {
    if (HANDLED.has(field)) continue;
    report.add(index, field, 'no contract field for this BibTeX field', collapseWhitespace(unescapeLatex(value)), key);
  }
  for (const [field, value] of entry.fields) {
    const residue = residualMacros(unescapeLatex(value));
    if (residue.length > 0) {
      report.add(index, field, `kept verbatim: unrecognised LaTeX ${residue.join(', ')}`, value, key);
    }
  }

  return {
    id: key.length > 0 ? key : `entry${index + 1}`,
    itemType,
    title,
    extra: text(entry, 'note'),
    creators,
    attachments,
    keywords,
    notes,
    bibliographic: bib as FormatBibliographic,
  };
};

/**
 * Parse a `.bib` file into records.
 *
 * `@string` macros are expanded, `crossref` is resolved and `@preamble` is reported — a preamble is
 * TeX that belongs to the document, not to any entry, and there is nowhere in the library to keep
 * it.
 */
export const importBibtex = (source: string, options: BibtexImportOptions = {}): ImportResult => {
  const report = new LossReport('import', options.format ?? 'bibtex');
  const file = resolveCrossReferences(parseBibtexFile(source));

  for (const preamble of file.preambles) {
    report.add(0, '@preamble', 'a preamble is document-level TeX with no library counterpart', preamble);
  }
  for (const error of file.errors) {
    report.add(0, '@syntax', `${error.message} (offset ${error.offset})`, undefined);
  }

  const records = file.entries.map((entry, index) => buildRecord(entry, index, report));
  return { records, losses: report.entries };
};

/** The same parser, labelled as BibLaTeX in the loss report. */
export const importBiblatex = (source: string): ImportResult => importBibtex(source, { format: 'biblatex' });
