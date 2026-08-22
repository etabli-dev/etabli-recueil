/**
 * Citation keys (ADR-0016).
 *
 * The default formula is Better BibTeX's, `auth.lower + shorttitle(3,3) + year`, and the reason it
 * is that rather than something tidier is worth restating where the code lives: the value of a key
 * is that it is the same one as last year. Every `\cite{}` already written in a manuscript has to
 * keep resolving after the migration, so this module's job is compatibility, not elegance.
 *
 * `generateKey` is a pure function of one record. `disambiguate` is the part that needs the batch:
 * suffixes are assigned in creation order so that the answer does not depend on the order a query
 * returned rows in, they are assigned once, and a key that has ever been issued is never reissued.
 */
import { transliterate, transliterateWords } from '../text/transliterate.js';
import type { TransliterateOptions } from '../text/transliterate.js';
import { issuedYear } from '../dates.js';
import { creatorFamily, trimmed } from '../record.js';
import type { FormatCreator, FormatCreatorRole, FormatRecord } from '../record.js';
import { isLatinScript } from '../text/transliterate.js';
import { DEFAULT_SKIP_WORDS, skipWordSet } from './skip-words.js';
import { parsePattern } from './pattern.js';
import type { CitationKeyPattern, KeyFunction, ParsedModifier, ParsedTerm } from './pattern.js';

/** Better BibTeX's default, and Recueil's (ADR-0016). */
export const DEFAULT_CITATION_KEY_FORMULA = 'auth.lower + shorttitle(3,3) + year';

/** What the `auth` segment falls back to when an item has no creator at all (ADR-0016). */
export const ANONYMOUS_AUTH = 'anon';

export interface GenerateKeyOptions extends TransliterateOptions {
  /** The per-library formula. A string is parsed; a parsed pattern is reused as-is. */
  readonly formula?: string | CitationKeyPattern | undefined;
  /** The library's skip-word list. Defaults to `DEFAULT_SKIP_WORDS`. */
  readonly skipWords?: readonly string[] | undefined;
  /**
   * Return a pinned key unchanged instead of recomputing it. Default `true`, and there is no good
   * reason to pass `false` outside a "what would this item's key be?" preview.
   */
  readonly respectPinned?: boolean | undefined;
}

const DEFAULT_PATTERN = parsePattern(DEFAULT_CITATION_KEY_FORMULA);

