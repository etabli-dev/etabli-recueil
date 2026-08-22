/**
 * LaTeX escaping, accent folding and brace protection — and the inverse of all three.
 *
 * Three separate jobs travel together here because they have to be undone in the opposite order
 * from the one they were applied in:
 *
 * 1. **Escaping** the ten characters TeX reserves. Unconditional; both `.bib` dialects need it.
 * 2. **Accent folding.** Classic BibTeX with a 7-bit `.bst` cannot be trusted with a literal `é`,
 *    so `bibtex` output writes `\'{e}`. BibLaTeX under `inputenc`/LuaTeX can, so `biblatex` output
 *    passes UTF-8 through unchanged (ADR-0016's neighbours in §5.11 assume a modern toolchain).
 * 3. **Brace protection.** A `.bst` style that title-cases will destroy `DNA`, `pH` and `McDonald`
 *    unless the word is braced. The heuristic is the usual one: a word carrying a capital anywhere
 *    but its first position is protected; a word that is merely capitalised is not, because that
 *    capital is the style's business.
 *
 * Maths is preserved rather than escaped. A title that reads `Effects at $p < 0.05$` contains
 * LaTeX that the author wrote on purpose, and escaping the `$` would turn a formula into three
 * literal dollar signs. Spans between unescaped `$…$` are copied through verbatim in both
 * directions.
 */

/** The characters TeX reserves, and the escape each one takes in text mode. */
const RESERVED: ReadonlyMap<string, string> = new Map<string, string>([
  ['\\', '\\textbackslash{}'],
  ['{', '\\{'],
  ['}', '\\}'],
  ['$', '\\$'],
  ['&', '\\&'],
  ['#', '\\#'],
  ['^', '\\textasciicircum{}'],
  ['_', '\\_'],
  ['%', '\\%'],
  ['~', '\\textasciitilde{}'],
]);

/** Combining mark → accent command (ADR-0016's fold is for keys; this one is for output). */
const ACCENT_COMMANDS: ReadonlyMap<string, string> = new Map<string, string>([
  ['̀', '`'],
  ['́', "'"],
  ['̂', '^'],
  ['̃', '~'],
  ['̄', '='],
  ['̆', 'u'],
  ['̇', '.'],
  ['̈', '"'],
  ['̊', 'r'],
  ['̋', 'H'],
  ['̌', 'v'],
  ['̣', 'd'],
  ['̧', 'c'],
  ['̨', 'k'],
  ['̱', 'b'],
]);

/** Characters with no decomposition, and the control sequence that spells each one. */
const SYMBOL_COMMANDS: ReadonlyMap<string, string> = new Map<string, string>([
  ['ß', '{\\ss}'], ['ẞ', '{\\SS}'],
  ['æ', '{\\ae}'], ['Æ', '{\\AE}'],
  ['œ', '{\\oe}'], ['Œ', '{\\OE}'],
  ['ø', '{\\o}'], ['Ø', '{\\O}'],
  ['ł', '{\\l}'], ['Ł', '{\\L}'],
  ['đ', '{\\dj}'], ['Đ', '{\\DJ}'],
  ['ð', '{\\dh}'], ['Ð', '{\\DH}'],
  ['þ', '{\\th}'], ['Þ', '{\\TH}'],
  ['ı', '{\\i}'], ['ȷ', '{\\j}'],
  ['ŋ', '{\\ng}'], ['Ŋ', '{\\NG}'],
  ['–', '--'], ['—', '---'],
  ['‘', '`'], ['’', "'"], ['“', '``'], ['”', "''"],
  ['…', '\\ldots{}'],
  ['£', '\\pounds{}'], ['€', '\\texteuro{}'], ['©', '\\copyright{}'],
  ['°', '\\textdegree{}'], ['±', '\\textpm{}'], ['×', '\\texttimes{}'], ['÷', '\\textdiv{}'],
  ['µ', '\\textmu{}'], ['·', '\\textperiodcentered{}'],
  ['α', '$\\alpha$'], ['β', '$\\beta$'], ['γ', '$\\gamma$'], ['δ', '$\\delta$'],
  ['ε', '$\\epsilon$'], ['κ', '$\\kappa$'], ['λ', '$\\lambda$'], ['μ', '$\\mu$'],
  ['π', '$\\pi$'], ['ρ', '$\\rho$'], ['σ', '$\\sigma$'], ['τ', '$\\tau$'],
  ['φ', '$\\phi$'], ['χ', '$\\chi$'], ['ψ', '$\\psi$'], ['ω', '$\\omega$'],
  ['Δ', '$\\Delta$'], ['Ω', '$\\Omega$'], ['Σ', '$\\Sigma$'], ['Φ', '$\\Phi$'],
  ['≤', '$\\leq$'], ['≥', '$\\geq$'], ['≠', '$\\neq$'], ['≈', '$\\approx$'],
  ['→', '$\\rightarrow$'], ['−', '$-$'],
]);

