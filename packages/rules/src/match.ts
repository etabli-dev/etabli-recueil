/**
 * Running one matcher against one value, and saying so.
 *
 * Every leaf condition in both facets ends up here, which is why the result carries the sentence
 * for the trace as well as the verdict: the explanation is produced where the comparison happens,
 * by the code that knows what was compared, rather than reconstructed afterwards from the rule.
 *
 * It is also the one place `limits.maxInputLength` is applied to *every* operator rather than only
 * to the two that compile a pattern. `equals` and `contains` do not backtrack, but they still fold
 * the whole value to lower case — a full copy of it — before they compare, and a bound that covers
 * `matches` and leaves `contains` unbounded would be a bound with a hole in it exactly where an
 * attacker would look. The refusal is the same one the engine raises, so a caller that already
 * handles an undecidable regex handles this too.
 */
import { globRegex, globToPattern } from './glob.js';
import { DEFAULT_MAX_INPUT_LENGTH, RegexInputTooLongError, isRegexLimitError, safeRegex } from './regex/index.js';
import type { SafeRegexOptions } from './regex/index.js';
import type { Matcher } from './schema/matchers.js';

export interface MatchResult {
  readonly matched: boolean;
  readonly detail: string;
  readonly evidence?: string;
  /** Named captures from a `matches` matcher, for `${name}` interpolation in the actions. */
  readonly captures?: Readonly<Record<string, string>>;
  /** Set when the matcher could not be run: a budget or a timeout, never a non-match. */
  readonly error?: string;
}

const quote = (value: string): string => JSON.stringify(value.length > 120 ? `${value.slice(0, 119)}…` : value);

const fold = (value: string, caseSensitive: boolean | undefined): string =>
  caseSensitive === true ? value : value.toLowerCase();

/**
 * "ends with" or "does not end with", from the bare verb.
 *
 * A trace is read as prose, and prose that says "billing@acme.example end with" reads as a bug in
 * the engine rather than as a fact about the document.
 */
const verb = (matched: boolean, bare: string): string =>
  matched ? `${bare.replace(/^(\w+)/u, (word) => (word.endsWith('s') ? `${word}es` : `${word}s`))}` : `does not ${bare}`;

const regexOptions = (matcher: Matcher, limits: SafeRegexOptions): SafeRegexOptions => {
  const flags = [
    'caseSensitive' in matcher && matcher.caseSensitive === true ? '' : 'i',
    'multiline' in matcher && matcher.multiline === true ? 'm' : '',
    'dotAll' in matcher && matcher.dotAll === true ? 's' : '',
  ].join('');
  return { ...limits, flags };
};

/** A one-line description of what a matcher asks for, used in the trace and in the report. */
export const describeMatcher = (matcher: Matcher): string => {
  if ('equals' in matcher) return `equals ${quote(matcher.equals)}`;
  if ('equalsAny' in matcher) return `equals any of ${matcher.equalsAny.map(quote).join(', ')}`;
  if ('contains' in matcher) return `contains ${quote(matcher.contains)}`;
  if ('startsWith' in matcher) return `starts with ${quote(matcher.startsWith)}`;
  if ('endsWith' in matcher) return `ends with ${quote(matcher.endsWith)}`;
  if ('glob' in matcher) return `matches glob ${quote(matcher.glob)}`;
  return `matches /${matcher.matches}/`;
};

/**
 * Apply a matcher to a value.
 *
 * A missing value never matches, and says that it is missing rather than that it did not match:
 * "no mail sender on this subject" and "the sender was not Acme" are different facts, and a
 * reviewer reading a trace needs to be able to tell them apart.
 */