/** The characters `CitationKeySchema` allows. Anything else is dropped from the assembled key. */
const KEY_SAFE = /[^A-Za-z0-9:_.+#$%&\-/]/gu;

/** A key is pinned when the item carries one and the manual lock is set (ADR-0016, "Pinning"). */
export const pinnedKey = (record: FormatRecord): string | undefined => {
  const bib = record.bibliographic;
  if (bib?.citationKeyLocked !== true) return undefined;
  return trimmed(bib.citationKey);
};

/* -------------------------------------------------------------------------------------------- */
/* Segments                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** author → editor → any other role, as ADR-0016's `auth` segment specifies. */
const ROLE_PRIORITY: readonly FormatCreatorRole[] = ['author', 'editor'];

const orderedCreators = (record: FormatRecord): readonly FormatCreator[] => {
  const creators = record.creators ?? [];
  for (const role of ROLE_PRIORITY) {
    const matching = creators.filter((creator) => creator.role === role);
    if (matching.length > 0) return matching;
  }
  return creators;
};

/**
 * The family name to key on.
 *
 * ADR-0016 step 3: "If the record carries a Latin-script variant of the name … that variant is
 * preferred over transliteration." So a Cyrillic family name with a recorded English spelling
 * keys as the author actually publishes, and only a name with no such variant goes through ISO 9.
 */
const familyForKey = (creator: FormatCreator): string | undefined => {
  const family = creatorFamily(creator);
  if (family === undefined) return undefined;
  if (isLatinScript(family)) return family;
  for (const variant of creator.nameVariants ?? []) {
    const form = trimmed(variant.form);
    if (form === undefined || !isLatinScript(form)) continue;
    return familyOfNameForm(form);
  }
  return family;
};

/** `Ivanov, Ivan` and `Ivan Ivanov` both mean the family name `Ivanov`. */
const familyOfNameForm = (form: string): string => {
  const comma = form.indexOf(',');
  if (comma !== -1) return form.slice(0, comma).trim();
  const words = form.split(/\s+/u).filter((word) => word.length > 0);
  return words[words.length - 1] ?? form;
};

interface SegmentContext {
  readonly record: FormatRecord;
  readonly skip: ReadonlySet<string>;
  readonly translit: TransliterateOptions;
}

const authSegment = (context: SegmentContext): string => {
  const creators = orderedCreators(context.record);
  for (const creator of creators) {
    const family = familyForKey(creator);
    if (family === undefined) continue;
    const folded = transliterate(family, context.translit);
    if (folded.length > 0) return folded;
  }
  return ANONYMOUS_AUTH;
};

const familiesSegment = (context: SegmentContext, limit: number | undefined): string => {
  const families: string[] = [];
  for (const creator of orderedCreators(context.record)) {
    const family = familyForKey(creator);
    if (family === undefined) continue;
    const folded = transliterate(family, context.translit);
    if (folded.length === 0) continue;
    families.push(folded);
    if (limit !== undefined && families.length >= limit) break;
  }
  return families.length === 0 ? ANONYMOUS_AUTH : families.join(' ');
};

const authEtalSegment = (context: SegmentContext): string => {
  const creators = orderedCreators(context.record);
  const first = authSegment(context);
  return creators.length > 1 ? `${first} EtAl` : first;
};

const authorLastSegment = (context: SegmentContext): string => {
  const creators = orderedCreators(context.record);
  for (let index = creators.length - 1; index >= 0; index -= 1) {
    const family = familyForKey(creators[index] as FormatCreator);
    if (family === undefined) continue;
    const folded = transliterate(family, context.translit);
    if (folded.length > 0) return folded;
  }
  return ANONYMOUS_AUTH;
};

/**
 * The title the title segments read.
 *
 * ADR-0016 says "the title", so that is what this is; `shortTitle` is a fallback for the case where
 * an item has one and no title at all, which happens in a half-filled connector capture.
 */
const titleSource = (record: FormatRecord): string | undefined =>
  trimmed(record.bibliographic?.title) ?? trimmed(record.title) ?? trimmed(record.bibliographic?.shortTitle);

/** "Split on whitespace and punctuation." A colon is punctuation, so subtitles participate. */
const titleWords = (title: string, translit: TransliterateOptions): string[] =>
  title
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => transliterate(word, translit))
    .filter((word) => word.length > 0);

const capitaliseFirst = (word: string): string =>
  word.length === 0 ? word : (word[0] as string).toUpperCase() + word.slice(1);

const shortTitleSegment = (context: SegmentContext, words: number, characters: number): string => {
  const title = titleSource(context.record);
  if (title === undefined) return '';
  return titleWords(title, context.translit)
    .filter((word) => !context.skip.has(word.toLowerCase()))
    .slice(0, words)
    .map((word) => capitaliseFirst(characters > 0 ? word.slice(0, characters) : word))
    .join(' ');
};

const titleSegment = (context: SegmentContext, words: number, characters: number): string => {
  const title = titleSource(context.record);
  if (title === undefined) return '';
  const all = titleWords(title, context.translit);
  const chosen = words > 0 ? all.slice(0, words) : all;
  return chosen.map((word) => capitaliseFirst(characters > 0 ? word.slice(0, characters) : word)).join(' ');
};

const yearSegment = (context: SegmentContext): string => {
  const bib = context.record.bibliographic;
  const year = issuedYear(bib?.issuedDate, bib?.issuedYear);
  return year === undefined ? '' : String(year).padStart(4, '0');
};

const journalSegment = (context: SegmentContext): string => {
  const bib = context.record.bibliographic;
  const name = trimmed(bib?.containerShort) ?? trimmed(bib?.containerTitle);
  return name === undefined ? '' : transliterateWords(name, context.translit);
};

