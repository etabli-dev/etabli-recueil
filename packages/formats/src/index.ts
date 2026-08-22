/**
 * `@recueil/formats` — citation keys and bibliographic serialisation.
 *
 * Four formats, in both directions, as pure functions over `@recueil/schemas`. There is no
 * dependency on `@recueil/core`, and that is a design constraint rather than an accident: a
 * citation key and a `.bib` entry are functions of the contract, so the API, the CLI, the MCP
 * server and the Zotero importer can all call the same code without one of them having to open a
 * database first.
 *
 * The two halves are:
 *
 * - **Keys** (ADR-0016). `generateKey` for one record, `disambiguate` for a batch. Pinned keys are
 *   returned untouched by both; suffixes are assigned in creation order and never renumbered.
 * - **Serialisation** (CONCEPT.md §5.11, §6). `exportBibtex`, `exportBiblatex`, `exportRis` and
 *   `exportCslJson`, each mirrored by an importer, each returning a loss report for what the format
 *   could not carry. `FORMAT_LIMITATIONS` documents the same thing up front.
 */

/* The record shape everything here works over ------------------------------------------------ */
export type {
  FormatAttachment,
  FormatBibliographic,
  FormatCreator,
  FormatCreatorRole,
  FormatItemType,
  FormatNameVariant,
  FormatRecord,
} from './record.js';
export { creatorFamily, creatorsWithRole, isOrganisation, recordFromItem, recordTitle, trimmed } from './record.js';

/* Loss reporting ------------------------------------------------------------------------------ */
export { FORMAT_NAMES, LossReport, renderLossValue } from './loss.js';
export type { ExportResult, FormatName, ImportResult, LossEntry } from './loss.js';
export { FORMAT_LIMITATIONS, limitationFor } from './limitations.js';
export type { Limitation } from './limitations.js';

/* Dates --------------------------------------------------------------------------------------- */
export {
  BIBTEX_MONTHS,
  bibtexMonth,
  formatEdtf,
  formatEdtfPoint,
  fromDateParts,
  issuedYear,
  parseBibtexMonth,
  parseEdtf,
  parseRisDate,
  risDate,
  toDateParts,
} from './dates.js';
export type { DateParts, ParsedDate } from './dates.js';

/* Identifiers --------------------------------------------------------------------------------- */
export {
  normaliseArxivId,
  normaliseDoi,
  normaliseIsbn,
  normaliseIssn,
  normaliseLanguageTag,
  normalisePmcid,
  normalisePmid,
  normaliseUrl,
} from './identifiers.js';
export type { Normalised } from './identifiers.js';

/* Text ---------------------------------------------------------------------------------------- */
export {
  collapseWhitespace,
  escapeLatex,
  needsBraceProtection,
  protectCapitals,
  residualMacros,
  unescapeLatex,
} from './text/latex.js';
export type { EscapeOptions } from './text/latex.js';
export { isLatinScript, transliterate, transliterateWords } from './text/transliterate.js';
export type { TransliterateOptions } from './text/transliterate.js';

/* Names --------------------------------------------------------------------------------------- */
export {
  creatorFromNameParts,
  formatBibtexName,
  formatCslName,
  formatRisName,
  parseBibtexName,
  parseCslName,
  parseRisName,
  splitBibtexNameList,
} from './names.js';
export type { CslName, NameParts } from './names.js';

/* Citation keys (ADR-0016) --------------------------------------------------------------------- */
export {
  ANONYMOUS_AUTH,
  DEFAULT_CITATION_KEY_FORMULA,
  assignmentsById,
  base26Suffix,
  disambiguate,
  generateKey,
  pinnedKey,
} from './keys/generate.js';
export type { DisambiguateOptions, GenerateKeyOptions, KeyAssignment } from './keys/generate.js';
export { DEFAULT_SKIP_WORDS, skipWordSet } from './keys/skip-words.js';
export { KEY_FUNCTIONS, KEY_MODIFIERS, PatternError, isValidPattern, parsePattern } from './keys/pattern.js';
export type { CitationKeyPattern, KeyFunction, KeyModifier, ParsedModifier, ParsedTerm } from './keys/pattern.js';

/* Item-type mapping ----------------------------------------------------------------------------- */
export {
  BIBLATEX_ENTRY_TYPES,
  BIBTEX_ENTRY_TYPES,
  BIBTEX_FALLBACK_ENTRY_TYPE,
  BIBTEX_TYPES_REVERSED,
  CSL_FALLBACK_TYPE,
  CSL_TYPES,
  CSL_TYPES_REVERSED,
  RIS_FALLBACK_TYPE,
  RIS_TYPES,
  RIS_TYPES_REVERSED,
  mapItemType,
} from './mapping/types.js';

/* BibTeX and BibLaTeX ---------------------------------------------------------------------------- */
export { exportBibtex, exportBibtexDialect, exportBiblatex } from './bibtex/export.js';
export type { BibtexDialect, BibtexExportOptions } from './bibtex/export.js';
export { importBibtex, importBiblatex } from './bibtex/import.js';
export type { BibtexImportOptions } from './bibtex/import.js';
export { parseBibtexFile, resolveCrossReferences } from './bibtex/parse.js';
export type { RawBibEntry, RawBibFile } from './bibtex/parse.js';
export { BIBTEX_FIELD_ORDER, formatFileField, orderFields, parseFileField } from './bibtex/fields.js';
export type { FileFieldEntry } from './bibtex/fields.js';

/* RIS --------------------------------------------------------------------------------------------- */
export { RIS_TAG_ORDER, exportRis } from './ris/export.js';
export type { RisExportOptions } from './ris/export.js';
export { importRis, parseRisFile } from './ris/import.js';
export type { RawRisRecord } from './ris/import.js';

/* CSL-JSON ------------------------------------------------------------------------------------------ */
export { cslDateToEdtf, exportCslJson, toCslDate } from './csl/export.js';
export type { CslExportOptions, CslExportResult } from './csl/export.js';
export { importCslJson } from './csl/import.js';
export { CSL_VARIABLE_ORDER } from './csl/types.js';
export type { CslDate, CslItem } from './csl/types.js';
