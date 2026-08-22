/**
 * A `.bib` parser.
 *
 * The syntax is small but every part of it is used by something: `@string` macros by anyone who
 * has ever abbreviated a journal name, `#` concatenation by the same people, `@preamble` by
 * packages, and `crossref` by every conference proceedings ever typed by hand. A parser that
 * handles only `@article{key, field = {value}}` will read most files and quietly mangle the rest,
 * which is the failure mode P10 exists to prevent.
 *
 * This layer is deliberately syntactic: it produces raw entries with raw field strings and resolves
 * macros and cross-references, and it does not know what a `title` is. `import.ts` does the
 * semantics.
 */

/** One `@type{key, …}` block, with its fields lower-cased and its values still LaTeX. */
export interface RawBibEntry {
  readonly type: string;
  readonly key: string;
  readonly fields: ReadonlyMap<string, string>;
  /** Character offset of the `@`, for error reporting. */
  readonly offset: number;
}

export interface RawBibFile {
  readonly entries: readonly RawBibEntry[];
  readonly strings: ReadonlyMap<string, string>;
  readonly preambles: readonly string[];
  readonly comments: readonly string[];
  readonly errors: readonly { readonly message: string; readonly offset: number }[];
}

/** The month macros every `.bib` file may use without declaring them. */
const BUILTIN_STRINGS: ReadonlyMap<string, string> = new Map<string, string>([
  ['jan', 'January'], ['feb', 'February'], ['mar', 'March'], ['apr', 'April'],
  ['may', 'May'], ['jun', 'June'], ['jul', 'July'], ['aug', 'August'],
  ['sep', 'September'], ['oct', 'October'], ['nov', 'November'], ['dec', 'December'],
]);

class BibScanner {
  index = 0;

  constructor(readonly source: string) {}

  get done(): boolean {
    return this.index >= this.source.length;
  }

  peek(): string | undefined {
    return this.source[this.index];
  }

  skipWhitespace(): void {
    while (!this.done && /\s/u.test(this.source[this.index] as string)) this.index += 1;
  }

