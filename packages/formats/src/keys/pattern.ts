/**
 * The citation-key pattern language (ADR-0016, "Configurability").
 *
 * A **documented subset** of Better BibTeX's pattern language, and the emphasis is on *subset*:
 * "a pattern using anything outside the subset is rejected when it is saved, with the offending
 * token named — never accepted and silently ignored". So this module parses, and it throws
 * `PatternError` carrying the token and its offset; it never falls back to the default and never
 * drops a segment it did not understand.
 *
 * Grammar:
 *
 * ```text
 * pattern   := term ('+' term)*
 * term      := literal | call
 * literal   := '"' character* '"'
 * call      := name ('(' argument (',' argument)* ')')? modifier*
 * modifier  := '.' name ('(' argument (',' argument)* ')')?
 * ```
 *
 * A backslash escapes a comma, a closing parenthesis or a backslash inside an argument, which is
 * what makes `.replace(\,,-)` — "replace commas with hyphens" — expressible.
 */

/** The functions a pattern may call. */
export const KEY_FUNCTIONS = [
  'auth',
  'authors',
  'authEtal',
  'authorLast',
  'shorttitle',
  'title',
  'veryshorttitle',
  'year',
  'shortyear',
  'journal',
  'doi',
] as const;
export type KeyFunction = (typeof KEY_FUNCTIONS)[number];

/** The modifiers a pattern may chain onto a call. */
export const KEY_MODIFIERS = [
  'lower',
  'upper',
  'capitalize',
  'abbr',
  'condense',
  'replace',
  'select',
] as const;
export type KeyModifier = (typeof KEY_MODIFIERS)[number];

/** How many arguments each function takes: `[minimum, maximum]`. */
const FUNCTION_ARITY: Readonly<Record<KeyFunction, readonly [number, number]>> = {
  auth: [0, 0],
  authors: [0, 1],
  authEtal: [0, 0],
  authorLast: [0, 0],
  shorttitle: [0, 2],
  title: [0, 2],
  veryshorttitle: [0, 0],
  year: [0, 0],
  shortyear: [0, 0],
  journal: [0, 0],
  doi: [0, 0],
};

const MODIFIER_ARITY: Readonly<Record<KeyModifier, readonly [number, number]>> = {
  lower: [0, 0],
  upper: [0, 0],
  capitalize: [0, 0],
  abbr: [0, 0],
  condense: [0, 1],
  replace: [2, 2],
  select: [1, 2],
};

export interface ParsedModifier {
  readonly name: KeyModifier;
  readonly args: readonly string[];
}

export interface ParsedTerm {
  readonly kind: 'call' | 'literal';
  /** The function name, or the literal's text. */
  readonly name: string;
  readonly args: readonly string[];
  readonly modifiers: readonly ParsedModifier[];
}

export interface CitationKeyPattern {
  readonly source: string;
  readonly terms: readonly ParsedTerm[];
}

/** A pattern that used something outside the subset. Names the token, as the ADR requires. */
export class PatternError extends Error {
  readonly token: string;
  readonly position: number;

  constructor(message: string, token: string, position: number) {
    super(message);
    this.name = 'PatternError';
    this.token = token;
    this.position = position;
  }
}

const FUNCTION_SET: ReadonlySet<string> = new Set<string>(KEY_FUNCTIONS);
const MODIFIER_SET: ReadonlySet<string> = new Set<string>(KEY_MODIFIERS);

const isFunction = (name: string): name is KeyFunction => FUNCTION_SET.has(name);
const isModifier = (name: string): name is KeyModifier => MODIFIER_SET.has(name);

class Scanner {
  index = 0;

  constructor(readonly source: string) {}

  get done(): boolean {
    return this.index >= this.source.length;
  }

  peek(): string | undefined {
    return this.source[this.index];
  }

  skipSpaces(): void {
    while (!this.done && /\s/u.test(this.source[this.index] as string)) this.index += 1;
  }

  expect(character: string): void {
    if (this.peek() !== character) {
      throw new PatternError(
        `expected \`${character}\` at position ${this.index}`,
        this.peek() ?? '<end of pattern>',
        this.index,
      );
    }
    this.index += 1;
  }

  readName(): string {
    const start = this.index;
    while (!this.done && /[A-Za-z0-9_]/u.test(this.source[this.index] as string)) this.index += 1;
    return this.source.slice(start, this.index);
  }

