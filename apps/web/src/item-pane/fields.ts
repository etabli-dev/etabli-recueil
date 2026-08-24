/**
 * Which bibliographic fields the item pane shows, in what order, and how each is edited.
 *
 * The facet in `@recueil/schemas` has some seventy fields, most of which a resolver writes and
 * nobody reads. This table is the editorial decision about the ones a person actually types, and it
 * is data so that the same list drives the pane, the tab order and the "jump to field" commands.
 *
 * Every `path` here is a key of `BibliographicFacetUpdate`, which is what makes a patch built from
 * this table type-check against the contract rather than merely look right.
 */
import type { BibliographicFacetUpdate } from '@recueil/schemas';

export type BibliographicFieldPath = keyof BibliographicFacetUpdate;

export type FieldKind = 'text' | 'longText' | 'number';

/**
 * One editable field, whichever facet it belongs to.
 *
 * `FieldRow` renders this rather than the bibliographic descriptor, because the office facet
 * (§5.2, `spec/data-model.md` §3.7) needs exactly the same row — a labelled input, its provenance
 * and its lock — and a second copy of that component would be a second place for the lock wording
 * to drift.
 */
export interface FieldDescriptor {
  /** A key of the facet's `Update` type. Also the `data-field` attribute and the lock's path. */
  path: string;
  label: string;
  group: string;
  kind: FieldKind;
  /** Shown under the input when the field's format is not obvious. */
  hint?: string;
}

export interface BibliographicFieldDescriptor extends FieldDescriptor {
  path: BibliographicFieldPath;
}

export const BIBLIOGRAPHIC_FIELDS: readonly BibliographicFieldDescriptor[] = [
  { path: 'title', label: 'Title', group: 'Work', kind: 'text' },
  { path: 'subtitle', label: 'Subtitle', group: 'Work', kind: 'text' },
  {
    path: 'shortTitle',
    label: 'Short title',
    group: 'Work',
    kind: 'text',
    hint: 'Feeds the citation-key formula (ADR-0016).',
  },
  { path: 'abstract', label: 'Abstract', group: 'Work', kind: 'longText' },
  { path: 'languageCode', label: 'Language', group: 'Work', kind: 'text', hint: 'A BCP-47 tag, such as en-GB.' },

  { path: 'containerTitle', label: 'Publication', group: 'Publication', kind: 'text', hint: 'Journal, book or proceedings.' },
  { path: 'containerShort', label: 'Abbreviation', group: 'Publication', kind: 'text', hint: 'The ISO-4 short form.' },
  { path: 'publisher', label: 'Publisher', group: 'Publication', kind: 'text' },
  { path: 'publisherPlace', label: 'Place', group: 'Publication', kind: 'text' },
  { path: 'volume', label: 'Volume', group: 'Publication', kind: 'text', hint: 'Text, not a number: volumes are 12, 12A, II.' },
  { path: 'issue', label: 'Issue', group: 'Publication', kind: 'text' },
  { path: 'pages', label: 'Pages', group: 'Publication', kind: 'text', hint: 'The range as printed.' },
  {
    path: 'issuedDate',
    label: 'Issued',
    group: 'Publication',
    kind: 'text',
    hint: 'EDTF: 2019, 2019-04 or 2019-04-01. A year on its own is normal.',
  },
  { path: 'issuedYear', label: 'Year', group: 'Publication', kind: 'number' },

  {
    path: 'doi',
    label: 'DOI',
    group: 'Identifiers',
    kind: 'text',
    hint: 'Lower case, without the https://doi.org/ prefix (invariant B1).',
  },
  { path: 'pmid', label: 'PMID', group: 'Identifiers', kind: 'text' },
  { path: 'pmcid', label: 'PMCID', group: 'Identifiers', kind: 'text', hint: 'Keeps the PMC prefix.' },
  { path: 'arxivId', label: 'arXiv', group: 'Identifiers', kind: 'text' },
  { path: 'isbn', label: 'ISBN', group: 'Identifiers', kind: 'text', hint: 'ISBN-13, hyphenless.' },
  { path: 'issn', label: 'ISSN', group: 'Identifiers', kind: 'text' },
  { path: 'openalexId', label: 'OpenAlex', group: 'Identifiers', kind: 'text' },
  { path: 'url', label: 'URL', group: 'Identifiers', kind: 'text' },
  {
    path: 'citationKey',
    label: 'Citation key',
    group: 'Identifiers',
    kind: 'text',
    hint: 'Exported to BibTeX. Pin it and a regeneration will not move it (ADR-0016).',
  },

  { path: 'licence', label: 'Licence', group: 'Access', kind: 'text', hint: 'An SPDX identifier or a licence URL.' },
  { path: 'oaUrl', label: 'Open-access URL', group: 'Access', kind: 'text' },
];

/** The descriptors grouped for rendering, in table order, without a second pass over the list. */
export const bibliographicFieldGroups = (): { group: string; fields: BibliographicFieldDescriptor[] }[] => {
  const groups: { group: string; fields: BibliographicFieldDescriptor[] }[] = [];
  for (const field of BIBLIOGRAPHIC_FIELDS) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.group === field.group) last.fields.push(field);
    else groups.push({ group: field.group, fields: [field] });
  }
  return groups;
};

/**
 * The value as an input shows it.
 *
 * `null` and `undefined` are both "no value" on the wire, and both are the empty string in an
 * input; booleans are not edited through this path.
 */
export const toInputValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return '';
};

/**
 * The value as a patch carries it.
 *
 * An emptied field is `null`, not `''`: the contract's nullable fields mean "no value" by `null`,
 * and an empty string would be a value that is the empty string. A number field that has been
 * emptied is `null` too, and a number field with something unparseable in it is refused here rather
 * than sent for the server to reject.
 */
export const toPatchValue = (
  kind: FieldKind,
  raw: string,
): { ok: true; value: string | number | null } | { ok: false; message: string } => {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (kind !== 'number') return { ok: true, value: trimmed };

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { ok: false, message: 'must be a whole number' };
  }
  return { ok: true, value: parsed };
};
