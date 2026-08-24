/**
 * Turning a name a person typed into Paperless into a slug Recueil will accept.
 *
 * `SLUG_PATTERN` is `^[a-z][a-z0-9_]*$` and both `LibraryService.createItem` and
 * `CustomFieldService.define` enforce it, so every Paperless document-type name and custom-field
 * name has to pass through here.
 *
 * The one thing this does that the Zotero importer's `slugify` does not is **fold diacritics**.
 * Zotero item types are ASCII identifiers from a fixed vocabulary; Paperless names are free text a
 * person typed, and in a German-language install most of them are. `Gehaltsabrechnung` is fine
 * either way, but `Bürgeramt` becomes `b_rgeramt` under a fold-nothing slugifier and `buergeramt`
 * here, and the second is the one a person can read in a field key, an export column and a Parquet
 * header years later.
 *
 * Folding is lossy — `Müller` and `Mueller` slug the same — so nothing relies on a slug for
 * identity. Identity is the Paperless numeric id, carried in `source_id` and in the report;
 * `uniqueSlug` resolves the collisions the fold creates, and the report lists every one.
 */
import { SLUG_PATTERN } from '@recueil/schemas';

/** Letters whose fold is more than "drop the accent". Applied before the NFKD pass. */
const SPECIAL_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ß/gu, 'ss'],
  [/ä/gu, 'ae'],
  [/ö/gu, 'oe'],
  [/ü/gu, 'ue'],
  [/Ä/gu, 'Ae'],
  [/Ö/gu, 'Oe'],
  [/Ü/gu, 'Ue'],
  [/æ/gu, 'ae'],
  [/Æ/gu, 'Ae'],
  [/ø/gu, 'oe'],
  [/Ø/gu, 'Oe'],
  [/å/gu, 'aa'],
  [/Å/gu, 'Aa'],
  [/đ/gu, 'd'],
  [/Đ/gu, 'D'],
  [/ł/gu, 'l'],
  [/Ł/gu, 'L'],
  [/þ/gu, 'th'],
  [/Þ/gu, 'Th'],
  [/&/gu, ' and '],
];

/**
 * `Rechnung Stadtwerke` → `rechnung_stadtwerke`; `Bürgeramt` → `buergeramt`.
 *
 * The result always matches `SLUG_PATTERN`: a name that begins with a digit gets an `x_` in front,
 * and a name with nothing slug-shaped in it at all — `???`, or a name written entirely in a script
 * NFKD does not decompose to ASCII — becomes `unnamed`, which `uniqueSlug` then numbers. Losing a
 * document type to a naming rule would be absurd.
 */
export const slugify = (value: string): string => {
  let folded = value;
  for (const [pattern, replacement] of SPECIAL_FOLDS) folded = folded.replace(pattern, replacement);

  const snake = folded
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');

  if (snake === '') return 'unnamed';
  return /^[a-z]/u.test(snake) ? snake : `x_${snake}`;
};

/**
 * A slug not already taken, by appending `_2`, `_3`, … .
 *
 * `taken` is mutated: the returned slug is added to it, so a caller can walk a list of names and
 * get a distinct slug for each without keeping its own bookkeeping.
 */
export const uniqueSlug = (base: string, taken: Set<string>): string => {
  const start = SLUG_PATTERN.test(base) ? base : slugify(base);
  if (!taken.has(start)) {
    taken.add(start);
    return start;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${start}_${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  /* c8 ignore next 2 -- ten thousand collisions on one name is not a state a real library reaches. */
  throw new RangeError(`Could not find a free slug for '${base}'.`);
};
