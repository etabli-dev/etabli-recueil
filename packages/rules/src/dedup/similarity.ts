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
 */

/** NFKC, casefolded, punctuation to spaces, whitespace collapsed. */
export const normaliseForComparison = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const trigrams = (value: string): ReadonlySet<string> => {
  const padded = `  ${value} `;
  const out = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) out.add(padded.slice(index, index + 3));
  return out;
};

/**
 * Trigram Jaccard similarity of two strings, from 0 to 1.
 *
 * Two empty strings score 0 rather than 1: "neither record has a title" is not evidence that they
 * are the same work, and a rule reading `title-similarity: { atLeast: 0.9 }` must not fire on it.
 */
export const similarity = (left: string | undefined, right: string | undefined): number => {
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
 * Overlap of two name lists, as the share of the smaller list that appears in the larger.
 *
 * Not Jaccard here: a record with three authors and the same record with "et al." truncated to one
 * are the same work, and a symmetric measure would score them 0.33 and refuse the merge.
 */
export const nameOverlap = (left: readonly string[] | undefined, right: readonly string[] | undefined): number => {
  const a = (left ?? []).map(normaliseForComparison).filter((name) => name.length > 0);
  const b = (right ?? []).map(normaliseForComparison).filter((name) => name.length > 0);
  if (a.length === 0 || b.length === 0) return 0;
  const larger = new Set(a.length >= b.length ? a : b);
  const smaller = a.length >= b.length ? b : a;
  let shared = 0;
  for (const name of smaller) if (larger.has(name)) shared += 1;
  return shared / smaller.length;
};
