/**
 * Transliteration for citation keys (ADR-0016).
 *
 * The ADR fixes four steps: NFKD and mark removal, an explicit map for the characters that do not
 * decompose, a per-script romanisation table for Greek and Cyrillic, and a final filter to
 * `[A-Za-z0-9]`.
 *
 * One ordering detail is worth stating, because the implementation differs from the reading order
 * of the ADR: the romanisation tables run **before** NFKD, not after it. Cyrillic `й` and `ё` are
 * precomposed, so NFKD-then-strip-marks would fold them to `и` and `е` and the table would never
 * see them; ISO 9:1995 romanises `й` as `j`, which is a different letter from `i`. Running the
 * table first gives the answer the ADR names (ISO 9) rather than the answer the step order would
 * produce by accident. For every character where the two orders agree — which is all of Latin —
 * the result is identical.
 */

/** Characters that survive NFKD unchanged and still need a Latin spelling (ADR-0016, step 2). */
const EXPLICIT_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  ['ß', 'ss'],
  ['ẞ', 'SS'],
  ['æ', 'ae'],
  ['Æ', 'AE'],
  ['œ', 'oe'],
  ['Œ', 'OE'],
  ['ø', 'o'],
  ['Ø', 'O'],
  ['đ', 'd'],
  ['Đ', 'D'],
  ['ð', 'd'],
  ['Ð', 'D'],
  ['þ', 'th'],
  ['Þ', 'Th'],
  ['ł', 'l'],
  ['Ł', 'L'],
  ['ħ', 'h'],
  ['Ħ', 'H'],
  ['ı', 'i'],
  ['İ', 'I'],
  ['ŋ', 'ng'],
  ['Ŋ', 'NG'],
  ['ƒ', 'f'],
]);

/** ISO 843 transliteration (not the transcription column): `η` is `ī`, `β` is `v`, `χ` is `ch`. */
const GREEK_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  ['α', 'a'], ['β', 'v'], ['γ', 'g'], ['δ', 'd'], ['ε', 'e'], ['ζ', 'z'], ['η', 'ī'], ['θ', 'th'],
  ['ι', 'i'], ['κ', 'k'], ['λ', 'l'], ['μ', 'm'], ['ν', 'n'], ['ξ', 'x'], ['ο', 'o'], ['π', 'p'],
  ['ρ', 'r'], ['σ', 's'], ['ς', 's'], ['τ', 't'], ['υ', 'y'], ['φ', 'f'], ['χ', 'ch'], ['ψ', 'ps'],
  ['ω', 'ō'],
  ['Α', 'A'], ['Β', 'V'], ['Γ', 'G'], ['Δ', 'D'], ['Ε', 'E'], ['Ζ', 'Z'], ['Η', 'Ī'], ['Θ', 'Th'],
  ['Ι', 'I'], ['Κ', 'K'], ['Λ', 'L'], ['Μ', 'M'], ['Ν', 'N'], ['Ξ', 'X'], ['Ο', 'O'], ['Π', 'P'],
  ['Ρ', 'R'], ['Σ', 'S'], ['Τ', 'T'], ['Υ', 'Y'], ['Φ', 'F'], ['Χ', 'Ch'], ['Ψ', 'Ps'], ['Ω', 'Ō'],
]);

/** ISO 9:1995, the univocal table — one Cyrillic letter, one Latin letter (plus its diacritic). */
const CYRILLIC_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['ґ', 'g̀'], ['д', 'd'], ['е', 'e'], ['ё', 'ë'],
  ['є', 'ê'], ['ж', 'ž'], ['з', 'z'], ['и', 'i'], ['і', 'ì'], ['ї', 'ï'], ['й', 'j'], ['к', 'k'],
  ['л', 'l'], ['м', 'm'], ['н', 'n'], ['о', 'o'], ['п', 'p'], ['р', 'r'], ['с', 's'], ['т', 't'],
  ['у', 'u'], ['ў', 'ǔ'], ['ф', 'f'], ['х', 'h'], ['ц', 'c'], ['ч', 'č'], ['ш', 'š'], ['щ', 'ŝ'],
  ['ъ', 'ʺ'], ['ы', 'y'], ['ь', 'ʹ'], ['э', 'è'], ['ю', 'û'], ['я', 'â'],
  ['А', 'A'], ['Б', 'B'], ['В', 'V'], ['Г', 'G'], ['Ґ', 'G̀'], ['Д', 'D'], ['Е', 'E'], ['Ё', 'Ë'],
  ['Є', 'Ê'], ['Ж', 'Ž'], ['З', 'Z'], ['И', 'I'], ['І', 'Ì'], ['Ї', 'Ï'], ['Й', 'J'], ['К', 'K'],
  ['Л', 'L'], ['М', 'M'], ['Н', 'N'], ['О', 'O'], ['П', 'P'], ['Р', 'R'], ['С', 'S'], ['Т', 'T'],
  ['У', 'U'], ['Ў', 'Ǔ'], ['Ф', 'F'], ['Х', 'H'], ['Ц', 'C'], ['Ч', 'Č'], ['Ш', 'Š'], ['Щ', 'Ŝ'],
  ['Ъ', 'ʺ'], ['Ы', 'Y'], ['Ь', 'ʹ'], ['Э', 'È'], ['Ю', 'Û'], ['Я', 'Â'],
]);

