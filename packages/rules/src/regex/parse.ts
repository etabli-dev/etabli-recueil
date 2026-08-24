/**
 * The pattern parser for the linear-time engine.
 *
 * The grammar below is a deliberate subset of JavaScript's. Backreferences, lookahead and
 * lookbehind are missing not because they were hard but because a Thompson/Pike simulation cannot
 * run them in linear time, and linear time is the property this package sells: a rule set is
 * user-supplied text run against attacker-supplied documents, so `(a+)+$` must be a non-event
 * rather than an outage. Anything outside the subset is a `RegexSyntaxError` at compile time,
 * where the rule author can see it, instead of a hang at ingest time, where nobody can.
 *
 * Supported: literals and the usual escapes, `.`, character classes with ranges and negation, the
 * class escapes `\d \D \w \W \s \S`, the anchors `^` and `$`, the word boundaries `\b` and `\B`,
 * grouping (capturing, non-capturing and named), alternation, and the quantifiers `*`, `+`, `?`
 * and `{n,m}` in greedy and lazy form. Flags: `i`, `m`, `s`.
 */
import { RegexSyntaxError } from './errors.js';

/** An inclusive code-point range. */
export interface CodeRange {
  readonly lo: number;
  readonly hi: number;
}

export type Assertion = 'start' | 'end' | 'word-boundary' | 'not-word-boundary';

export type RegexNode =
  | { readonly kind: 'empty' }
  | { readonly kind: 'class'; readonly negated: boolean; readonly ranges: readonly CodeRange[] }
  | { readonly kind: 'assert'; readonly assertion: Assertion }
  | { readonly kind: 'concat'; readonly nodes: readonly RegexNode[] }
  | { readonly kind: 'alternate'; readonly nodes: readonly RegexNode[] }
  | { readonly kind: 'repeat'; readonly node: RegexNode; readonly min: number; readonly max: number; readonly lazy: boolean }
  | { readonly kind: 'group'; readonly node: RegexNode; readonly index?: number; readonly name?: string };

export interface ParsedPattern {
  readonly node: RegexNode;
  /** Group count excluding group 0, which is the whole match. */
  readonly groupCount: number;
  /** Name → group index, for `(?<name>…)`. */
  readonly groupNames: ReadonlyMap<string, number>;
}

/** `{n,m}` is expanded by copying, so an unbounded `n` would be an unbounded program. */
const MAX_REPEAT = 1000;

const DIGIT_RANGES: readonly CodeRange[] = [{ lo: 0x30, hi: 0x39 }];
const WORD_RANGES: readonly CodeRange[] = [
  { lo: 0x30, hi: 0x39 },
  { lo: 0x41, hi: 0x5a },
  { lo: 0x5f, hi: 0x5f },
  { lo: 0x61, hi: 0x7a },
];
const SPACE_RANGES: readonly CodeRange[] = [
  { lo: 0x09, hi: 0x0d },
  { lo: 0x20, hi: 0x20 },
  { lo: 0xa0, hi: 0xa0 },
  { lo: 0x1680, hi: 0x1680 },
  { lo: 0x2000, hi: 0x200a },
  { lo: 0x2028, hi: 0x2029 },
  { lo: 0x202f, hi: 0x202f },
  { lo: 0x205f, hi: 0x205f },
  { lo: 0x3000, hi: 0x3000 },
  { lo: 0xfeff, hi: 0xfeff },
];
const NEWLINE_RANGES: readonly CodeRange[] = [
  { lo: 0x0a, hi: 0x0a },
  { lo: 0x0d, hi: 0x0d },
  { lo: 0x2028, hi: 0x2029 },
];

/** Sort and merge, so that every class this module produces is a canonical set of ranges. */
export const unionRanges = (ranges: readonly CodeRange[]): readonly CodeRange[] => {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((left, right) => left.lo - right.lo || left.hi - right.hi);
  const merged: CodeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.lo <= last.hi + 1) {
      if (range.hi > last.hi) merged[merged.length - 1] = { lo: last.lo, hi: range.hi };
      continue;
    }
    merged.push(range);
  }
  return merged;
};

