/**
 * RIS export.
 *
 * RIS is the oldest and least expressive of the four, and the one every database's "export
 * citation" button still emits. Its grammar is two-letter tags, two spaces, a hyphen, a space, and
 * a value; a record starts with `TY` and ends with `ER`. There is no escaping, no nesting and no
 * agreed extension mechanism, which is why this exporter stays inside the standard tag set and
 * reports everything else rather than inventing a tag that only Recueil would understand.
 */
import { risDate, parseEdtf } from '../dates.js';
import { LossReport } from '../loss.js';
import type { ExportResult } from '../loss.js';
import { formatRisName } from '../names.js';
import { creatorsWithRole, recordTitle, trimmed } from '../record.js';
import type { FormatRecord } from '../record.js';
import { disambiguate } from '../keys/generate.js';
import type { GenerateKeyOptions } from '../keys/generate.js';
import { RIS_FALLBACK_TYPE, RIS_TYPES } from '../mapping/types.js';

export interface RisExportOptions {
  readonly keys?: ReadonlyMap<string, string> | undefined;
  readonly keyOptions?: GenerateKeyOptions | undefined;
  /** Emit `L1` tags for attachments. Default `true`. */
  readonly includeFiles?: boolean | undefined;
  /** Line ending. RIS is a DOS-era format and `\r\n` is what most readers expect; default `\r\n`. */
  readonly newline?: '\n' | '\r\n' | undefined;
}

/** Emission order. `TY` is first and `ER` is last by the specification; the rest is for diffs. */
export const RIS_TAG_ORDER: readonly string[] = [
  'TY', 'ID', 'AU', 'A2', 'A4', 'TI', 'ST', 'T2', 'J2', 'T3', 'VL', 'IS', 'SP', 'EP',
  'ET', 'PB', 'CY', 'PY', 'DA', 'Y2', 'SN', 'DO', 'UR', 'AB', 'KW', 'LA', 'N1', 'L1', 'ER',
];

const ORDER_INDEX: ReadonlyMap<string, number> = new Map(RIS_TAG_ORDER.map((tag, index) => [tag, index]));

/** Fields the contract holds that the standard RIS tag set has nowhere to put. */
const UNREPRESENTABLE: readonly (readonly [string, string])[] = [
  ['pmid', 'the standard tag set has no PMID tag'],
  ['pmcid', 'the standard tag set has no PMCID tag'],
  ['arxivId', 'the standard tag set has no arXiv tag'],
  ['openalexId', 'no tag for an OpenAlex work id'],
  ['semanticScholarId', 'no tag for a Semantic Scholar paper id'],
  ['issnL', 'RIS has one `SN` tag, shared by ISSN and ISBN'],
  ['dataciteDoi', 'one `DO` tag only'],
  ['handle', 'no tag for a Handle'],
  ['availableDate', 'no tag for the online-first date'],
  ['oaStatus', 'no tag for open-access status'],
  ['publishedVersionDoi', 'no tag for the published version of a preprint'],
  ['retractionNoticeDoi', 'no tag for a retraction notice'],
  ['licence', 'no tag for a licence'],
  ['numberOfPages', 'RIS pages are `SP`/`EP`, not a total'],
  ['cslType', 'no tag for a CSL type override'],
  ['citationKeyFormula', 'the formula is library state, not bibliographic data'],
  ['collectionNumber', 'the series number shares `IS` with the issue, which takes precedence'],
];

interface Tag {
  readonly tag: string;
  readonly value: string;
}

