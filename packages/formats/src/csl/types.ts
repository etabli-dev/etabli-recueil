/**
 * The CSL-JSON shapes.
 *
 * Typed structurally rather than generated from the CSL schema, because only the variables Recueil
 * can fill or read matter here and the rest would be noise. `[key: string]: unknown` is on the item
 * on purpose: a CSL-JSON file from another tool carries variables this package does not know, and
 * the importer's job is to report them, which it can only do if the parser kept them.
 */
import type { CslName } from '../names.js';

export type { CslName };

/** A CSL date: `date-parts`, optionally a range, optionally approximate. */
export interface CslDate {
  'date-parts'?: number[][];
  circa?: boolean | number | string;
  raw?: string;
  literal?: string;
  season?: string | number;
}

/** One CSL-JSON item. */
export interface CslItem {
  id: string;
  type: string;
  [variable: string]: unknown;
}

/** The variables this package writes, in the order it writes them, so output is diffable. */
export const CSL_VARIABLE_ORDER: readonly string[] = [
  'id',
  'type',
  'citation-key',
  'author',
  'editor',
  'translator',
  'title',
  'title-short',
  'container-title',
  'container-title-short',
  'collection-title',
  'collection-number',
  'volume',
  'issue',
  'page',
  'page-first',
  'number-of-pages',
  'edition',
  'version',
  'genre',
  'publisher',
  'publisher-place',
  'issued',
  'available-date',
  'accessed',
  'DOI',
  'ISBN',
  'ISSN',
  'PMID',
  'PMCID',
  'URL',
  'abstract',
  'keyword',
  'language',
  'note',
];