  readArguments(): string[] {
    if (this.peek() !== '(') return [];
    this.index += 1;
    if (this.peek() === ')') {
      /* `f()` is a call with no arguments, not a call with one empty one. */
      this.index += 1;
      return [];
    }
    const args: string[] = [];
    let current = '';
    for (;;) {
      if (this.done) throw new PatternError('unterminated argument list', '(', this.index);
      const character = this.source[this.index] as string;
      if (character === '\\') {
        const escaped = this.source[this.index + 1];
        if (escaped === undefined) throw new PatternError('trailing backslash in argument', '\\', this.index);
        current += escaped;
        this.index += 2;
        continue;
      }
      if (character === ',') {
        args.push(current);
        current = '';
        this.index += 1;
        continue;
      }
      if (character === ')') {
        this.index += 1;
        args.push(current);
        return args;
      }
      current += character;
      this.index += 1;
    }
  }

  readLiteral(): string {
    this.expect('"');
    let text = '';
    for (;;) {
      if (this.done) throw new PatternError('unterminated literal', '"', this.index);
      const character = this.source[this.index] as string;
      if (character === '\\') {
        const escaped = this.source[this.index + 1];
        if (escaped === undefined) throw new PatternError('trailing backslash in literal', '\\', this.index);
        text += escaped;
        this.index += 2;
        continue;
      }
      if (character === '"') {
        this.index += 1;
        return text;
      }
      text += character;
      this.index += 1;
    }
  }
}

const checkArity = (
  kind: 'function' | 'modifier',
  name: string,
  count: number,
  arity: readonly [number, number],
  position: number,
): void => {
  const [min, max] = arity;
  if (count < min || count > max) {
    const expected = min === max ? `${min}` : `${min}–${max}`;
    throw new PatternError(
      `${kind} \`${name}\` takes ${expected} argument(s), not ${count}`,
      name,
      position,
    );
  }
};

const parseModifiers = (scanner: Scanner): ParsedModifier[] => {
  const modifiers: ParsedModifier[] = [];
  while (scanner.peek() === '.') {
    scanner.index += 1;
    const position = scanner.index;
    const name = scanner.readName();
    if (name.length === 0) {
      throw new PatternError('a `.` must be followed by a modifier name', '.', position - 1);
    }
    if (!isModifier(name)) {
      throw new PatternError(
        `unknown modifier \`${name}\`; the supported subset is ${KEY_MODIFIERS.join(', ')} (ADR-0016)`,
        name,
        position,
      );
    }
    const args = scanner.readArguments();
    checkArity('modifier', name, args.length, MODIFIER_ARITY[name], position);
    modifiers.push({ name, args });
  }
  return modifiers;
};

/**
 * Parse a formula. Throws `PatternError` — never returns a partially understood pattern.
 */
export const parsePattern = (source: string): CitationKeyPattern => {
  const scanner = new Scanner(source);
  const terms: ParsedTerm[] = [];

  for (;;) {
    scanner.skipSpaces();
    if (scanner.done) {
      if (terms.length === 0) throw new PatternError('the formula is empty', '<end of pattern>', 0);
      throw new PatternError('the formula ends with a `+`', '+', scanner.index);
    }

    const position = scanner.index;
    if (scanner.peek() === '"') {
      const text = scanner.readLiteral();
      terms.push({ kind: 'literal', name: text, args: [], modifiers: parseModifiers(scanner) });
    } else {
      const name = scanner.readName();
      if (name.length === 0) {
        throw new PatternError(
          `unexpected \`${scanner.peek() ?? ''}\` at position ${position}`,
          scanner.peek() ?? '<end of pattern>',
          position,
        );
      }
      if (!isFunction(name)) {
        throw new PatternError(
          `unknown function \`${name}\`; the supported subset is ${KEY_FUNCTIONS.join(', ')} (ADR-0016)`,
          name,
          position,
        );
      }
      const args = scanner.readArguments();
      checkArity('function', name, args.length, FUNCTION_ARITY[name], position);
      terms.push({ kind: 'call', name, args, modifiers: parseModifiers(scanner) });
    }

    scanner.skipSpaces();
    if (scanner.done) return { source, terms };
    if (scanner.peek() !== '+') {
      throw new PatternError(
        `expected \`+\` between segments, found \`${scanner.peek() ?? ''}\``,
        scanner.peek() ?? '<end of pattern>',
        scanner.index,
      );
    }
    scanner.index += 1;
  }
};

/** `true` when the formula parses. For a settings form that wants a boolean, not an exception. */
export const isValidPattern = (source: string): boolean => {
  try {
    parsePattern(source);
    return true;
  } catch (error) {
    if (error instanceof PatternError) return false;
    throw error;
  }
};