  readName(): string {
    const start = this.index;
    while (!this.done && /[^\s{}(),=#"@]/u.test(this.source[this.index] as string)) this.index += 1;
    return this.source.slice(start, this.index);
  }

  readBalanced(open: '{' | '('): string {
    const close = open === '{' ? '}' : ')';
    this.index += 1;
    const start = this.index;
    let depth = 1;
    while (!this.done) {
      const character = this.source[this.index] as string;
      if (character === '\\') {
        this.index += 2;
        continue;
      }
      if (character === open) depth += 1;
      else if (character === close) {
        depth -= 1;
        if (depth === 0) {
          const body = this.source.slice(start, this.index);
          this.index += 1;
          return body;
        }
      }
      this.index += 1;
    }
    return this.source.slice(start);
  }

  readQuoted(): string {
    this.index += 1;
    const start = this.index;
    let depth = 0;
    while (!this.done) {
      const character = this.source[this.index] as string;
      if (character === '\\') {
        this.index += 2;
        continue;
      }
      if (character === '{') depth += 1;
      else if (character === '}') depth = Math.max(0, depth - 1);
      else if (character === '"' && depth === 0) {
        const body = this.source.slice(start, this.index);
        this.index += 1;
        return body;
      }
      this.index += 1;
    }
    return this.source.slice(start);
  }
}

const resolveMacro = (name: string, strings: ReadonlyMap<string, string>): string =>
  strings.get(name.toLowerCase()) ?? BUILTIN_STRINGS.get(name.toLowerCase()) ?? name;

/** Read one value, following `#` concatenation across braced, quoted, numeric and macro parts. */
const readValue = (scanner: BibScanner, strings: ReadonlyMap<string, string>): string => {
  let out = '';
  for (;;) {
    scanner.skipWhitespace();
    const character = scanner.peek();
    if (character === undefined) return out;
    if (character === '{') out += scanner.readBalanced('{');
    else if (character === '"') out += scanner.readQuoted();
    else {
      const token = scanner.readName();
      if (token.length === 0) return out;
      out += /^\d+$/u.test(token) ? token : resolveMacro(token, strings);
    }
    scanner.skipWhitespace();
    if (scanner.peek() !== '#') return out;
    scanner.index += 1;
  }
};

/** Read `field = value` pairs until the closing delimiter. */
const readFields = (
  scanner: BibScanner,
  close: '}' | ')',
  strings: ReadonlyMap<string, string>,
): Map<string, string> => {
  const fields = new Map<string, string>();
  for (;;) {
    scanner.skipWhitespace();
    if (scanner.done) return fields;
    if (scanner.peek() === close) {
      scanner.index += 1;
      return fields;
    }
    if (scanner.peek() === ',') {
      scanner.index += 1;
      continue;
    }
    const name = scanner.readName().trim().toLowerCase();
    if (name.length === 0) {
      /* Nothing recognisable here; step over it rather than spinning. */
      scanner.index += 1;
      continue;
    }
    scanner.skipWhitespace();
    if (scanner.peek() !== '=') {
      fields.set(name, '');
      continue;
    }
    scanner.index += 1;
    fields.set(name, readValue(scanner, strings));
  }
};

/**
 * Parse a `.bib` file into raw entries.
 *
 * Never throws. A malformed entry is recorded in `errors` and skipped, because one bad entry in a
 * 4000-entry library must not cost the other 3999.
 */
export const parseBibtexFile = (source: string): RawBibFile => {
  const scanner = new BibScanner(source);
  const entries: RawBibEntry[] = [];
  const strings = new Map<string, string>();
  const preambles: string[] = [];
  const comments: string[] = [];
  const errors: { message: string; offset: number }[] = [];

  while (!scanner.done) {
    const at = source.indexOf('@', scanner.index);
    if (at === -1) break;
    scanner.index = at + 1;
    const offset = at;
    scanner.skipWhitespace();
    const type = scanner.readName().trim().toLowerCase();
    scanner.skipWhitespace();

    const opener = scanner.peek();
    if (opener !== '{' && opener !== '(') {
      errors.push({ message: `@${type} is not followed by a delimiter`, offset });
      continue;
    }
    const close = opener === '{' ? '}' : ')';

    if (type === 'comment') {
      comments.push(scanner.readBalanced(opener));
      continue;
    }
    if (type === 'preamble') {
      preambles.push(scanner.readBalanced(opener));
      continue;
    }
    if (type === 'string') {
      const body = scanner.readBalanced(opener);
      const inner = new BibScanner(body);
      const name = inner.readName().trim().toLowerCase();
      inner.skipWhitespace();
      if (inner.peek() === '=') {
        inner.index += 1;
        strings.set(name, readValue(inner, strings));
      } else {
        errors.push({ message: '@string is not an assignment', offset });
      }
      continue;
    }

    scanner.index += 1;
    scanner.skipWhitespace();
    const keyStart = scanner.index;
    let key = '';
    while (!scanner.done && !/[,\s]/u.test(scanner.source[scanner.index] as string) && scanner.peek() !== close) {
      key += scanner.source[scanner.index] as string;
      scanner.index += 1;
    }
    if (key.length === 0) errors.push({ message: `@${type} has no entry key`, offset: keyStart });
    scanner.skipWhitespace();
    if (scanner.peek() === ',') scanner.index += 1;

    const fields = readFields(scanner, close, strings);
    entries.push({ type, key, fields, offset });
  }

  return { entries, strings, preambles, comments, errors };
};

/** Fields a child inherits from its cross-referenced parent under a different name. */
const CROSSREF_RENAMES: Readonly<Record<string, string>> = {
  title: 'booktitle',
  subtitle: 'booksubtitle',
  author: 'editor',
};

const CHILD_INHERITS_BOOKTITLE = new Set(['incollection', 'inbook', 'inproceedings', 'conference', 'inreference', 'bookinbook']);

/**
 * Apply `crossref` inheritance.
 *
 * BibTeX's rule: a field the child does not define is taken from the parent. BibLaTeX renames some
 * of them on the way — the parent's `title` becomes the child's `booktitle` for an `@incollection`,
 * which is the whole point of cross-referencing a proceedings volume. Both are applied; a `crossref`
 * pointing at a missing entry leaves the child alone.
 */
export const resolveCrossReferences = (file: RawBibFile): RawBibFile => {
  const byKey = new Map(file.entries.map((entry) => [entry.key.toLowerCase(), entry]));
  const resolved = file.entries.map((entry) => {
    const parentKey = entry.fields.get('crossref');
    if (parentKey === undefined) return entry;
    const parent = byKey.get(parentKey.trim().toLowerCase());
    if (parent === undefined) return entry;

    const fields = new Map(entry.fields);
    for (const [name, value] of parent.fields) {
      if (name === 'crossref') continue;
      const renamed = CHILD_INHERITS_BOOKTITLE.has(entry.type) ? CROSSREF_RENAMES[name] : undefined;
      const target = renamed ?? name;
      if (!fields.has(target)) fields.set(target, value);
    }
    return { ...entry, fields };
  });
  return { ...file, entries: resolved };
};
