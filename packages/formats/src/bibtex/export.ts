/**
 * BibTeX and BibLaTeX export.
 *
 * One code path, two dialects, because they differ in about a dozen places and forking the file
 * would guarantee that a fix landed in one and not the other. The differences are:
 *
 * | | `bibtex` | `biblatex` |
 * |---|---|---|
 * | Non-ASCII | folded to `\'{e}`, `{\ss}` | UTF-8, verbatim |
 * | Date | `year` + `month` macro | `date`, ISO-8601/EDTF |
 * | Journal | `journal` | `journaltitle` |
 * | Place | `address` | `location` |
 * | Subtitle | appended to `title` after a colon | its own `subtitle` field |
 * | Language | `language` | `langid` |
 * | arXiv | `eprint` + `archiveprefix` | `eprint` + `eprinttype` |
 * | Entry types | fourteen | thirty-odd, so fewer collapse to `@misc` |
 *
 * Everything else — key generation, field order, brace protection, the `file` field — is shared.
 */
import { bibtexMonth, formatEdtf, parseEdtf } from '../dates.js';
import { LossReport } from '../loss.js';
import type { ExportResult } from '../loss.js';
import { formatBibtexName } from '../names.js';
import { creatorsWithRole, recordTitle, trimmed } from '../record.js';
import type { FormatRecord } from '../record.js';
import { escapeLatex, protectCapitals } from '../text/latex.js';
import { disambiguate } from '../keys/generate.js';
import type { GenerateKeyOptions } from '../keys/generate.js';
import { BIBLATEX_ENTRY_TYPES, BIBTEX_ENTRY_TYPES, BIBTEX_FALLBACK_ENTRY_TYPE } from '../mapping/types.js';
import { formatFileField, orderFields } from './fields.js';
import type { FileFieldEntry } from './fields.js';

export type BibtexDialect = 'bibtex' | 'biblatex';

export interface BibtexExportOptions {
  /** Default `bibtex`. `exportBiblatex` is the same call with `biblatex`. */
  readonly dialect?: BibtexDialect | undefined;
  /**
   * Keys by record id. Supply them from the library's key ledger; omit them and the exporter
   * disambiguates the batch itself, which is right for an ad-hoc export and wrong for a `.bib`
   * endpoint that has to agree with the manuscript.
   */
  readonly keys?: ReadonlyMap<string, string> | undefined;
  /** Passed through to `disambiguate` when `keys` is omitted. */
  readonly keyOptions?: GenerateKeyOptions | undefined;
  /** Emit the `file` field for attachments. Default `true`. */
  readonly includeFiles?: boolean | undefined;
  /** Brace-protect capitalised words in title fields. Default `true`. */
  readonly protectCapitals?: boolean | undefined;
  /** Indent for field lines. Default two spaces. */
  readonly indent?: string | undefined;
}

/** Fields the contract holds and neither `.bib` dialect has anywhere to put. */
const UNREPRESENTABLE: readonly (readonly [string, string])[] = [
  ['issnL', 'BibTeX has one ISSN field; the linking ISSN has no separate spelling'],
  ['openalexId', 'no field for an OpenAlex work id'],
  ['semanticScholarId', 'no field for a Semantic Scholar paper id'],
  ['dataciteDoi', 'one DOI field only'],
  ['handle', 'no field for a Handle'],
  ['availableDate', 'no field for the online-first date'],
  ['oaStatus', 'no field for open-access status'],
  ['publishedVersionDoi', 'no field for the published version of a preprint'],
  ['retractionNoticeDoi', 'no field for a retraction notice'],
  ['licence', 'no standard field for a licence'],
  ['cslType', 'the CSL type override has no BibTeX counterpart'],
  ['citationKeyFormula', 'the formula is library state, not bibliographic data'],
];

const CHAPTER_LIKE = new Set(['incollection', 'inbook', 'bookinbook', 'inproceedings', 'conference', 'inreference']);
const THESIS_LIKE = new Set(['phdthesis', 'mastersthesis', 'thesis']);
const REPORT_LIKE = new Set(['techreport', 'report']);
const ARTICLE_LIKE = new Set(['article', 'periodical', 'suppperiodical']);

const normalisePages = (value: string): string => {
  const single = /^\s*(\S+?)\s*-\s*(\S+?)\s*$/u.exec(value);
  if (single !== null) return `${single[1] as string}--${single[2] as string}`;
  return value.trim();
};

