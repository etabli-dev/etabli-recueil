/**
 * Item-type mapping, in both directions, for all four formats.
 *
 * Recueil's type vocabulary is open (`spec/data-model.md` §1.1): a plugin may register a type, so
 * every table here has a fallback rather than an exhaustive switch. The fallback is always the
 * format's own catch-all — `@misc`, `GEN`, `document` — and choosing it is a reportable loss, not a
 * silent substitution.
 *
 * The reverse tables are not the inverse of the forward ones, and cannot be: three Recueil types
 * collapse onto `@misc`, so `@misc` has to come back as something, and it comes back as the type
 * that most `@misc` entries in a real `.bib` file actually are.
 */
import type { FormatName } from '../loss.js';

/** Classic BibTeX's fourteen standard entry types. */
export const BIBTEX_ENTRY_TYPES: Readonly<Record<string, string>> = {
  article: 'article',
  book: 'book',
  chapter: 'incollection',
  report: 'techreport',
  thesis: 'phdthesis',
  dataset: 'misc',
  preprint: 'misc',
  webpage: 'misc',
  conference_paper: 'inproceedings',
  software: 'misc',
  standard: 'misc',
  patent: 'misc',
  invoice: 'misc',
  letter: 'misc',
  contract: 'misc',
  receipt: 'misc',
  certificate: 'misc',
  photo: 'misc',
  note: 'misc',
  attachment_only: 'misc',
};

/** BibLaTeX has a wider vocabulary, so fewer types collapse. */
export const BIBLATEX_ENTRY_TYPES: Readonly<Record<string, string>> = {
  article: 'article',
  book: 'book',
  chapter: 'incollection',
  report: 'report',
  thesis: 'thesis',
  dataset: 'dataset',
  preprint: 'misc',
  webpage: 'online',
  conference_paper: 'inproceedings',
  software: 'software',
  standard: 'report',
  patent: 'patent',
  invoice: 'misc',
  letter: 'misc',
  contract: 'misc',
  receipt: 'misc',
  certificate: 'misc',
  photo: 'misc',
  note: 'misc',
  attachment_only: 'misc',
};

export const BIBTEX_FALLBACK_ENTRY_TYPE = 'misc';

/** RIS reference types (`TY`). */
export const RIS_TYPES: Readonly<Record<string, string>> = {
  article: 'JOUR',
  book: 'BOOK',
  chapter: 'CHAP',
  report: 'RPRT',
  thesis: 'THES',
  dataset: 'DATA',
  preprint: 'UNPB',
  webpage: 'ELEC',
  conference_paper: 'CPAPER',
  software: 'COMP',
  standard: 'STAND',
  patent: 'PAT',
  invoice: 'GEN',
  letter: 'PCOMM',
  contract: 'GEN',
  receipt: 'GEN',
  certificate: 'GEN',
  photo: 'ART',
  note: 'GEN',
  attachment_only: 'GEN',
};

export const RIS_FALLBACK_TYPE = 'GEN';

/**
 * CSL 1.0.2 types.
 *
 * `preprint` is the awkward one: CSL 1.0.2 has no such type, so a preprint goes out as `article`
 * with `genre: preprint`, which is what a style needs in order to render "Preprint" and what
 * `csl/export.ts` writes. The alternative — `report` — loses the fact that it is an article.
 */
export const CSL_TYPES: Readonly<Record<string, string>> = {
  article: 'article-journal',
  book: 'book',
  chapter: 'chapter',
  report: 'report',
  thesis: 'thesis',
  dataset: 'dataset',
  preprint: 'article',
  webpage: 'webpage',
  conference_paper: 'paper-conference',
  software: 'software',
  standard: 'standard',
  patent: 'patent',
  invoice: 'document',
  letter: 'personal_communication',
  contract: 'document',
  receipt: 'document',
  certificate: 'document',
  photo: 'graphic',
  note: 'document',
  attachment_only: 'document',
};

