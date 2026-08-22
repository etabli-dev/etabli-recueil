/**
 * Identifier normalisation on import.
 *
 * Invariant B1 (`spec/data-model.md` §3.5) says identifiers are stored normalised so that the
 * deduplicator can compare with `=`. A `.bib` file honours no such invariant: it contains
 * `DOI: 10.1136/BMJ.N71`, `https://doi.org/10.1136/bmj.n71`, ISBN-10s, hyphenated ISBN-13s and
 * `arXiv:2103.00020v2`. Each importer therefore runs its identifiers through here, and the answer
 * is one of three: the normalised value, `undefined` because there was nothing there, or a
 * rejection carrying the reason — which the importer turns into a loss entry rather than writing a
 * value the contract would refuse.
 */
import {
  ArxivIdSchema,
  DoiSchema,
  IsbnSchema,
  IssnSchema,
  LanguageTagSchema,
  PmcidSchema,
  PmidSchema,
  UrlSchema,
  isValidIsbn13,
} from '@recueil/schemas';

/** Either a value the contract accepts, or the reason it does not. */
export type Normalised = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

const reject = (reason: string): Normalised => ({ ok: false, reason });
const accept = (value: string): Normalised => ({ ok: true, value });

const check = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: string, what: string): Normalised =>
  schema.safeParse(value).success ? accept(value) : reject(`not a valid ${what}`);

/** Strip the resolver prefix and lower-case, as invariant B1 requires. */
export const normaliseDoi = (raw: string): Normalised => {
  const value = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .toLowerCase()
    .replace(/[.,;]+$/u, '');
  return check(DoiSchema, value, 'DOI');
};

export const normalisePmid = (raw: string): Normalised => {
  const value = raw.trim().replace(/^pmid:\s*/iu, '');
  return check(PmidSchema, value, 'PMID');
};

export const normalisePmcid = (raw: string): Normalised => {
  const value = raw.trim().toUpperCase().replace(/^PMCID:\s*/u, '');
  return check(PmcidSchema, value.startsWith('PMC') ? value : `PMC${value}`, 'PMCID');
};

export const normaliseArxivId = (raw: string): Normalised => {
  const value = raw
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/abs\//iu, '')
    .replace(/^arxiv:\s*/iu, '');
  return check(ArxivIdSchema, value, 'arXiv identifier');
};

/** ISBN-10 → ISBN-13, then the check digit. Hyphens go; that is what B1 means by hyphenless. */
export const normaliseIsbn = (raw: string): Normalised => {
  const digits = raw.trim().replace(/[^0-9Xx]/gu, '').toUpperCase();
  if (digits.length === 10) {
    const body = `978${digits.slice(0, 9)}`;
    let sum = 0;
    for (let index = 0; index < 12; index += 1) {
      sum += Number.parseInt(body[index] as string, 10) * (index % 2 === 0 ? 1 : 3);
    }
    const value = `${body}${(10 - (sum % 10)) % 10}`;
    return isValidIsbn13(value) ? accept(value) : reject('ISBN-10 does not convert to a valid ISBN-13');
  }
  if (digits.length !== 13) return reject('not an ISBN-10 or ISBN-13');
  return check(IsbnSchema, digits, 'ISBN-13');
};

export const normaliseIssn = (raw: string): Normalised => {
  const compact = raw.trim().replace(/[^0-9Xx]/gu, '').toUpperCase();
  if (compact.length !== 8) return reject('not an eight-character ISSN');
  return check(IssnSchema, `${compact.slice(0, 4)}-${compact.slice(4)}`, 'ISSN');
};

export const normaliseUrl = (raw: string): Normalised => {
  const value = raw.trim();
  return check(UrlSchema, value, 'absolute http(s) URL');
};

/** `en`, `en-GB`, `English`, `eng` — a `.bib` `language` field is free text. Only tags survive. */
export const normaliseLanguageTag = (raw: string): Normalised => {
  const value = raw.trim();
  if (LanguageTagSchema.safeParse(value).success) return accept(value);
  const lowered = value.toLowerCase();
  if (LanguageTagSchema.safeParse(lowered).success) return accept(lowered);
  const named: Readonly<Record<string, string>> = {
    english: 'en',
    german: 'de',
    deutsch: 'de',
    french: 'fr',
    francais: 'fr',
    spanish: 'es',
    italian: 'it',
    portuguese: 'pt',
    dutch: 'nl',
    russian: 'ru',
    japanese: 'ja',
    chinese: 'zh',
    ngerman: 'de',
    american: 'en-US',
    british: 'en-GB',
    usenglish: 'en-US',
    ukenglish: 'en-GB',
  };
  const mapped = named[lowered];
  return mapped === undefined ? reject('not a BCP-47 language tag') : accept(mapped);
};
