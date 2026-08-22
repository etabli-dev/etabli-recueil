/**
 * What each format cannot represent.
 *
 * A structured version of the table in `README.md`, exported as data so that a UI can show it
 * before an export runs and a test can assert that the exporters actually report what this claims
 * they will. Keeping it as data rather than prose is the only way the two stay in step: a field
 * added to the contract with no home in a format has to be added here, and `test/limitations.test.ts`
 * fails until it is.
 */
import type { FormatName } from './loss.js';

/** One thing a format cannot hold, and what the exporter does instead. */
export interface Limitation {
  /** The contract field, or a dotted path into it. */
  readonly field: string;
  /** What happens on export: `dropped`, `merged` into another field, or `approximated`. */
  readonly disposition: 'dropped' | 'merged' | 'approximated';
  readonly note: string;
  /**
   * `false` when no exporter can report the loss because the field never reaches one: the
   * projection in `record.ts` drops it on the way from `Item` to `FormatRecord`. Everything else
   * produces a loss entry naming this field, which `test/limitations.test.ts` asserts one by one.
   */
  readonly reportable?: boolean;
}

const IDENTIFIER_LIMITS: readonly Limitation[] = [
  { field: 'openalexId', disposition: 'dropped', note: 'no format has an OpenAlex variable' },
  { field: 'semanticScholarId', disposition: 'dropped', note: 'no format has a Semantic Scholar variable' },
  { field: 'issnL', disposition: 'dropped', note: 'the linking ISSN has no separate spelling anywhere' },
  { field: 'dataciteDoi', disposition: 'dropped', note: 'every format has one DOI field' },
  { field: 'handle', disposition: 'dropped', note: 'no format has a Handle field' },
];

const CHECK_LIMITS: readonly Limitation[] = [
  { field: 'oaStatus', disposition: 'dropped', note: 'open-access status is a check result, not bibliographic data' },
  { field: 'oaUrl', disposition: 'merged', note: 'one URL field: the open-access URL is written only when there is no canonical one' },
  { field: 'publishedVersionDoi', disposition: 'dropped', note: 'the preprint/version relation has no field' },
  { field: 'retractionNoticeDoi', disposition: 'dropped', note: 'retraction status has no field' },
  { field: 'verificationStatus', disposition: 'dropped', note: 'a check result, not bibliographic data', reportable: false },
  { field: 'provenance', disposition: 'dropped', note: 'per-field provenance (P4) has no expression in any format', reportable: false },
  { field: 'lockedFields', disposition: 'dropped', note: 'the manual lock is library state', reportable: false },
  { field: 'citationKeyFormula', disposition: 'dropped', note: 'the formula is library state' },
];

