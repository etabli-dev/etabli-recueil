/**
 * Zotero item fields onto the Recueil bibliographic facet (`spec/data-model.md` §3.5).
 *
 * The table below is keyed by Zotero's **base** field, not by the field as recorded, which is what
 * makes it short. Zotero's `baseFieldMappingsCombined` already says that a thesis's `university`,
 * a report's `institution`, a dataset's `repository` and a program's `company` are all the base
 * field `publisher`; the reader resolves through it, so there is one row here for `publisher`
 * rather than five, and a Zotero release that adds a sixth needs no change.
 *
 * Three rules run through everything here:
 *
 * - **Nothing is dropped.** A field with no column of its own goes to a `zotero_<field>` custom
 *   field, under its recorded name rather than its base name, so `reportNumber` stays
 *   `zotero_report_number` and is not flattened into `zotero_number`. That is what
 *   `custom_fields`/`field_values` are for (§4.6, open question O1: fields beyond the facet never
 *   become new columns).
 * - **An identifier the contract refuses is not written.** DOIs, ISBNs, ISSNs and the rest go
 *   through `@recueil/formats`, which normalises to invariant B1 or returns the reason it cannot.
 *   A refused value is reported *and* preserved in a custom field, never silently discarded and
 *   never written in a shape the API would reject.
 * - **`Extra` is verbatim.** The whole field lands in `items.extra` exactly as Zotero holds it.
 *   `src/map/extra.ts` only reads it.
 */
import type { BibliographicInput } from '@recueil/core';
import {
  normaliseArxivId,
  normaliseDoi,
  normaliseIsbn,
  normaliseIssn,
  normaliseLanguageTag,
  normalisePmcid,
  normalisePmid,
} from '@recueil/formats';
import type { Normalised } from '@recueil/formats';

import type { ZoteroFieldValue } from '../reader/types.js';
import { mapZoteroDate, mapZoteroTimestamp } from './dates.js';
import { slugify } from './item-types.js';

/** A Zotero field value that had to go somewhere other than a facet column. */
export interface CarriedField {
  /** The Zotero field as recorded, e.g. `reportNumber`. */
  zoteroField: string;
  /** The custom field it was written to, e.g. `zotero_report_number`. */
  fieldKey: string;
  /** The display label for the custom field definition. */
  label: string;
  value: string;
  /** Why it is here: no column exists, the column was taken, or the contract refused the value. */
  reason: 'no_column' | 'column_taken' | 'rejected';
  /** Set when `reason` is `rejected`. */
  detail?: string;
}

export interface MappedFields {
  bibliographic: BibliographicInput;
  /** `items.extra`, verbatim. */
  extra: string | null;
  /** Zotero's native `citationKey` field, if the library is Zotero 8 or newer. */
  nativeCitationKey: string | null;
  /** The item's title as Zotero holds it, for `items.title` and for attachment and note titles. */
  title: string | null;
  carried: CarriedField[];
}

/**
 * Base field to facet column, one to one.
 *
 * Ordered by how a bibliographic record is read rather than alphabetically, because that is how a
 * reader checks it against `spec/data-model.md` §3.5.
 */
const BASE_FIELD_COLUMNS: Readonly<Record<string, keyof BibliographicInput>> = {
  title: 'title',
  shortTitle: 'shortTitle',
  publicationTitle: 'containerTitle',
  journalAbbreviation: 'containerShort',
  series: 'collectionTitle',
  seriesTitle: 'collectionTitle',
  seriesNumber: 'collectionNumber',
  publisher: 'publisher',
  place: 'publisherPlace',
  edition: 'edition',
  volume: 'volume',
  issue: 'issue',
  pages: 'pages',
  abstractNote: 'abstract',
  url: 'url',
  rights: 'licence',
  versionNumber: 'versionLabel',
};

export interface MapFieldsContext {
  /** The Zotero item type, needed for the arXiv heuristic and for nothing else. */
  zoteroItemType: string;
  cslType: string | null;
}