/** The inverse of `SYMBOL_COMMANDS`, plus the spellings a real `.bib` file uses in practice. */
const SYMBOL_SEQUENCES: ReadonlyMap<string, string> = new Map<string, string>([
  ['ss', 'ß'], ['SS', 'ẞ'],
  ['ae', 'æ'], ['AE', 'Æ'],
  ['oe', 'œ'], ['OE', 'Œ'],
  ['o', 'ø'], ['O', 'Ø'],
  ['l', 'ł'], ['L', 'Ł'],
  ['dj', 'đ'], ['DJ', 'Đ'],
  ['dh', 'ð'], ['DH', 'Ð'],
  ['th', 'þ'], ['TH', 'Þ'],
  ['i', 'ı'], ['j', 'ȷ'],
  ['ng', 'ŋ'], ['NG', 'Ŋ'],
  ['aa', 'å'], ['AA', 'Å'],
  ['ldots', '…'], ['dots', '…'],
  ['pounds', '£'], ['texteuro', '€'], ['copyright', '©'],
  ['textdegree', '°'], ['textpm', '±'], ['texttimes', '×'], ['textdiv', '÷'],
  ['textmu', 'µ'], ['textperiodcentered', '·'],
  ['textbackslash', '\\'], ['textasciitilde', '~'], ['textasciicircum', '^'],
  ['textendash', '–'], ['textemdash', '—'],
]);

export interface EscapeOptions {
  /**
   * Leave non-ASCII characters alone. `true` for BibLaTeX, `false` for classic BibTeX, which gets
   * `\'{e}` and `{\ss}` instead.
   */
  readonly unicode?: boolean | undefined;
  /** Copy `$…$` spans through untouched. Default `true`. */
  readonly preserveMath?: boolean | undefined;
}

/** Split a string into alternating literal and `$…$` maths spans. */
const splitMath = (value: string): Array<{ readonly math: boolean; readonly text: string }> => {
  const parts: Array<{ math: boolean; text: string }> = [];
  let buffer = '';
  let index = 0;
  while (index < value.length) {
    const character = value[index] as string;
    if (character === '\\' && index + 1 < value.length) {
      buffer += character + (value[index + 1] as string);
      index += 2;
      continue;
    }
    if (character === '$') {
      const close = findMathClose(value, index + 1);
      if (close === -1) {
        buffer += character;
        index += 1;
        continue;
      }
      if (buffer.length > 0) parts.push({ math: false, text: buffer });
      buffer = '';
      parts.push({ math: true, text: value.slice(index, close + 1) });
      index = close + 1;
      continue;
    }
    buffer += character;
    index += 1;
  }
  if (buffer.length > 0) parts.push({ math: false, text: buffer });
  return parts;
};

const findMathClose = (value: string, from: number): number => {
  for (let index = from; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '$') return index;
  }
  return -1;
};

const escapeCharacter = (character: string, unicode: boolean): string => {
  const reserved = RESERVED.get(character);
  if (reserved !== undefined) return reserved;
  if (unicode) return character;
  if (character.codePointAt(0)! < 0x80) return character;

  const symbol = SYMBOL_COMMANDS.get(character);
  if (symbol !== undefined) return symbol;

  const decomposed = character.normalize('NFD');
  const base = decomposed[0];
  if (base !== undefined && decomposed.length >= 2 && /^[A-Za-z]$/u.test(base)) {
    let out = base;
    let wrapped = false;
    for (let index = 1; index < decomposed.length; index += 1) {
      const command = ACCENT_COMMANDS.get(decomposed[index] as string);
      if (command === undefined) return character;
      out = `\\${command}{${out}}`;
      wrapped = true;
    }
    if (wrapped) return out;
  }
  return character;
};