/** The limitations of each format, in the order a reader should meet them. */
export const FORMAT_LIMITATIONS: Readonly<Record<FormatName, readonly Limitation[]>> = {
  bibtex: [
    { field: 'itemType', disposition: 'approximated', note: 'nine of the twenty built-in item types collapse to @misc' },
    { field: 'subtitle', disposition: 'merged', note: 'appended to the title after a colon; not recoverable' },
    { field: 'issuedDate', disposition: 'approximated', note: '`year` and a `month` macro: no day, no range, no approximation' },
    { field: 'availableDate', disposition: 'dropped', note: 'no online-first date field' },
    { field: 'collectionNumber', disposition: 'dropped', note: 'on an @article, `number` is the issue' },
    { field: 'versionLabel', disposition: 'dropped', note: 'no version field; BibLaTeX has one' },
    { field: 'licence', disposition: 'dropped', note: 'no standard licence field' },
    { field: 'eissn', disposition: 'merged', note: 'one `issn` field: the electronic ISSN is written only when there is no print one' },
    { field: 'cslType', disposition: 'dropped', note: 'no CSL type override' },
    { field: 'creators.translator', disposition: 'dropped', note: 'classic BibTeX has author and editor only' },
    { field: 'creators.other', disposition: 'dropped', note: 'no field for a recipient, interviewer or director' },
    { field: 'notes', disposition: 'dropped', note: 'one free-text field, taken by `note` = Extra' },
    { field: 'attachments.role', disposition: 'dropped', note: 'the `file` field carries title, path and MIME type only' },
    { field: 'accessedAt', disposition: 'approximated', note: '`urldate` is a calendar date; the time of day goes' },
    ...IDENTIFIER_LIMITS,
    ...CHECK_LIMITS,
  ],
  biblatex: [
    { field: 'itemType', disposition: 'approximated', note: 'the office types and `preprint` collapse to @misc' },
    { field: 'availableDate', disposition: 'dropped', note: 'no online-first date field' },
    { field: 'collectionNumber', disposition: 'dropped', note: 'on an @article, `number` is the issue' },
    { field: 'licence', disposition: 'dropped', note: 'no standard licence field' },
    { field: 'eissn', disposition: 'merged', note: 'one `issn` field: the electronic ISSN is written only when there is no print one' },
    { field: 'cslType', disposition: 'dropped', note: 'no CSL type override' },
    { field: 'creators.other', disposition: 'dropped', note: 'author, editor and translator only' },
    { field: 'attachments.role', disposition: 'dropped', note: 'the `file` field carries title, path and MIME type only' },
    { field: 'accessedAt', disposition: 'approximated', note: '`urldate` is a calendar date; the time of day goes' },
    ...IDENTIFIER_LIMITS,
    ...CHECK_LIMITS,
  ],
  ris: [
    { field: 'itemType', disposition: 'approximated', note: 'the office types collapse to `GEN`' },
    { field: 'subtitle', disposition: 'merged', note: 'appended to `TI` after a colon; not recoverable' },
    { field: 'issuedDate', disposition: 'approximated', note: '`PY` and `DA`: no range, no approximation' },
    { field: 'availableDate', disposition: 'dropped', note: 'no online-first tag' },
    { field: 'pmid', disposition: 'dropped', note: 'not in the standard tag set' },
    { field: 'pmcid', disposition: 'dropped', note: 'not in the standard tag set' },
    { field: 'arxivId', disposition: 'dropped', note: 'not in the standard tag set' },
    { field: 'isbn', disposition: 'merged', note: '`SN` is shared with the ISSN, which takes precedence' },
    { field: 'eissn', disposition: 'merged', note: 'one `SN` tag: written only when there is no print ISSN' },
    { field: 'collectionNumber', disposition: 'dropped', note: '`IS` is the issue' },
    { field: 'numberOfPages', disposition: 'dropped', note: 'RIS pages are `SP`/`EP`' },
    { field: 'versionLabel', disposition: 'dropped', note: 'no version tag' },
    { field: 'licence', disposition: 'dropped', note: 'no licence tag' },
    { field: 'cslType', disposition: 'dropped', note: 'no CSL type override' },
    { field: 'creators.other', disposition: 'dropped', note: '`AU`, `A2` and `A4` only' },
    { field: 'creators.namePrefix', disposition: 'merged', note: 'no particle field; `van` joins the family name' },
    { field: 'notes', disposition: 'merged', note: 'notes and Extra share `N1` and cannot be told apart again' },
    { field: 'attachments.title', disposition: 'dropped', note: '`L1` is a path and nothing else' },
    { field: 'accessedAt', disposition: 'approximated', note: '`Y2` is a calendar date; the time of day goes' },
    ...IDENTIFIER_LIMITS,
    ...CHECK_LIMITS,
  ],
  'csl-json': [
    { field: 'subtitle', disposition: 'merged', note: 'appended to the title after a colon; not recoverable' },
    { field: 'issuedDate', disposition: 'approximated', note: '`date-parts` has no open-ended interval' },
    { field: 'arxivId', disposition: 'dropped', note: 'CSL has no arXiv variable' },
    { field: 'eissn', disposition: 'merged', note: 'one ISSN variable: written only when there is no print ISSN' },
    { field: 'licence', disposition: 'dropped', note: 'CSL 1.0.2 has no licence variable' },
    { field: 'creators.other', disposition: 'dropped', note: 'author, editor and translator are mapped' },
    { field: 'notes', disposition: 'dropped', note: 'one `note` variable, taken by Extra' },
    { field: 'attachments', disposition: 'dropped', note: 'CSL-JSON is citation-processor input; it has no file variable' },
    { field: 'accessedAt', disposition: 'approximated', note: '`accessed` is a calendar date; the time of day goes' },
    ...IDENTIFIER_LIMITS,
    ...CHECK_LIMITS,
  ],
};

/** The limitation for one field of one format, if there is one. */
export const limitationFor = (format: FormatName, field: string): Limitation | undefined =>
  FORMAT_LIMITATIONS[format].find((limitation) => limitation.field === field);