const buildTags = (
  record: FormatRecord,
  index: number,
  key: string,
  options: RisExportOptions,
  report: LossReport,
): Tag[] => {
  const bib = record.bibliographic ?? {};
  const tags: Tag[] = [];
  const put = (tag: string, value: string | undefined): void => {
    const text = trimmed(value);
    if (text === undefined) return;
    tags.push({ tag, value: text.replace(/\r?\n/gu, ' ') });
  };

  const mapped = RIS_TYPES[record.itemType];
  if (mapped === undefined) {
    report.add(index, 'itemType', 'no RIS reference type for this item type; exported as GEN', record.itemType, key);
  } else if (mapped === RIS_FALLBACK_TYPE && record.itemType !== 'note' && record.itemType !== 'attachment_only') {
    report.add(index, 'itemType', 'RIS has no reference type for this item type; it collapses to GEN', record.itemType, key);
  }
  put('TY', mapped ?? RIS_FALLBACK_TYPE);
  put('ID', key);

  for (const creator of creatorsWithRole(record, 'author')) put('AU', formatRisName(creator));
  for (const creator of creatorsWithRole(record, 'editor')) put('A2', formatRisName(creator));
  for (const creator of creatorsWithRole(record, 'translator')) put('A4', formatRisName(creator));
  for (const creator of record.creators ?? []) {
    if (creator.role !== 'author' && creator.role !== 'editor' && creator.role !== 'translator') {
      report.add(index, `creators.${creator.role}`, 'RIS has tags for authors, editors and translators only', creator.familyName ?? creator.literalName, key);
    }
    if (trimmed(creator.namePrefix) !== undefined) {
      report.add(index, 'creators.namePrefix', 'RIS has no particle field; the particle is folded into the family name and cannot be split apart again', creator.namePrefix, key);
    }
  }

  const title = recordTitle(record);
  const subtitle = trimmed(bib.subtitle);
  put('TI', subtitle === undefined ? title : `${title ?? ''}: ${subtitle}`);
  if (subtitle !== undefined) {
    report.add(index, 'subtitle', 'RIS has one title tag; the subtitle is appended after a colon and cannot be split apart again', subtitle, key);
  }
  put('ST', trimmed(bib.shortTitle));
  put('T2', trimmed(bib.containerTitle));
  put('J2', trimmed(bib.containerShort));
  put('T3', trimmed(bib.collectionTitle));
  put('VL', trimmed(bib.volume));
  put('IS', trimmed(bib.issue));

  const pages = trimmed(bib.pages);
  const range = pages === undefined ? null : /^\s*(\S+?)\s*(?:--|–|-)\s*(\S+?)\s*$/u.exec(pages);
  if (range !== null) {
    put('SP', range[1]);
    put('EP', range[2]);
  } else if (typeof bib.pageFirst === 'number') {
    put('SP', String(bib.pageFirst));
    if (typeof bib.pageLast === 'number') put('EP', String(bib.pageLast));
  } else if (pages !== undefined) {
    put('SP', pages);
  }

  put('ET', trimmed(bib.edition));
  put('PB', trimmed(bib.publisher));
  put('CY', trimmed(bib.publisherPlace));

  const issued = parseEdtf(bib.issuedDate);
  const year = issued?.start?.year ?? (typeof bib.issuedYear === 'number' ? bib.issuedYear : undefined);
  put('PY', year === undefined ? undefined : String(year));
  if (issued?.start !== undefined && (issued.start.month !== undefined || issued.start.day !== undefined)) {
    put('DA', risDate(issued.start));
  }
  if (issued?.end !== undefined || issued?.openStart === true || issued?.openEnd === true) {
    report.add(index, 'issuedDate', 'RIS cannot express a date range', bib.issuedDate, key);
  }
  if (issued?.circa === true) {
    report.add(index, 'issuedDate', 'RIS cannot express an approximate date', bib.issuedDate, key);
  }
  const accessed = trimmed(bib.accessedAt);
  if (accessed !== undefined) {
    put('Y2', `${accessed.slice(0, 4)}/${accessed.slice(5, 7)}/${accessed.slice(8, 10)}/`);
    if (!accessed.endsWith('T00:00:00.000Z')) {
      report.add(index, 'accessedAt', '`Y2` is a calendar date; the time of day is dropped', accessed, key);
    }
  }

  const issn = trimmed(bib.issn) ?? trimmed(bib.eissn);
  put('SN', issn ?? trimmed(bib.isbn));
  if (issn !== undefined && trimmed(bib.isbn) !== undefined) {
    report.add(index, 'isbn', 'RIS has one `SN` tag and the ISSN took it', bib.isbn, key);
  }
  if (trimmed(bib.issn) !== undefined && trimmed(bib.eissn) !== undefined) {
    report.add(index, 'eissn', 'RIS has one `SN` tag, taken by the print ISSN', bib.eissn, key);
  }
  put('DO', trimmed(bib.doi));
  put('UR', trimmed(bib.url) ?? trimmed(bib.oaUrl));
  if (trimmed(bib.url) !== undefined && trimmed(bib.oaUrl) !== undefined) {
    report.add(index, 'oaUrl', 'RIS has one `UR` tag, taken by the canonical URL', bib.oaUrl, key);
  }
  put('AB', trimmed(bib.abstract));
  for (const keyword of record.keywords ?? []) put('KW', keyword);
  put('LA', trimmed(bib.languageCode));

  const notes = (record.notes ?? []).map((note) => note.trim()).filter((note) => note.length > 0);
  put('N1', trimmed(record.extra));
  for (const note of notes) put('N1', note);
  if (notes.length > 0) {
    report.add(index, 'notes', 'RIS `N1` tags carry the notes and the Extra field together, and cannot be told apart on the way back', notes.length, key);
  }

  if (options.includeFiles !== false) {
    for (const attachment of record.attachments ?? []) {
      const path = trimmed(attachment.path);
      if (path !== undefined) put('L1', path);
      if (trimmed(attachment.title) !== undefined) {
        report.add(index, 'attachments.title', '`L1` carries a path and nothing else', attachment.title, key);
      }
    }
  }

  const bibRecord = bib as Record<string, unknown>;
  for (const [field, reason] of UNREPRESENTABLE) {
    report.addIfPresent(index, field, reason, bibRecord[field], key);
  }
  if (trimmed(bib.versionLabel) !== undefined) {
    report.add(index, 'versionLabel', 'no tag for a version label', bib.versionLabel, key);
  }

  tags.push({ tag: 'ER', value: '' });
  return tags;
};

const orderTags = (tags: readonly Tag[]): Tag[] =>
  [...tags]
    .map((tag, position) => ({ tag, position }))
    .sort((left, right) => {
      const leftIndex = ORDER_INDEX.get(left.tag.tag) ?? RIS_TAG_ORDER.length;
      const rightIndex = ORDER_INDEX.get(right.tag.tag) ?? RIS_TAG_ORDER.length;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      return left.position - right.position;
    })
    .map((entry) => entry.tag);

const resolveKeys = (records: readonly FormatRecord[], options: RisExportOptions): readonly string[] => {
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

/** Serialise records to RIS. */
export const exportRis = (records: readonly FormatRecord[], options: RisExportOptions = {}): ExportResult => {
  const report = new LossReport('export', 'ris');
  const newline = options.newline ?? '\r\n';
  const keys = resolveKeys(records, options);
  const blocks = records.map((record, index) =>
    orderTags(buildTags(record, index, keys[index] as string, options, report))
      .map((tag) => `${tag.tag}  - ${tag.value}`.trimEnd())
      .join(newline),
  );
  const text = blocks.length === 0 ? '' : `${blocks.join(`${newline}${newline}`)}${newline}`;
  return { text, losses: report.entries };
};
