/**
 * The `shorttitle` skip-word list (ADR-0016).
 *
 * "The list ships as editable data, seeded from Better BibTeX's default list." This is the seed:
 * Better BibTeX's `skipWords` default, verbatim and in its own order. A library may replace it
 * through `GenerateKeyOptions.skipWords`; nothing here mutates it, so two libraries with different
 * lists can be keyed in the same process.
 *
 * Matching is case-insensitive and happens after transliteration, so `Ötzi` is compared as `otzi`.
 */
export const DEFAULT_SKIP_WORDS: readonly string[] = [
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'if',
  'in',
  'into',
  'is',
  'it',
  'no',
  'not',
  'of',
  'on',
  'or',
  'such',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'will',
  'with',
];

/** Build the lookup a generator uses. Lower-cased once, so the hot path is a set membership test. */
export const skipWordSet = (words: readonly string[] = DEFAULT_SKIP_WORDS): ReadonlySet<string> =>
  new Set(words.map((word) => word.toLowerCase()));