/** Escape one field value for a `.bib` file. */
export const escapeLatex = (value: string, options: EscapeOptions = {}): string => {
  const unicode = options.unicode === true;
  const preserveMath = options.preserveMath !== false;
  const parts = preserveMath ? splitMath(value) : [{ math: false, text: value }];
  let out = '';
  for (const part of parts) {
    if (part.math) {
      out += part.text;
      continue;
    }
    for (const character of part.text) out += escapeCharacter(character, unicode);
  }
  return out;
};

/* -------------------------------------------------------------------------------------------- */
/* Brace protection                                                                                */
/* -------------------------------------------------------------------------------------------- */

const LEADING_PUNCTUATION = /^[^\p{L}\p{N}]*/u;
const TRAILING_PUNCTUATION = /[^\p{L}\p{N}]*$/u;

/**
 * Does this word carry a capital the style must not touch?
 *
 * A capital in first position is the style's to decide. A capital anywhere else — `DNA`, `pH`,
 * `McDonald`, `mRNA`, `TeX` — is part of the spelling of the word and has to survive.
 */
export const needsBraceProtection = (word: string): boolean => {
  const core = word.replace(LEADING_PUNCTUATION, '').replace(TRAILING_PUNCTUATION, '');
  if (core.length < 2) return false;
  const characters = [...core];
  for (let index = 1; index < characters.length; index += 1) {
    const character = characters[index] as string;
    if (character !== character.toLowerCase() && character === character.toUpperCase()) return true;
  }
  return false;
};

/**
 * Brace-protect the capitalised words of a title.
 *
 * Applied to title-like fields only. Names are safe without it: BibTeX's name grammar already
 * forbids a style from re-casing an author, and bracing an author breaks the `von Last, First`
 * parse that the same grammar depends on.
 */
export const protectCapitals = (value: string): string =>
  value
    .split(/(\s+)/u)
    .map((token) => {
      if (/^\s*$/u.test(token)) return token;
      if (token.includes('$') || token.includes('\\')) return token;
      if (token.startsWith('{') && token.endsWith('}')) return token;
      if (!needsBraceProtection(token)) return token;
      const lead = (LEADING_PUNCTUATION.exec(token) ?? [''])[0];
      const trail = (TRAILING_PUNCTUATION.exec(token) ?? [''])[0];
      const core = token.slice(lead.length, token.length - trail.length);
      return `${lead}{${core}}${trail}`;
    })
    .join('');

/* -------------------------------------------------------------------------------------------- */
/* The inverse                                                                                     */
/* -------------------------------------------------------------------------------------------- */

const composeAccent = (command: string, argument: string): string | undefined => {
  for (const [mark, name] of ACCENT_COMMANDS) {
    if (name !== command) continue;
    const base = argument.length === 0 ? ' ' : argument;
    return (base + mark).normalize('NFC');
  }
  return undefined;
};

const readGroup = (value: string, open: number): { readonly body: string; readonly end: number } => {
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return { body: value.slice(open + 1, index), end: index };
    }
  }
  return { body: value.slice(open + 1), end: value.length };
};

const ACCENT_NAMES = new Set<string>([...ACCENT_COMMANDS.values()]);

/**
 * Undo `escapeLatex` — and everything else a real `.bib` file does.
 *
 * The parser is deliberately forgiving: `\'{e}`, `\'e` and `{\'e}` all mean é, and a `.bib` file in
 * the wild contains all three. What it will not do is throw: an unrecognised control sequence is
 * kept verbatim and reported by the caller, because silently deleting a macro loses text.
 */