const MAX_CODE_POINT = 0x10ffff;

/** The gaps between the ranges. Lets `[\\s\\S]` and friends be a plain union rather than a special case. */
export const complementRanges = (ranges: readonly CodeRange[]): readonly CodeRange[] => {
  const merged = unionRanges(ranges);
  const out: CodeRange[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.lo > cursor) out.push({ lo: cursor, hi: range.lo - 1 });
    cursor = Math.max(cursor, range.hi + 1);
  }
  if (cursor <= MAX_CODE_POINT) out.push({ lo: cursor, hi: MAX_CODE_POINT });
  return out;
};

const literal = (codePoint: number): RegexNode => ({
  kind: 'class',
  negated: false,
  ranges: [{ lo: codePoint, hi: codePoint }],
});

const SIMPLE_ESCAPES: ReadonlyMap<string, number> = new Map([
  ['n', 0x0a],
  ['r', 0x0d],
  ['t', 0x09],
  ['f', 0x0c],
  ['v', 0x0b],
  ['0', 0x00],
]);

const CLASS_ESCAPES: ReadonlyMap<string, { readonly negated: boolean; readonly ranges: readonly CodeRange[] }> = new Map([
  ['d', { negated: false, ranges: DIGIT_RANGES }],
  ['D', { negated: true, ranges: DIGIT_RANGES }],
  ['w', { negated: false, ranges: WORD_RANGES }],
  ['W', { negated: true, ranges: WORD_RANGES }],
  ['s', { negated: false, ranges: SPACE_RANGES }],
  ['S', { negated: true, ranges: SPACE_RANGES }],
]);