export const CSL_FALLBACK_TYPE = 'document';

/** BibTeX entry type → Recueil item type. `@misc` lands on `webpage`'s neighbour, `report`. */
export const BIBTEX_TYPES_REVERSED: Readonly<Record<string, string>> = {
  article: 'article',
  book: 'book',
  mvbook: 'book',
  booklet: 'book',
  collection: 'book',
  mvcollection: 'book',
  proceedings: 'book',
  mvproceedings: 'book',
  periodical: 'article',
  reference: 'book',
  mvreference: 'book',
  inbook: 'chapter',
  bookinbook: 'chapter',
  incollection: 'chapter',
  suppcollection: 'chapter',
  inreference: 'chapter',
  suppbook: 'chapter',
  inproceedings: 'conference_paper',
  conference: 'conference_paper',
  techreport: 'report',
  report: 'report',
  manual: 'report',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  masterthesis: 'thesis',
  thesis: 'thesis',
  dataset: 'dataset',
  software: 'software',
  patent: 'patent',
  online: 'webpage',
  electronic: 'webpage',
  www: 'webpage',
  unpublished: 'preprint',
  misc: 'report',
};

export const RIS_TYPES_REVERSED: Readonly<Record<string, string>> = {
  JOUR: 'article',
  MGZN: 'article',
  NEWS: 'article',
  EJOUR: 'article',
  ABST: 'article',
  BOOK: 'book',
  EBOOK: 'book',
  EDBOOK: 'book',
  SER: 'book',
  CHAP: 'chapter',
  ECHAP: 'chapter',
  RPRT: 'report',
  GOVDOC: 'report',
  THES: 'thesis',
  DATA: 'dataset',
  UNPB: 'preprint',
  ELEC: 'webpage',
  ICOMM: 'webpage',
  BLOG: 'webpage',
  CPAPER: 'conference_paper',
  CONF: 'conference_paper',
  COMP: 'software',
  STAND: 'standard',
  PAT: 'patent',
  PCOMM: 'letter',
  ART: 'photo',
  FIGURE: 'photo',
  GEN: 'report',
};

export const CSL_TYPES_REVERSED: Readonly<Record<string, string>> = {
  'article-journal': 'article',
  'article-magazine': 'article',
  'article-newspaper': 'article',
  article: 'article',
  review: 'article',
  'review-book': 'article',
  book: 'book',
  classic: 'book',
  collection: 'book',
  periodical: 'book',
  chapter: 'chapter',
  entry: 'chapter',
  'entry-dictionary': 'chapter',
  'entry-encyclopedia': 'chapter',
  report: 'report',
  regulation: 'report',
  thesis: 'thesis',
  dataset: 'dataset',
  webpage: 'webpage',
  post: 'webpage',
  'post-weblog': 'webpage',
  'paper-conference': 'conference_paper',
  speech: 'conference_paper',
  software: 'software',
  standard: 'standard',
  patent: 'patent',
  personal_communication: 'letter',
  graphic: 'photo',
  figure: 'photo',
  manuscript: 'preprint',
  document: 'report',
};

/** The forward table for one format, with its fallback applied. */
export const mapItemType = (format: FormatName, itemType: string): { readonly type: string; readonly fallback: boolean } => {
  const table =
    format === 'bibtex'
      ? BIBTEX_ENTRY_TYPES
      : format === 'biblatex'
        ? BIBLATEX_ENTRY_TYPES
        : format === 'ris'
          ? RIS_TYPES
          : CSL_TYPES;
  const fallback =
    format === 'ris' ? RIS_FALLBACK_TYPE : format === 'csl-json' ? CSL_FALLBACK_TYPE : BIBTEX_FALLBACK_ENTRY_TYPE;
  const mapped = table[itemType];
  return mapped === undefined ? { type: fallback, fallback: true } : { type: mapped, fallback: false };
};