/** `germanExpansion`, off by default: Better BibTeX folds rather than expands (ADR-0016). */
const GERMAN_EXPANSION: ReadonlyMap<string, string> = new Map<string, string>([
  ['ä', 'ae'], ['ö', 'oe'], ['ü', 'ue'], ['ß', 'ss'],
  ['Ä', 'Ae'], ['Ö', 'Oe'], ['Ü', 'Ue'], ['ẞ', 'SS'],
]);

export interface TransliterateOptions {
  /** Expand the German umlauts and eszett before folding. Default `false` (ADR-0016). */
  readonly germanExpansion?: boolean | undefined;
}

const mapCharacters = (value: string, table: ReadonlyMap<string, string>): string => {
  let out = '';
  for (const character of value) out += table.get(character) ?? character;
  return out;
};

const hasAny = (value: string, table: ReadonlyMap<string, string>): boolean => {
  for (const character of value) if (table.has(character)) return true;
  return false;
};

/** Combining marks, removed after NFKD so that é folds to e (ADR-0016, step 1). */
const COMBINING_MARKS = /\p{Mn}/gu;

/**
 * Romanise a string to `[A-Za-z0-9]` and nothing else.
 *
 * Every segment of a citation key passes through here before the pattern's modifiers run, which is
 * why the result keeps its case: `.lower` is a modifier, not part of transliteration.
 */
export const transliterate = (value: string, options: TransliterateOptions = {}): string => {
  let text = value;
  if (options.germanExpansion === true) text = mapCharacters(text, GERMAN_EXPANSION);
  text = romanise(text);
  text = text.normalize('NFKD').replace(COMBINING_MARKS, '');
  /* Again, because a precomposed accented Greek or Cyrillic letter — ό, ё — only becomes a bare
     letter the table knows once NFKD has taken its accent off. */
  text = romanise(text);
  text = mapCharacters(text, EXPLICIT_MAP);
  return text.replace(/[^A-Za-z0-9]+/gu, '');
};

const romanise = (value: string): string => {
  let text = value;
  if (hasAny(text, GREEK_MAP)) text = mapCharacters(text, GREEK_MAP);
  if (hasAny(text, CYRILLIC_MAP)) text = mapCharacters(text, CYRILLIC_MAP);
  return text;
};

/**
 * The same fold, but whitespace survives as a single space.
 *
 * Multi-word segments — `title`, `journal` — need word boundaries for `.abbr` and `.select` to
 * mean anything; the key assembler strips the spaces at the very end.
 */
export const transliterateWords = (value: string, options: TransliterateOptions = {}): string =>
  value
    .split(/\s+/u)
    .map((word) => transliterate(word, options))
    .filter((word) => word.length > 0)
    .join(' ');

/** The Latin-1 and Latin-Extended blocks, plus ASCII: what "already Latin script" means here. */
const LATIN_SCRIPT = /^[\p{Script=Latin}\p{Nd}\p{P}\p{Zs}\p{Mn}]*$/u;

/**
 * True when a string is written in Latin script and so needs no romanisation table.
 *
 * ADR-0016 step 3 prefers a recorded Latin variant of a name over transliterating the original;
 * this is the test that decides whether to go looking for one.
 */
export const isLatinScript = (value: string): boolean => LATIN_SCRIPT.test(value);