const doiSegment = (context: SegmentContext): string => {
  const doi = trimmed(context.record.bibliographic?.doi);
  return doi === undefined ? '' : doi.replace(/[^A-Za-z0-9./-]+/gu, '');
};

const parseArgument = (args: readonly string[], index: number, fallback: number): number => {
  const raw = args[index];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(value) ? fallback : value;
};

const evaluateFunction = (name: KeyFunction, args: readonly string[], context: SegmentContext): string => {
  switch (name) {
    case 'auth':
      return authSegment(context);
    case 'authors':
      return familiesSegment(context, args.length === 0 ? undefined : parseArgument(args, 0, 1));
    case 'authEtal':
      return authEtalSegment(context);
    case 'authorLast':
      return authorLastSegment(context);
    case 'shorttitle':
      return shortTitleSegment(context, parseArgument(args, 0, 3), parseArgument(args, 1, 3));
    case 'title':
      return titleSegment(context, parseArgument(args, 0, 0), parseArgument(args, 1, 0));
    case 'veryshorttitle':
      return shortTitleSegment(context, 1, 3);
    case 'year':
      return yearSegment(context);
    case 'shortyear':
      return yearSegment(context).slice(-2);
    case 'journal':
      return journalSegment(context);
    case 'doi':
      return doiSegment(context);
    default: {
      const exhaustive: never = name;
      throw new Error(`unhandled citation-key function ${String(exhaustive)}`);
    }
  }
};

const applyModifier = (value: string, modifier: ParsedModifier): string => {
  const words = value.split(/\s+/u).filter((word) => word.length > 0);
  switch (modifier.name) {
    case 'lower':
      return value.toLowerCase();
    case 'upper':
      return value.toUpperCase();
    case 'capitalize':
      return capitaliseFirst(value.toLowerCase());
    case 'abbr':
      return words.map((word) => word[0] as string).join('');
    case 'condense':
      return words.join(modifier.args[0] ?? '');
    case 'replace': {
      const from = modifier.args[0] ?? '';
      if (from.length === 0) return value;
      return value.split(from).join(modifier.args[1] ?? '');
    }
    case 'select': {
      const first = Math.max(1, parseArgument(modifier.args, 0, 1));
      const last = parseArgument(modifier.args, 1, first);
      return words.slice(first - 1, last).join(' ');
    }
    default: {
      const exhaustive: never = modifier.name;
      throw new Error(`unhandled citation-key modifier ${String(exhaustive)}`);
    }
  }
};

const evaluateTerm = (term: ParsedTerm, context: SegmentContext): string => {
  let value = term.kind === 'literal' ? term.name : evaluateFunction(term.name as KeyFunction, term.args, context);
  for (const modifier of term.modifiers) value = applyModifier(value, modifier);
  return value;
};

const resolvePattern = (formula: GenerateKeyOptions['formula']): CitationKeyPattern => {
  if (formula === undefined) return DEFAULT_PATTERN;
  return typeof formula === 'string' ? parsePattern(formula) : formula;
};

/**
 * The key one record would get, before disambiguation.
 *
 * Pinned keys come back untouched: a key that is already in a manuscript is not this function's to
 * change (ADR-0016, "Pinning"). Everything else is the formula applied to the record.
 */
export const generateKey = (record: FormatRecord, options: GenerateKeyOptions = {}): string => {
  if (options.respectPinned !== false) {
    const pinned = pinnedKey(record);
    if (pinned !== undefined) return pinned;
  }

  const context: SegmentContext = {
    record,
    skip: skipWordSet(options.skipWords ?? DEFAULT_SKIP_WORDS),
    translit: { germanExpansion: options.germanExpansion },
  };

  const pattern = resolvePattern(options.formula);
  const assembled = pattern.terms.map((term) => evaluateTerm(term, context)).join('');
  const key = assembled.replace(/\s+/gu, '').replace(KEY_SAFE, '');
  return key.length > 0 ? key : ANONYMOUS_AUTH;
};

