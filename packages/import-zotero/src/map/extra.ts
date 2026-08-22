/**
 * Zotero's `Extra` field.
 *
 * `Extra` is free text that Zotero, Better BibTeX and a dozen translators all use as a place to put
 * things the schema has no field for, by the convention `Label: value` one per line. Two of those
 * matter to this importer — `Citation Key:` (the pre-Zotero-8 way of pinning a key) and the
 * identifiers `PMID:`, `PMCID:` and `arXiv:` that translators write there — and the rest matter
 * because they must survive.
 *
 * So: the whole field is written to `items.extra` verbatim (`spec/data-model.md` §3.4), and this
 * module only *reads* it. Nothing here rewrites the field, and a line this recognises is still
 * present in the stored text afterwards.
 */

export interface ExtraLine {
  label: string;
  value: string;
}

export interface ParsedExtra {
  /** Every `Label: value` line, in order, labels trimmed but not case-folded. */
  lines: ExtraLine[];
  /** `Citation Key: foo2019bar`, the convention Better BibTeX established before Zotero 8. */
  citationKey: string | null;
  pmid: string | null;
  pmcid: string | null;
  arxivId: string | null;
  doi: string | null;
  /** Lines that are not `Label: value` at all — kept for the record, never interpreted. */
  freeText: string[];
}

const LINE = /^\s*([A-Za-z][A-Za-z0-9 _.\-]*?)\s*:\s*(.+?)\s*$/u;

/** Read `Extra`. Never modifies it: `items.extra` keeps the original text (P10). */
export const parseExtra = (extra: string | null | undefined): ParsedExtra => {
  const result: ParsedExtra = {
    lines: [],
    citationKey: null,
    pmid: null,
    pmcid: null,
    arxivId: null,
    doi: null,
    freeText: [],
  };
  if (extra === null || extra === undefined) return result;

  for (const rawLine of extra.split(/\r?\n/u)) {
    if (rawLine.trim() === '') continue;
    const match = LINE.exec(rawLine);
    if (match === null) {
      result.freeText.push(rawLine.trim());
      continue;
    }
    const label = (match[1] as string).trim();
    const value = (match[2] as string).trim();
    result.lines.push({ label, value });

    switch (label.toLowerCase().replace(/\s+/gu, ' ')) {
      case 'citation key':
      case 'citationkey':
        result.citationKey ??= value;
        break;
      case 'pmid':
        result.pmid ??= value;
        break;
      case 'pmcid':
        result.pmcid ??= value;
        break;
      case 'arxiv':
      case 'arxivid':
        result.arxivId ??= value;
        break;
      case 'doi':
        result.doi ??= value;
        break;
      default:
        break;
    }
  }
  return result;
};