const REJECTED: readonly { readonly probe: RegExp; readonly what: string }[] = [
  { probe: /^\(\?=/u, what: 'lookahead' },
  { probe: /^\(\?!/u, what: 'negative lookahead' },
  { probe: /^\(\?<=/u, what: 'lookbehind' },
  { probe: /^\(\?<!/u, what: 'negative lookbehind' },
];

/**
 * Parse a pattern into an abstract syntax tree.
 *
 * `dotAll` is taken here rather than at compile time because `.` is turned into a character class
 * during parsing, and the class it becomes depends on the flag.
 */
export const parsePattern = (pattern: string, options: { readonly dotAll?: boolean } = {}): ParsedPattern => {
  const chars = Array.from(pattern);
  let at = 0;
  let groupCount = 0;
  const groupNames = new Map<string, number>();

  const fail = (message: string, position = at): never => {
    throw new RegexSyntaxError(message, pattern, position);
  };

  const peek = (offset = 0): string | undefined => chars[at + offset];
  const rest = (): string => chars.slice(at).join('');

  const parseHex = (digits: number): number => {
    let value = 0;
    for (let index = 0; index < digits; index += 1) {
      const char = peek();
      if (char === undefined || !/^[0-9a-fA-F]$/u.test(char)) fail('expected a hexadecimal digit');
      value = value * 16 + Number.parseInt(char as string, 16);
      at += 1;
    }
    return value;
  };

  const parseBracedHex = (): number => {
    at += 1; // '{'
    let text = '';
    while (peek() !== undefined && peek() !== '}') {
      text += peek();
      at += 1;
    }
    if (peek() !== '}') fail('unterminated \\u{…} escape');
    at += 1;
    if (!/^[0-9a-fA-F]{1,6}$/u.test(text)) fail('\\u{…} needs one to six hexadecimal digits');
    const value = Number.parseInt(text, 16);
    if (value > 0x10ffff) fail('\\u{…} is beyond the last code point');
    return value;
  };

  /** An escape that stands for a single code point. Class escapes are handled by the caller. */
  const parseCharEscape = (): number => {
    const char = peek();
    if (char === undefined) return fail('pattern ends with a backslash');
    at += 1;
    const simple = SIMPLE_ESCAPES.get(char);
    if (simple !== undefined) return simple;
    if (char === 'x') return parseHex(2);
    if (char === 'u') return peek() === '{' ? parseBracedHex() : parseHex(4);
    if (char === 'c') {
      const letter = peek();
      if (letter === undefined || !/^[a-zA-Z]$/u.test(letter)) return fail('\\c must be followed by a letter');
      at += 1;
      return letter.toUpperCase().codePointAt(0)! - 64;
    }
    if (/^[1-9]$/u.test(char)) return fail('backreferences are not supported by the linear engine', at - 1);
    if (char === 'k') return fail('named backreferences are not supported by the linear engine', at - 1);
    if (char === 'p' || char === 'P') {
      return fail('Unicode property escapes are not supported; write the ranges out', at - 1);
    }
    if (/^[a-zA-Z]$/u.test(char)) return fail(`unknown escape \\${char}`, at - 1);
    return char.codePointAt(0)!;
  };

  const parseClass = (): RegexNode => {
    at += 1; // '['
    const negated = peek() === '^';
    if (negated) at += 1;
    const ranges: CodeRange[] = [];

    while (true) {
      const char = peek();
      if (char === undefined) return fail('unterminated character class');
      if (char === ']') {
        at += 1;
        break;
      }

      let lo: number;
      if (char === '\\') {
        at += 1;
        const escape = peek();
        if (escape !== undefined && CLASS_ESCAPES.has(escape)) {
          const set = CLASS_ESCAPES.get(escape)!;
          at += 1;
          ranges.push(...(set.negated ? complementRanges(set.ranges) : set.ranges));
          continue;
        }
        if (escape === 'b') {
          at += 1;
          lo = 0x08; // \b inside a class is a backspace, as in JavaScript
        } else {
          lo = parseCharEscape();
        }
      } else {
        at += 1;
        lo = char.codePointAt(0)!;
      }

      if (peek() === '-' && peek(1) !== undefined && peek(1) !== ']') {
        at += 1;
        const next = peek();
        let hi: number;
        if (next === '\\') {
          at += 1;
          const escape = peek();
          if (escape !== undefined && CLASS_ESCAPES.has(escape)) {
            return fail('a class escape cannot be the end of a range');
          }
          hi = parseCharEscape();
        } else {
          at += 1;
          hi = (next as string).codePointAt(0)!;
        }
        if (hi < lo) return fail('character range is out of order');
        ranges.push({ lo, hi });
      } else {
        ranges.push({ lo, hi: lo });
      }
    }

    return { kind: 'class', negated, ranges: unionRanges(ranges) };
  };

  const parseAtom = (): RegexNode => {
    for (const { probe, what } of REJECTED) {
      if (probe.test(rest())) return fail(`${what} is not supported by the linear engine`);
    }

    const char = peek();
    if (char === undefined) return { kind: 'empty' };

    if (char === '(') {
      at += 1;
      let index: number | undefined;
      let name: string | undefined;
      if (peek() === '?') {
        at += 1;
        if (peek() === ':') {
          at += 1;
        } else if (peek() === '<') {
          at += 1;
          let text = '';
          while (peek() !== undefined && peek() !== '>') {
            text += peek();
            at += 1;
          }
          if (peek() !== '>') return fail('unterminated group name');
          at += 1;
          if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(text)) return fail('group name must be an identifier');
          if (groupNames.has(text)) return fail(`duplicate group name "${text}"`);
          groupCount += 1;
          index = groupCount;
          name = text;
          groupNames.set(text, index);
        } else {
          return fail('inline flags and extended groups are not supported');
        }
      } else {
        groupCount += 1;
        index = groupCount;
      }
      const inner = parseAlternation();
      if (peek() !== ')') return fail('unterminated group');
      at += 1;
      return name === undefined ? { kind: 'group', node: inner, index } : { kind: 'group', node: inner, index, name };
    }

    if (char === '[') return parseClass();

    if (char === '.') {
      at += 1;
      return options.dotAll === true
        ? { kind: 'class', negated: true, ranges: [] }
        : { kind: 'class', negated: true, ranges: NEWLINE_RANGES };
    }

    if (char === '^') {
      at += 1;
      return { kind: 'assert', assertion: 'start' };
    }

    if (char === '$') {
      at += 1;
      return { kind: 'assert', assertion: 'end' };
    }

    if (char === '\\') {
      at += 1;
      const escape = peek();
      if (escape !== undefined && CLASS_ESCAPES.has(escape)) {
        const set = CLASS_ESCAPES.get(escape)!;
        at += 1;
        return { kind: 'class', negated: set.negated, ranges: set.ranges };
      }
      if (escape === 'b') {
        at += 1;
        return { kind: 'assert', assertion: 'word-boundary' };
      }
      if (escape === 'B') {
        at += 1;
        return { kind: 'assert', assertion: 'not-word-boundary' };
      }
      return literal(parseCharEscape());
    }

    if (char === ')' || char === '|') return { kind: 'empty' };

    if (char === '*' || char === '+' || char === '?') return fail(`nothing for "${char}" to repeat`);

    at += 1;
    return literal(char.codePointAt(0)!);
  };

  /** `{n}`, `{n,}` or `{n,m}` — and, as in JavaScript, a literal `{` when it is none of those. */
  const parseBraceQuantifier = (): { readonly min: number; readonly max: number } | undefined => {
    const match = /^\{(\d{1,7})(,(\d{1,7})?)?\}/u.exec(rest());
    if (match === null) return undefined;
    const min = Number.parseInt(match[1]!, 10);
    const max = match[2] === undefined ? min : match[3] === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(match[3], 10);
    if (max < min) fail('quantifier is out of order');
    if (min > MAX_REPEAT || (Number.isFinite(max) && max > MAX_REPEAT)) {
      fail(`a repetition count above ${MAX_REPEAT} would not compile to a bounded program`);
    }
    at += Array.from(match[0]).length;
    return { min, max };
  };

  const parseRepeat = (): RegexNode => {
    let node = parseAtom();
    let quantified = false;
    while (true) {
      const char = peek();
      let bounds: { readonly min: number; readonly max: number } | undefined;
      if (char === '*') {
        at += 1;
        bounds = { min: 0, max: Number.POSITIVE_INFINITY };
      } else if (char === '+') {
        at += 1;
        bounds = { min: 1, max: Number.POSITIVE_INFINITY };
      } else if (char === '?') {
        at += 1;
        bounds = { min: 0, max: 1 };
      } else if (char === '{') {
        bounds = parseBraceQuantifier();
      }
      if (bounds === undefined) return node;
      if (node.kind === 'assert') fail('an anchor cannot be quantified');
      // As in JavaScript: `a++` is a mistake, not a possessive quantifier. Wrap it in a group if
      // repeating a repetition is really what was meant.
      if (quantified) fail(`nothing for "${char}" to repeat`);
      const lazy = peek() === '?';
      if (lazy) at += 1;
      quantified = true;
      node = { kind: 'repeat', node, min: bounds.min, max: bounds.max, lazy };
    }
  };

  const parseConcat = (): RegexNode => {
    const nodes: RegexNode[] = [];
    while (true) {
      const char = peek();
      if (char === undefined || char === '|' || char === ')') break;
      const node = parseRepeat();
      if (node.kind === 'empty') break;
      nodes.push(node);
    }
    if (nodes.length === 0) return { kind: 'empty' };
    if (nodes.length === 1) return nodes[0]!;
    return { kind: 'concat', nodes };
  };

  function parseAlternation(): RegexNode {
    const branches: RegexNode[] = [parseConcat()];
    while (peek() === '|') {
      at += 1;
      branches.push(parseConcat());
    }
    if (branches.length === 1) return branches[0]!;
    return { kind: 'alternate', nodes: branches };
  }

  const node = parseAlternation();
  if (at < chars.length) fail(`unexpected "${peek()}"`);
  return { node, groupCount, groupNames };
};