export const applyMatcher = (matcher: Matcher, value: string | undefined, limits: SafeRegexOptions = {}): MatchResult => {
  const wanted = describeMatcher(matcher);
  if (value === undefined) return { matched: false, detail: `no value to test; the rule wanted ${wanted}` };

  const maxInputLength = limits.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
  if (value.length > maxInputLength) {
    // Not a non-match. Nothing was compared, so nothing may be concluded: the caller turns this
    // into a rule outcome of `error` and the subject goes to a human (P3, ADR-0022 §6).
    const refusal = new RegexInputTooLongError(wanted, value.length, maxInputLength);
    return { matched: false, detail: `could not test whether it ${wanted}`, error: refusal.message };
  }

  if ('equals' in matcher) {
    const matched = fold(value, matcher.caseSensitive) === fold(matcher.equals, matcher.caseSensitive);
    return { matched, detail: `${quote(value)} ${verb(matched, 'equal')} ${quote(matcher.equals)}` };
  }
  if ('equalsAny' in matcher) {
    const folded = fold(value, matcher.caseSensitive);
    const hit = matcher.equalsAny.find((candidate) => fold(candidate, matcher.caseSensitive) === folded);
    return hit === undefined
      ? { matched: false, detail: `${quote(value)} is none of the ${matcher.equalsAny.length} listed values` }
      : { matched: true, detail: `${quote(value)} equals ${quote(hit)}`, evidence: hit };
  }
  if ('contains' in matcher) {
    const matched = fold(value, matcher.caseSensitive).includes(fold(matcher.contains, matcher.caseSensitive));
    return { matched, detail: `${quote(value)} ${verb(matched, 'contain')} ${quote(matcher.contains)}` };
  }
  if ('startsWith' in matcher) {
    const matched = fold(value, matcher.caseSensitive).startsWith(fold(matcher.startsWith, matcher.caseSensitive));
    return { matched, detail: `${quote(value)} ${verb(matched, 'start with')} ${quote(matcher.startsWith)}` };
  }
  if ('endsWith' in matcher) {
    const matched = fold(value, matcher.caseSensitive).endsWith(fold(matcher.endsWith, matcher.caseSensitive));
    return { matched, detail: `${quote(value)} ${verb(matched, 'end with')} ${quote(matcher.endsWith)}` };
  }

  const pattern = 'glob' in matcher ? globToPattern(matcher.glob) : matcher.matches;
  try {
    const compiled = 'glob' in matcher ? globRegex(matcher.glob, regexOptions(matcher, limits)) : safeRegex(pattern, regexOptions(matcher, limits));
    const found = compiled.exec(value);
    if (found === undefined) return { matched: false, detail: `${quote(value)} does not ${wanted}` };
    const captures = Object.keys(found.groups).length > 0 ? found.groups : undefined;
    return {
      matched: true,
      detail: `${quote(value)} ${wanted} at ${found.start}..${found.end}`,
      evidence: found.text,
      ...(captures === undefined ? {} : { captures }),
    };
  } catch (error) {
    if (isRegexLimitError(error)) {
      // Not a non-match: the engine could not decide, and a rule that cannot be decided must not be
      // silently treated as false. The caller turns this into a rule outcome of `error`.
      return { matched: false, detail: `could not finish ${wanted}`, error: error.message };
    }
    throw error;
  }
};

/** The first of `values` that matches, for the conditions that read a list — recipients, tags. */
export const applyMatcherToAny = (
  matcher: Matcher,
  values: readonly string[] | undefined,
  what: string,
  limits: SafeRegexOptions = {},
): MatchResult => {
  const wanted = describeMatcher(matcher);
  if (values === undefined || values.length === 0) {
    return { matched: false, detail: `no ${what} on this subject; the rule wanted one that ${wanted}` };
  }
  let error: string | undefined;
  for (const value of values) {
    const result = applyMatcher(matcher, value, limits);
    if (result.error !== undefined) error = result.error;
    if (result.matched) return { ...result, detail: `one of ${values.length} ${what}: ${result.detail}` };
  }
  return {
    matched: false,
    detail: `none of the ${values.length} ${what} ${wanted}`,
    ...(error === undefined ? {} : { error }),
  };
};
