/**
 * The text comparisons the engines share, with Metadata Mender's and Argus One's exact rules
 * (spec/parity-zotero-plugins.md §1.2, §1.4, §3.2).
 */

/** Lower-case, NFKD, marks removed, non-alphanumerics to spaces, tokens of ≤ 2 characters dropped. */
export const titleTokens = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/u)
      .filter((token) => token.length > 2),
  );

/** Jaccard similarity of title token sets; 0 when either is empty (MM `_titleSimilar`). */
export const titleSimilarity = (left: string, right: string): number => {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
};

/** NFKD, marks removed, lower-case, only letters and digits (MM `_nameKey`). */
export const nameKey = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Title normalised for blocking and display in reports. */
export const normaliseTitle = (text: string): string => [...titleTokens(text)].join(' ');

const DOI_SHAPE = /^10\.\d{4,9}\/\S+$/u;

/** Argus One `normalizeDOI`: trim, lower-case, strip resolver prefixes; null unless DOI-shaped. */
export const canonicalDoi = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const doi = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//u, '')
    .replace(/^doi:\s*/u, '')
    .trim();
  return DOI_SHAPE.test(doi) ? doi : null;
};

/** Every value of a `Key: value` line in Extra, case-insensitive key (MM, Argus One). */
export const extraValues = (extra: string | null | undefined, key: string): string[] => {
  if (extra === null || extra === undefined) return [];
  const pattern = new RegExp(`^[^\\S\\r\\n]*${key}[^\\S\\r\\n]*:[^\\S\\r\\n]*([^\\r\\n]*)`, 'gimu');
  return [...extra.matchAll(pattern)].map((match) => (match[1] ?? '').trim());
};
