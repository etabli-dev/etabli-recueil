/**
 * The two comparisons the dedup conditions need: normalise, then measure.
 *
 * CONCEPT.md §5.6 describes the record layer as "normalised title + year ± 1 + first author +
 * venue, configurable thresholds". The threshold is configurable in the rule set; the measure has
 * to be fixed, or a threshold means nothing. It is trigram Jaccard over the normalised string:
 * cheap, symmetric, no tuning constants, and forgiving of the differences that actually occur
 * between two records of the same work — a subtitle after a colon, a stray "The", LaTeX accents
 * flattened by one exporter and not the other.
 *
 * It is deliberately not an edit distance. Two records whose titles differ by one word out of four
 * should not score 0.95 because the strings are nearly the same length.
 *
 * **A title is untrusted input.** It reaches here from a PDF's `/Title`, a Zotero export or a
 * Paperless server, and none of those is a friend. The normalisation begins with NFKC, which is an
 * *expansion*: U+FDFA is one code point that normalises to eighteen, so 800 000 of them — a 1.6 MB
 * field — became 14.4 million characters, and the trigram set built one entry per character on top
 * of that. Measured through the shipped `evaluateDedup`: 3.0 seconds and half a gigabyte of
 * resident memory from one pair, with no budget of any kind in the way. `maxInputLength` is checked
 * against the raw length before `normalize` is called, because checking after it is checking after
 * the expansion (ADR-0022 §1, §2).
 *
 * A value over the limit is not a score of zero. `undefined` means "could not be measured", which
 * is a different fact from "measured, and they have nothing in common": the first sends the pair to
 * a human, the second is a decision. Two empty strings score 0 for the same reason in reverse —
 * "neither record has a title" is a measurement, and it is not evidence that they are the same
 * work.
 */
import { DEFAULT_MAX_INPUT_LENGTH } from '../regex/index.js';

export interface SimilarityOptions {
  /**
   * Longest value, in UTF-16 code units, either side may be. Default `DEFAULT_MAX_INPUT_LENGTH`.
   * Checked before normalisation, since normalisation is what expands.
   */
  readonly maxInputLength?: number;
}

/** NFKC, casefolded, punctuation to spaces, whitespace collapsed. */
export const normaliseForComparison = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    // A single character class under one quantifier: it matches each character at most once and
    // cannot backtrack, so this is linear in the (already bounded) value.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const trigrams = (value: string): ReadonlySet<string> => {
  const padded = `  ${value} `;
  const out = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) out.add(padded.slice(index, index + 3));
  return out;
};

/**
 * Trigram Jaccard similarity of two strings, from 0 to 1, or `undefined` when a side is too long
 * to measure.
 *
 * Two empty strings score 0 rather than 1: "neither record has a title" is not evidence that they
 * are the same work, and a rule reading `title-similarity: { atLeast: 0.9 }` must not fire on it.
 */
export const similarity = (
  left: string | undefined,
  right: string | undefined,
  options: SimilarityOptions = {},
): number | undefined => {
  const maxInputLength = options.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
  if ((left ?? '').length > maxInputLength || (right ?? '').length > maxInputLength) return undefined;
  const a = normaliseForComparison(left ?? '');
  const b = normaliseForComparison(right ?? '');
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const setA = trigrams(a);
  const setB = trigrams(b);
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
};

/**
 * Overlap of two name lists, as the share of the smaller list that appears in the larger, or
 * `undefined` when a list is too long to measure.
 *
 * Not Jaccard here: a record with three authors and the same record with "et al." truncated to one
 * are the same work, and a symmetric measure would score them 0.33 and refuse the merge.
 *
 * The limit is on the total characters of a list rather than on one name, because a thousand names
 * of a kilobyte each is the same expansion as one name of a megabyte.
 */
export const nameOverlap = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
  options: SimilarityOptions = {},
): number | undefined => {
  const maxInputLength = options.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
  const total = (names: readonly string[]): number => names.reduce((sum, name) => sum + name.length, 0);
  if (total(left ?? []) > maxInputLength || total(right ?? []) > maxInputLength) return undefined;
  const a = (left ?? []).map((name) => normaliseForComparison(name)).filter((name) => name.length > 0);
  const b = (right ?? []).map((name) => normaliseForComparison(name)).filter((name) => name.length > 0);
  if (a.length === 0 || b.length === 0) return 0;
  const larger = new Set(a.length >= b.length ? a : b);
  const smaller = a.length >= b.length ? b : a;
  let shared = 0;
  for (const name of smaller) if (larger.has(name)) shared += 1;
  return shared / smaller.length;
};
