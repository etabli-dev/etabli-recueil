/**
 * Globs, compiled to the linear engine.
 *
 * A glob is the natural way to write "anything the scanner drops in `Scans/2026/**`", and it is
 * also the form a rule author is least likely to get catastrophically wrong. It is translated into
 * a pattern for `SafeRegex` rather than into a `RegExp`, so a glob inherits the same linear-time
 * guarantee as everything else here — `{a,b}` nesting and `**` cannot be combined into a bomb.
 *
 * The dialect:
 *
 * | Glob | Meaning |
 * |---|---|
 * | `?` | one character, but never `/` |
 * | `*` | any run of characters within one segment |
 * | `**` | any run of characters, separators included |
 * | `**` + `/` | any number of leading directories, zero included |
 * | `/` + `**` at the end | the directory itself and everything under it |
 * | `[abc]`, `[a-z]`, `[!a]` | a character class; the negated form never matches `/` |
 * | `{a,b}` | alternation, nestable |
 *
 * The match is always anchored: a glob describes the whole path, not part of it.
 */
import { RegexSyntaxError, SafeRegex, safeRegex } from './regex/index.js';
import type { SafeRegexOptions } from './regex/index.js';

/** How deep `{…}` may nest. Deep enough for any real rule, shallow enough to bound the program. */
const MAX_BRACE_DEPTH = 8;

/** How a `/` comes out of `escapeLiteral`, which the trailing `dir/**` case has to recognise. */
const SEPARATOR = '\\/';

const escapeLiteral = (char: string): string => {
  if (/^[A-Za-z0-9_]$/u.test(char)) return char;
  // Nothing above ASCII is a metacharacter in this engine, so leave it alone and keep the compiled
  // pattern readable in a dry-run report.
  return char.codePointAt(0)! > 0x7f ? char : `\\${char}`;
};

/**
 * Translate a glob into a pattern for the linear engine.
 *
 * Exported because the dry-run report shows it: "why did `Scans/**` not match this" is answered
 * much faster when the reader can see what the glob became.
 */
export const globToPattern = (glob: string): string => {
  const chars = Array.from(glob);
  let out = '^';
  let depth = 0;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;

    if (char === '*') {
      const doubled = chars[index + 1] === '*';
      if (doubled) {
        index += 1;
        if (chars[index + 1] === '/') {
          // `**/` — any number of leading directories, including none.
          index += 1;
          out += '(?:[^/]+/)*';
        } else if (out.endsWith(SEPARATOR) && index + 1 === chars.length) {
          // A trailing `dir/**` should also match `dir` itself, so the separator becomes optional.
          out = `${out.slice(0, -SEPARATOR.length)}(?:${SEPARATOR}[\\s\\S]*)?`;
        } else {
          out += '[\\s\\S]*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      continue;
    }

    if (char === '[') {
      let inner = '';
      let cursor = index + 1;
      let negated = false;
      if (chars[cursor] === '!' || chars[cursor] === '^') {
        negated = true;
        cursor += 1;
      }
      while (cursor < chars.length && chars[cursor] !== ']') {
        const member = chars[cursor]!;
        inner += member === '\\' || member === ']' || member === '^' ? `\\${member}` : member;
        cursor += 1;
      }
      if (cursor >= chars.length) throw new RegexSyntaxError('unterminated [ in glob', glob, index);
      if (inner.length === 0) throw new RegexSyntaxError('empty [] in glob', glob, index);
      // A negated class also excludes the separator, so `[!a]` cannot cross a directory boundary.
      out += negated ? `[^/${inner}]` : `[${inner}]`;
      index = cursor;
      continue;
    }

    if (char === '{') {
      depth += 1;
      if (depth > MAX_BRACE_DEPTH) throw new RegexSyntaxError(`{} nested more than ${MAX_BRACE_DEPTH} deep`, glob, index);
      out += '(?:';
      continue;
    }

    if (char === '}') {
      if (depth === 0) throw new RegexSyntaxError('unmatched } in glob', glob, index);
      depth -= 1;
      out += ')';
      continue;
    }

    if (char === ',' && depth > 0) {
      out += '|';
      continue;
    }

    if (char === '\\' && index + 1 < chars.length) {
      index += 1;
      out += escapeLiteral(chars[index]!);
      continue;
    }

    out += escapeLiteral(char);
  }

  if (depth !== 0) throw new RegexSyntaxError('unmatched { in glob', glob, chars.length);
  return `${out}$`;
};

/** Compile a glob into a matcher. Memoised through `safeRegex`, so a corpus run compiles once. */
export const globRegex = (glob: string, options: SafeRegexOptions = {}): SafeRegex =>
  safeRegex(globToPattern(glob), options);