const pagesOf = (record: FormatRecord): string | undefined => {
  const bib = record.bibliographic;
  const printed = trimmed(bib?.pages);
  if (printed !== undefined) return normalisePages(printed);
  const first = bib?.pageFirst;
  const last = bib?.pageLast;
  if (typeof first !== 'number') return undefined;
  return typeof last === 'number' && last !== first ? `${first}--${last}` : String(first);
};

const fileEntries = (record: FormatRecord): FileFieldEntry[] => {
  const entries: FileFieldEntry[] = [];
  for (const attachment of record.attachments ?? []) {
    const path = trimmed(attachment.path);
    if (path === undefined) continue;
    entries.push({ title: trimmed(attachment.title), path, mimeType: trimmed(attachment.mimeType) });
  }
  return entries;
};

/** A field value plus whether it must be written bare (a `month` macro) rather than braced. */
interface FieldValue {
  readonly value: string;
  readonly bare?: boolean;
}

const buildEntry = (
  record: FormatRecord,
  index: number,
  key: string,
  dialect: BibtexDialect,
  options: BibtexExportOptions,
  report: LossReport,
): string => {
  const biblatex = dialect === 'biblatex';
  const escape = (value: string): string => escapeLatex(value, { unicode: biblatex });
  const protect = options.protectCapitals === false ? (value: string): string => value : protectCapitals;
  const titleValue = (value: string): string => protect(escape(value));

  const bib = record.bibliographic ?? {};
  const table = biblatex ? BIBLATEX_ENTRY_TYPES : BIBTEX_ENTRY_TYPES;
  const mapped = table[record.itemType];
  const entryType = mapped ?? BIBTEX_FALLBACK_ENTRY_TYPE;
  if (mapped === undefined) {
    report.add(index, 'itemType', `no ${dialect} entry type for this item type; exported as @misc`, record.itemType, key);
  } else if (mapped === BIBTEX_FALLBACK_ENTRY_TYPE && record.itemType !== 'note' && record.itemType !== 'attachment_only') {
    report.add(index, 'itemType', `${dialect} has no entry type for this item type; it collapses to @misc`, record.itemType, key);
  }

  const fields = new Map<string, FieldValue>();
  const put = (name: string, value: string | undefined, bare = false): void => {
    if (value === undefined || value.length === 0) return;
    fields.set(name, { value, bare });
  };

  /* Creators ------------------------------------------------------------------------------- */
  const authors = creatorsWithRole(record, 'author');
  const editors = creatorsWithRole(record, 'editor');
  const translators = creatorsWithRole(record, 'translator');
  put('author', authors.map((creator) => formatBibtexName(creator, { unicode: biblatex })).join(' and '));
  put('editor', editors.map((creator) => formatBibtexName(creator, { unicode: biblatex })).join(' and '));
  if (translators.length > 0) {
    if (biblatex) {
      put('translator', translators.map((creator) => formatBibtexName(creator, { unicode: true })).join(' and '));
    } else {
      report.add(index, 'creators.translator', 'classic BibTeX has no translator field', translators.length, key);
    }
  }
  for (const creator of record.creators ?? []) {
    if (creator.role === 'author' || creator.role === 'editor' || creator.role === 'translator') continue;
    report.add(index, `creators.${creator.role}`, 'BibTeX has fields for authors, editors and translators only', creator.familyName ?? creator.literalName, key);
  }

  /* Title ---------------------------------------------------------------------------------- */
  const title = recordTitle(record);
  const subtitle = trimmed(bib.subtitle);
  if (title !== undefined) {
    if (subtitle !== undefined && !biblatex) put('title', titleValue(`${title}: ${subtitle}`));
    else put('title', titleValue(title));
  }
  if (subtitle !== undefined) {
    if (biblatex) put('subtitle', titleValue(subtitle));
    else {
      report.add(index, 'subtitle', 'classic BibTeX has one title field; the subtitle is appended after a colon and cannot be split apart again', subtitle, key);
    }
  }
  put('shorttitle', trimmed(bib.shortTitle) === undefined ? undefined : titleValue(trimmed(bib.shortTitle) as string));

  /* Container ------------------------------------------------------------------------------ */
  const container = trimmed(bib.containerTitle);
  if (container !== undefined) {
    if (CHAPTER_LIKE.has(entryType)) put('booktitle', titleValue(container));
    else if (ARTICLE_LIKE.has(entryType)) put(biblatex ? 'journaltitle' : 'journal', titleValue(container));
    else put(biblatex ? 'journaltitle' : 'journal', titleValue(container));
  }
  put('shortjournal', trimmed(bib.containerShort) === undefined ? undefined : escape(trimmed(bib.containerShort) as string));
  put('series', trimmed(bib.collectionTitle) === undefined ? undefined : titleValue(trimmed(bib.collectionTitle) as string));

  /* Numbering ------------------------------------------------------------------------------ */
  put('volume', trimmed(bib.volume) === undefined ? undefined : escape(trimmed(bib.volume) as string));
  const issue = trimmed(bib.issue);
  const collectionNumber = trimmed(bib.collectionNumber);
  if (ARTICLE_LIKE.has(entryType)) {
    put('number', issue === undefined ? undefined : escape(issue));
    if (collectionNumber !== undefined) {
      report.add(index, 'collectionNumber', 'an @article uses `number` for the issue, leaving the series number nowhere to go', collectionNumber, key);
    }
  } else {
    const number = collectionNumber ?? issue;
    put('number', number === undefined ? undefined : escape(number));
    if (collectionNumber !== undefined && issue !== undefined) {
      if (biblatex) put('issue', escape(issue));
      else report.add(index, 'issue', 'classic BibTeX has one `number` field, taken by the series number', issue, key);
    }
  }
  put('pages', pagesOf(record) === undefined ? undefined : escape(pagesOf(record) as string));
  put('pagetotal', typeof bib.numberOfPages === 'number' ? String(bib.numberOfPages) : undefined);
  put('edition', trimmed(bib.edition) === undefined ? undefined : escape(trimmed(bib.edition) as string));
  if (biblatex) put('version', trimmed(bib.versionLabel) === undefined ? undefined : escape(trimmed(bib.versionLabel) as string));
  else report.addIfPresent(index, 'versionLabel', 'classic BibTeX has no version field', bib.versionLabel, key);

  /* Publication --------------------------------------------------------------------------- */
  const publisher = trimmed(bib.publisher);
  if (publisher !== undefined) {
    if (THESIS_LIKE.has(entryType)) put('school', escape(publisher));
    else if (REPORT_LIKE.has(entryType)) put('institution', escape(publisher));
    else put('publisher', escape(publisher));
  }
  const place = trimmed(bib.publisherPlace);
  put(biblatex ? 'location' : 'address', place === undefined ? undefined : escape(place));

  if (record.itemType === 'thesis') put('type', 'phdthesis');
  if (record.itemType === 'standard' && biblatex) put('type', 'standard');

  /* Dates ---------------------------------------------------------------------------------- */
  const issued = parseEdtf(bib.issuedDate);
  if (biblatex) {
    const date = issued === undefined ? undefined : formatEdtf(issued);
    if (date !== undefined) put('date', date);
    else if (typeof bib.issuedYear === 'number') put('date', String(bib.issuedYear));
  } else {
    const year = issued?.start?.year ?? (typeof bib.issuedYear === 'number' ? bib.issuedYear : undefined);
    put('year', year === undefined ? undefined : String(year));
    const month = bibtexMonth(issued?.start?.month ?? (typeof bib.issuedMonth === 'number' ? bib.issuedMonth : undefined));
    put('month', month, true);
    if (issued?.start?.day !== undefined) {
      report.add(index, 'issuedDate', 'classic BibTeX has no day-level date field', bib.issuedDate, key);
    }
    if (issued?.end !== undefined || issued?.openStart === true || issued?.openEnd === true) {
      report.add(index, 'issuedDate', 'classic BibTeX cannot express a date range', bib.issuedDate, key);
    }
    if (issued?.circa === true) {
      report.add(index, 'issuedDate', 'classic BibTeX cannot express an approximate date', bib.issuedDate, key);
    }
  }
  const accessed = trimmed(bib.accessedAt);
  if (accessed !== undefined) {
    put('urldate', accessed.slice(0, 10));
    if (!accessed.endsWith('T00:00:00.000Z')) {
      report.add(index, 'accessedAt', '`urldate` is a calendar date; the time of day is dropped', accessed, key);
    }
  }

  /* Identifiers ---------------------------------------------------------------------------- */
  put('doi', trimmed(bib.doi));
  put('isbn', trimmed(bib.isbn));
  put('issn', trimmed(bib.issn) ?? trimmed(bib.eissn));
  if (trimmed(bib.issn) !== undefined && trimmed(bib.eissn) !== undefined) {
    report.add(index, 'eissn', 'BibTeX has one `issn` field, taken by the print ISSN', bib.eissn, key);
  }
  const arxiv = trimmed(bib.arxivId);
  if (arxiv !== undefined) {
    put('eprint', arxiv);
    if (biblatex) put('eprinttype', 'arxiv');
    else put('archiveprefix', 'arXiv');
  }
  put('pmid', trimmed(bib.pmid));
  put('pmcid', trimmed(bib.pmcid));
  put('url', trimmed(bib.url) ?? trimmed(bib.oaUrl));
  if (trimmed(bib.url) !== undefined && trimmed(bib.oaUrl) !== undefined) {
    report.add(index, 'oaUrl', 'BibTeX has one `url` field, taken by the canonical URL', bib.oaUrl, key);
  }

  /* Text ------------------------------------------------------------------------------------ */
  put('abstract', trimmed(bib.abstract) === undefined ? undefined : escape(trimmed(bib.abstract) as string));
  const keywords = (record.keywords ?? []).map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0);
  put('keywords', keywords.length === 0 ? undefined : escape(keywords.join(', ')));
  const language = trimmed(bib.languageCode);
  put(biblatex ? 'langid' : 'language', language === undefined ? undefined : escape(language));
  put('note', trimmed(record.extra) === undefined ? undefined : escape(trimmed(record.extra) as string));

  const notes = (record.notes ?? []).map((note) => note.trim()).filter((note) => note.length > 0);
  if (notes.length > 0) {
    if (biblatex) put('annotation', escape(notes.join('\n\n')));
    else report.add(index, 'notes', 'classic BibTeX has one free-text field, taken by `note`', notes.length, key);
  }

  /* Attachments ----------------------------------------------------------------------------- */
  if (options.includeFiles !== false) {
    const files = fileEntries(record);
    put('file', files.length === 0 ? undefined : formatFileField(files));
    for (const attachment of record.attachments ?? []) {
      if (trimmed(attachment.role) !== undefined && trimmed(attachment.role) !== 'primary') {
        report.add(index, 'attachments.role', 'the `file` field carries a path, a title and a MIME type, and no role', attachment.role, key);
      }
    }
  } else if ((record.attachments ?? []).length > 0) {
    report.add(index, 'attachments', 'file fields were switched off for this export', (record.attachments ?? []).length, key);
  }

  /* Everything with no home ----------------------------------------------------------------- */
  const bibRecord = bib as Record<string, unknown>;
  for (const [field, reason] of UNREPRESENTABLE) {
    report.addIfPresent(index, field, reason, bibRecord[field], key);
  }
  if (bib.isPreprint === true && record.itemType !== 'preprint') {
    report.add(index, 'isPreprint', 'no field for the preprint flag', 'true', key);
  }

  /* Render ---------------------------------------------------------------------------------- */
  const indent = options.indent ?? '  ';
  const lines = orderFields([...fields.keys()]).map((name) => {
    const field = fields.get(name) as FieldValue;
    return field.bare === true ? `${indent}${name} = ${field.value},` : `${indent}${name} = {${field.value}},`;
  });
  return [`@${entryType}{${key},`, ...lines, '}'].join('\n');
};

