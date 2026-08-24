/**
 * Finding identifiers in text.
 *
 * Stage 7 is "identifier resolution → enrichment", and before anything can be resolved something
 * has to notice that the page says `https://doi.org/10.1093/ije/dyw341` in eight-point type on the
 * first line. This module is that noticing, and nothing more: it finds candidates, normalises them
 * the way `spec/hooks.md` §3 says identifiers are normalised, and hands them on. It never asks the
 * network, and it never decides that a DOI it found is *the* DOI of the document — a reference list
 * is full of other people's DOIs, which is why `extractIdentifiers` takes a `region` and the
 * pipeline asks it about the first page separately from the whole text.
 *
 * Every pattern here is checked, not just matched: an ISBN's check digit is verified, a PMID's
 * range is bounded, an arXiv id's date part has to be a plausible month. A wrong identifier is far
 * more expensive than a missing one, because a wrong one resolves to somebody else's paper.
 */
import type { Identifier, IdentifierScheme } from '../types.js';

/**
 * A DOI as Crossref describes it: `10.` then a registrant of four or more digits, a slash, and a
 * suffix of anything that is not whitespace. The trailing punctuation trim is what stops a DOI at
 * the end of a sentence from acquiring the full stop.
 */
const DOI = /\b(10\.\d{4,9}\/[^\s"'<>]+)/giu;
const ARXIV_NEW = /\barxiv\s*:\s*(\d{4})\.(\d{4,5})(v\d+)?/giu;
const ARXIV_OLD = /\barxiv\s*:\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/giu;
const PMID = /\bpmid\s*:?\s*(\d{1,8})\b/giu;
const PMCID = /\b(pmc\d{6,9})\b/giu;
const ISBN = /\bisbn(?:-1[03])?\s*:?\s*((?:97[89][- ]?)?[\d][\d -]{8,}[\dxX])/giu;
const ISSN = /\b(?:e-?)?issn\s*:?\s*(\d{4}\s*-\s*\d{3}[\dxX])\b/giu;

export interface ExtractOptions {
  /** Cap the text scanned. The first page is where a document's own identifiers live. */
  limit?: number;
}

/** Every identifier this module can find in `text`, de-duplicated, in the order first seen. */
export const extractIdentifiers = (text: string, options: ExtractOptions = {}): Identifier[] => {
  const scope = options.limit === undefined ? text : text.slice(0, options.limit);
  const found: Identifier[] = [];
  const seen = new Set<string>();

  const add = (scheme: IdentifierScheme, value: string | null): void => {
    if (value === null) return;
    const key = `${scheme}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ scheme, value });
  };

  for (const match of scope.matchAll(DOI)) add('doi', normaliseDoi(match[1] ?? ''));
  for (const match of scope.matchAll(ARXIV_NEW)) {
    const month = Number.parseInt((match[1] ?? '').slice(2), 10);
    if (month >= 1 && month <= 12) add('arxiv', `${match[1]}.${match[2]}`);
  }
  for (const match of scope.matchAll(ARXIV_OLD)) add('arxiv', (match[1] ?? '').toLowerCase());
  for (const match of scope.matchAll(PMID)) {
    const value = Number.parseInt(match[1] ?? '', 10);
    // PMIDs are assigned sequentially and are past 39 million; anything under 1000 in a document is
    // a page number that happened to follow the letters "PMID".
    if (value >= 1000 && value <= 99_999_999) add('pmid', String(value));
  }
  for (const match of scope.matchAll(PMCID)) add('pmcid', (match[1] ?? '').toUpperCase());
  for (const match of scope.matchAll(ISBN)) add('isbn', normaliseIsbn(match[1] ?? ''));
  for (const match of scope.matchAll(ISSN)) add('issn', normaliseIssn(match[1] ?? ''));

  return found;
};

/** Lower-cased and bare: no `https://doi.org/`, no `doi:`, no trailing sentence punctuation. */
export const normaliseDoi = (raw: string): string | null => {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//u, '').replace(/^doi\s*:\s*/u, '');
  // A DOI may legally end in almost anything, but it may not end in the punctuation of the sentence
  // that contains it. Trimming a balanced closing bracket is the one case that needs care.
  while (value.length > 0 && /[.,;:]$/u.test(value)) value = value.slice(0, -1);
  while (value.endsWith(')') && countOf(value, '(') < countOf(value, ')')) value = value.slice(0, -1);
  return /^10\.\d{4,9}\/\S+$/u.test(value) ? value : null;
};

/** Hyphen-free, upper-case check digit, and only when the check digit is right. */
export const normaliseIsbn = (raw: string): string | null => {
  const digits = raw.replace(/[\s-]/gu, '').toUpperCase();
  if (digits.length === 10) return isbn10Valid(digits) ? digits : null;
  if (digits.length === 13) return isbn13Valid(digits) ? digits : null;
  return null;
};

export const normaliseIssn = (raw: string): string | null => {
  const digits = raw.replace(/[\s-]/gu, '').toUpperCase();
  if (!/^\d{7}[\dX]$/u.test(digits)) return null;
  let sum = 0;
  for (let index = 0; index < 7; index += 1) {
    sum += Number.parseInt(digits[index] as string, 10) * (8 - index);
  }
  const remainder = (11 - (sum % 11)) % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return digits[7] === expected ? `${digits.slice(0, 4)}-${digits.slice(4)}` : null;
};

const isbn10Valid = (value: string): boolean => {
  if (!/^\d{9}[\dX]$/u.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 9; index += 1) {
    sum += Number.parseInt(value[index] as string, 10) * (10 - index);
  }
  const last = value[9] as string;
  sum += last === 'X' ? 10 : Number.parseInt(last, 10);
  return sum % 11 === 0;
};

const isbn13Valid = (value: string): boolean => {
  if (!/^\d{13}$/u.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 13; index += 1) {
    const digit = Number.parseInt(value[index] as string, 10);
    sum += index % 2 === 0 ? digit : digit * 3;
  }
  return sum % 10 === 0;
};

const countOf = (value: string, char: string): number =>
  value.split('').filter((candidate) => candidate === char).length;