export const unescapeLatex = (value: string): string => {
  let out = '';
  let index = 0;
  while (index < value.length) {
    const character = value[index] as string;

    if (character === '$') {
      const close = findMathClose(value, index + 1);
      if (close !== -1) {
        out += value.slice(index, close + 1);
        index = close + 1;
        continue;
      }
      out += character;
      index += 1;
      continue;
    }

    if (character === '{') {
      const group = readGroup(value, index);
      out += unescapeLatex(group.body);
      index = group.end + 1;
      continue;
    }

    if (character === '}') {
      index += 1;
      continue;
    }

    if (character === '~') {
      out += ' ';
      index += 1;
      continue;
    }

    if (character === '-' && value.startsWith('---', index)) {
      out += '—';
      index += 3;
      continue;
    }
    if (character === '-' && value.startsWith('--', index)) {
      out += '–';
      index += 2;
      continue;
    }
    if (character === '`' && value.startsWith('``', index)) {
      out += '“';
      index += 2;
      continue;
    }
    if (character === "'" && value.startsWith("''", index)) {
      out += '”';
      index += 2;
      continue;
    }

    if (character !== '\\') {
      out += character;
      index += 1;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) {
      out += character;
      index += 1;
      continue;
    }

    /* A one-character non-alphabetic control sequence: \& \% \# \_ \{ \} \$ \\ — and the accents
       that are spelled with punctuation, \'e and \"u among them. */
    if (!/[A-Za-z]/u.test(next)) {
      if (ACCENT_NAMES.has(next)) {
        const consumed = readAccentArgument(value, index + 2);
        const composed = composeAccent(next, consumed.argument);
        if (composed !== undefined) {
          out += composed;
          index = consumed.end;
          continue;
        }
      }
      out += next;
      index += 2;
      continue;
    }

    const nameMatch = /^[A-Za-z]+/u.exec(value.slice(index + 1));
    const name = nameMatch === null ? '' : nameMatch[0];
    let cursor = index + 1 + name.length;

    if (ACCENT_NAMES.has(name)) {
      const consumed = readAccentArgument(value, cursor);
      const composed = composeAccent(name, consumed.argument);
      if (composed !== undefined) {
        out += composed;
        index = consumed.end;
        continue;
      }
    }

    const symbol = SYMBOL_SEQUENCES.get(name);
    if (symbol !== undefined) {
      if (value[cursor] === '{' && value[cursor + 1] === '}') cursor += 2;
      else if (value[cursor] === ' ') cursor += 1;
      out += symbol;
      index = cursor;
      continue;
    }

    /* Unknown macro. Keep it, braces and all: the caller reports it rather than losing the
       author's text, and merging `\noopsort{b}` into `\noopsortb` would invent a macro. */
    out += `\\${name}`;
    if (value[cursor] === '{') {
      const group = readGroup(value, cursor);
      out += `{${unescapeLatex(group.body)}}`;
      cursor = group.end + 1;
    }
    index = cursor;
  }
  return out;
};

const readAccentArgument = (
  value: string,
  from: number,
): { readonly argument: string; readonly end: number } => {
  let cursor = from;
  while (value[cursor] === ' ') cursor += 1;
  if (value[cursor] === '{') {
    const group = readGroup(value, cursor);
    return { argument: unescapeLatex(group.body), end: group.end + 1 };
  }
  const character = value[cursor];
  if (character === undefined) return { argument: '', end: cursor };
  if (character === '\\') {
    const nameMatch = /^[A-Za-z]+/u.exec(value.slice(cursor + 1));
    const name = nameMatch === null ? '' : nameMatch[0];
    const symbol = SYMBOL_SEQUENCES.get(name);
    if (symbol !== undefined) return { argument: symbol, end: cursor + 1 + name.length };
  }
  return { argument: character, end: cursor + 1 };
};

/** Control sequences left in a value after `unescapeLatex` — what the import report calls out. */
export const residualMacros = (value: string): readonly string[] => {
  const found = new Set<string>();
  /* Maths is kept verbatim on purpose, so the commands inside it are not residue. */
  const outsideMath = value.replace(/\$[^$]*\$/gu, ' ');
  const pattern = /\\([A-Za-z]+)/gu;
  let match = pattern.exec(outsideMath);
  while (match !== null) {
    found.add(`\\${match[1] as string}`);
    match = pattern.exec(outsideMath);
  }
  return [...found];
};

/** Collapse the newlines and runs of spaces a wrapped `.bib` value carries into single spaces. */
export const collapseWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim();