/* -------------------------------------------------------------------------------------------- */
/* Disambiguation                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * The bijective base-26 suffix for the nth colliding item: 1 → `a`, 26 → `z`, 27 → `aa`, 703 →
 * `aaa`. Bijective, so there is no `` (empty) rung in the middle of the sequence and no ambiguity
 * about which item `aa` was.
 */
export const base26Suffix = (ordinal: number): string => {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`a disambiguation ordinal starts at 1, not ${ordinal}`);
  }
  let remaining = ordinal;
  let out = '';
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    out = String.fromCharCode(97 + digit) + out;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return out;
};

/** What one item ended up with, and why. */
export interface KeyAssignment {
  /** `FormatRecord.id`, or the record's index in the batch when it has none. */
  readonly id: string;
  /** The key to write: `base + suffix`, or the pinned key verbatim. */
  readonly key: string;
  /** The formula's output before disambiguation. Equals `key` for the first item of a collision. */
  readonly base: string;
  /** `''` for the item that kept the bare key. */
  readonly suffix: string;
  readonly pinned: boolean;
  /** The key the record already carried, if any. */
  readonly existing?: string | undefined;
  /** `true` when `key` differs from `existing` — what the `citation_key` check reports as drift. */
  readonly changed: boolean;
}

export interface DisambiguateOptions extends GenerateKeyOptions {
  /**
   * Every key this library has ever issued, including retired ones.
   *
   * "A retired key is recorded in a key ledger and never reissued, because a key that has been in a
   * manuscript must not come back attached to a different work" (ADR-0016). Pass the ledger and
   * that holds; omit it and only the current batch is deconflicted.
   */
  readonly ledger?: Iterable<string> | undefined;
}

const sortKey = (record: FormatRecord, index: number): [string, string] => [
  record.createdAt ?? '',
  record.id ?? String(index),
];

/**
 * Assign keys to a batch, deterministically.
 *
 * Order of assignment is creation timestamp, then id — never the caller's array order — so the same
 * library keyed twice produces the same suffixes. The returned array is in that assignment order.
 */
export const disambiguate = (
  records: readonly FormatRecord[],
  options: DisambiguateOptions = {},
): readonly KeyAssignment[] => {
  const indexed = records.map((record, index) => ({ record, index }));
  indexed.sort((left, right) => {
    const [leftCreated, leftId] = sortKey(left.record, left.index);
    const [rightCreated, rightId] = sortKey(right.record, right.index);
    if (leftCreated !== rightCreated) return leftCreated < rightCreated ? -1 : 1;
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    return left.index - right.index;
  });

  const taken = new Set<string>(options.ledger ?? []);
  const assignments: KeyAssignment[] = [];

  /* Pinned keys are claimed first, so a generated key can never be handed a key a manuscript
     already points at (ADR-0016, "Pinning"). */
  for (const { record } of indexed) {
    const pinned = pinnedKey(record);
    if (pinned !== undefined) taken.add(pinned);
  }

  for (const { record, index } of indexed) {
    const id = record.id ?? String(index);
    const existing = trimmed(record.bibliographic?.citationKey);
    const pinned = pinnedKey(record);

    if (pinned !== undefined) {
      assignments.push({ id, key: pinned, base: pinned, suffix: '', pinned: true, existing, changed: false });
      continue;
    }

    const base = generateKey(record, options);
    let key = base;
    let suffix = '';
    let ordinal = 0;
    while (taken.has(key)) {
      ordinal += 1;
      suffix = base26Suffix(ordinal);
      key = base + suffix;
    }
    taken.add(key);
    assignments.push({ id, key, base, suffix, pinned: false, existing, changed: key !== existing });
  }

  return assignments;
};

/** The assignments as a lookup, for a caller that holds items rather than an ordered list. */
export const assignmentsById = (
  assignments: readonly KeyAssignment[],
): ReadonlyMap<string, KeyAssignment> => new Map(assignments.map((assignment) => [assignment.id, assignment]));