/** Map one item's whole field set. */
export const mapZoteroFields = (
  values: readonly ZoteroFieldValue[],
  context: MapFieldsContext,
): MappedFields => {
  const bibliographic: BibliographicInput = {};
  const carried: CarriedField[] = [];
  let extra: string | null = null;
  let nativeCitationKey: string | null = null;

  const byBase = new Map<string, ZoteroFieldValue>();
  for (const value of values) if (!byBase.has(value.baseField)) byBase.set(value.baseField, value);

  const carry = (
    value: ZoteroFieldValue,
    reason: CarriedField['reason'],
    detail?: string,
  ): void => {
    const entry: CarriedField = {
      zoteroField: value.field,
      fieldKey: `zotero_${slugify(value.field)}`,
      label: `Zotero: ${humanise(value.field)}`,
      value: value.value,
      reason,
    };
    if (detail !== undefined) entry.detail = detail;
    carried.push(entry);
  };

  /** Write a normalised identifier, or carry the raw value with the reason it was refused. */
  const identifier = (
    value: ZoteroFieldValue,
    column: keyof BibliographicInput,
    normalise: (raw: string) => Normalised,
  ): void => {
    const result = normalise(value.value);
    if (result.ok) {
      Object.assign(bibliographic, { [column]: result.value });
    } else {
      carry(value, 'rejected', result.reason);
    }
  };

  if (context.cslType !== null) bibliographic.cslType = context.cslType;

  for (const value of values) {
    if (value.value.trim() === '') continue;

    switch (value.baseField) {
      case 'extra':
        extra = value.value;
        continue;
      case 'citationKey':
        nativeCitationKey = value.value.trim();
        continue;
      case 'date': {
        const date = mapZoteroDate(value.value);
        if (date.edtf !== null) bibliographic.issuedDate = date.edtf;
        if (date.year !== null) bibliographic.issuedYear = date.year;
        if (date.month !== null) bibliographic.issuedMonth = date.month;
        if (date.raw !== null && date.rawIsLossy) {
          carried.push({
            zoteroField: value.field,
            fieldKey: 'zotero_date_raw',
            label: 'Zotero: date as written',
            value: date.raw,
            reason: 'no_column',
            detail: 'EDTF cannot hold the source spelling of this date',
          });
        }
        continue;
      }
      case 'accessDate': {
        const stamp = mapZoteroTimestamp(value.value);
        if (stamp !== null) bibliographic.accessedAt = stamp;
        else carry(value, 'rejected', 'not a timestamp');
        continue;
      }
      case 'DOI':
        identifier(value, 'doi', normaliseDoi);
        continue;
      case 'ISBN':
        identifier(value, 'isbn', normaliseIsbn);
        continue;
      case 'ISSN':
        identifier(value, 'issn', normaliseIssn);
        continue;
      case 'PMID':
        identifier(value, 'pmid', normalisePmid);
        continue;
      case 'PMCID':
        identifier(value, 'pmcid', normalisePmcid);
        continue;
      case 'language':
        identifier(value, 'languageCode', normaliseLanguageTag);
        continue;
      case 'numPages': {
        // `number_of_pages` is an INTEGER column and Zotero's field is free text: `214`, but also
        // `xii + 214` and `ca. 200`. Only an integer is written; anything else is carried.
        const pages = /^\d{1,9}$/u.exec(value.value.trim());
        if (pages === null) carry(value, 'rejected', 'not a whole number of pages');
        else bibliographic.numberOfPages = Number.parseInt(pages[0], 10);
        continue;
      }
      default:
        break;
    }

    // The one heuristic in this file, and it is a narrow one: a preprint's `archiveID` base-maps to
    // `number`, which has no facet column, but when the repository is arXiv it is an arXiv id and
    // Recueil has a column for exactly that.
    if (value.field === 'archiveID' && looksLikeArxiv(value.value, byBase.get('publisher')?.value)) {
      identifier(value, 'arxivId', normaliseArxivId);
      continue;
    }

    const column = BASE_FIELD_COLUMNS[value.baseField];
    if (column === undefined) {
      carry(value, 'no_column');
      continue;
    }
    if (bibliographic[column] !== undefined) {
      // Two Zotero fields share one base field on this item type — `series` and `seriesTitle`, say.
      // The first wins the column and the second is carried, so neither is lost.
      carry(value, 'column_taken');
      continue;
    }
    Object.assign(bibliographic, { [column]: value.value });
  }

  if (bibliographic.pages !== undefined && bibliographic.pages !== null) {
    const span = parsePageSpan(bibliographic.pages);
    if (span.first !== null) bibliographic.pageFirst = span.first;
    if (span.last !== null) bibliographic.pageLast = span.last;
  }
  if (context.zoteroItemType === 'preprint') bibliographic.isPreprint = true;

  return {
    bibliographic,
    extra,
    nativeCitationKey,
    title: (bibliographic.title as string | undefined) ?? null,
    carried,
  };
};

/**
 * `218-233`, `155-170`, `e4`, `1-10`.
 *
 * Both endpoints must be plain integers and the span must not run backwards; anything else leaves
 * `page_first`/`page_last` null and lets the `pages` string carry the truth, because
 * `ck_item_bibliographic_pages` refuses a descending span and a guessed number is worse than none.
 */
export const parsePageSpan = (pages: string): { first: number | null; last: number | null } => {
  const text = pages.trim();
  const span = /^(\d{1,9})\s*(?:-{1,2}|‐|‑|‒|–|—)\s*(\d{1,9})$/u.exec(text);
  if (span !== null) {
    const first = Number.parseInt(span[1] as string, 10);
    const last = Number.parseInt(span[2] as string, 10);
    return last >= first ? { first, last } : { first, last: null };
  }
  const single = /^(\d{1,9})$/u.exec(text);
  if (single !== null) {
    const first = Number.parseInt(single[1] as string, 10);
    return { first, last: first };
  }
  return { first: null, last: null };
};

/**
 * Whether a preprint's `archiveID` is an arXiv identifier.
 *
 * Deliberately narrow. `bioRxiv`, `EarthArXiv`, `ChemRxiv` and `SSRN` all put a repository-specific
 * identifier in the same field, and `EarthArXiv` even contains the string "arxiv"; treating any of
 * those as an arXiv id would write a value `ArxivIdSchema` refuses and lose the real one. So the
 * repository must be exactly arXiv, or the value must say so itself.
 */
const looksLikeArxiv = (value: string, repository: string | undefined): boolean => {
  if ((repository ?? '').trim().toLowerCase() === 'arxiv') return true;
  return /^\s*arxiv:/iu.test(value);
};

/** `reportNumber` becomes `report number`, for the custom field's display label. */
const humanise = (field: string): string =>
  field
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .toLowerCase();