const resolveKeys = (
  records: readonly FormatRecord[],
  options: BibtexExportOptions,
): readonly string[] => {
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

/** Serialise records to a `.bib` file in the requested dialect. */
export const exportBibtexDialect = (
  records: readonly FormatRecord[],
  options: BibtexExportOptions = {},
): ExportResult => {
  const dialect = options.dialect ?? 'bibtex';
  const report = new LossReport('export', dialect);
  const keys = resolveKeys(records, options);
  const entries = records.map((record, index) =>
    buildEntry(record, index, keys[index] as string, dialect, options, report),
  );
  return { text: entries.length === 0 ? '' : `${entries.join('\n\n')}\n`, losses: report.entries };
};

/** Classic BibTeX: 7-bit accents, `year`/`month`, fourteen entry types. */
export const exportBibtex = (
  records: readonly FormatRecord[],
  options: Omit<BibtexExportOptions, 'dialect'> = {},
): ExportResult => exportBibtexDialect(records, { ...options, dialect: 'bibtex' });

/** BibLaTeX: UTF-8 throughout, ISO-8601 `date`, the wider entry-type vocabulary. */
export const exportBiblatex = (
  records: readonly FormatRecord[],
  options: Omit<BibtexExportOptions, 'dialect'> = {},
): ExportResult => exportBibtexDialect(records, { ...options, dialect: 'biblatex' });
