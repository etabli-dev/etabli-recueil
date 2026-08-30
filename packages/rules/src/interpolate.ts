/**
 * `${name}` in an action value.
 *
 * A scanner that writes `2026-08-14_ACME_RE-40231.pdf` has already done the extraction; a rule that
 * can name the pieces should be able to file by them. The captures come from the named groups of a
 * regex condition *in the same rule* that matched — never from another rule, and never from inside
 * a `not`, where a match means the rule did not want that text.
 *
 * A missing capture is not an empty string. Substituting nothing would file a document under
 * `Invoices/` with a blank year, or tag it with the literal `${ref}`, and either is a wrong answer
 * dressed as a right one. The action is skipped instead, and the trace says which name was missing.
 *
 * The scan below is written by hand rather than with a `RegExp` for the same reason as everything
 * else in this package: the template is user input, and nothing in this package runs a backtracking
 * engine over user input.
 *
 * Substitution is an *expansion*, so it carries a bound of its own. The template is short — the
 * schema caps it at 1 024 characters — but each `${name}` in it can be replaced by a capture as
 * long as the whole matched value, so a 1 KB template holding two hundred placeholders against a
 * quarter-mebibyte subject builds sixty megabytes of string for one tag name. `MAX_INTERPOLATED`
 * bounds the result rather than the template, because the template was never the size that mattered
 * (ADR-0022 §2).
 */

/**
 * Longest value one interpolation may produce.
 *
 * Far above any collection path, tag, correspondent or custom-field value the schema will accept
 * downstream, and far below the amplification available without it.
 */
export const MAX_INTERPOLATED = 64 * 1024;

export type Interpolation =
  | { readonly ok: true; readonly value: string; readonly used: readonly string[] }
  | { readonly ok: false; readonly missing: readonly string[] }
  /** The substitution would have produced more than `limit` characters. */
  | { readonly ok: false; readonly tooLong: number; readonly limit: number };

const isNameStart = (char: string): boolean => /^[A-Za-z_$]$/u.test(char);
const isNameRest = (char: string): boolean => /^[A-Za-z0-9_$]$/u.test(char);

/** Read a `${name}` at `index`, or return `undefined` when there is not one there. */
const readPlaceholder = (template: string, index: number): { readonly name: string; readonly end: number } | undefined => {
  if (template[index] !== '$' || template[index + 1] !== '{') return undefined;
  let cursor = index + 2;
  let name = '';
  while (cursor < template.length && template[cursor] !== '}') {
    const char = template[cursor]!;
    if (name === '' ? !isNameStart(char) : !isNameRest(char)) return undefined;
    name += char;
    cursor += 1;
  }
  if (name === '' || template[cursor] !== '}') return undefined;
  return { name, end: cursor + 1 };
};

/** Substitute `${name}` from `captures`. `$${` is a literal `${`. */
export const interpolate = (
  template: string,
  captures: ReadonlyMap<string, string>,
  options: { readonly maxLength?: number } = {},
): Interpolation => {
  const limit = options.maxLength ?? MAX_INTERPOLATED;
  const missing: string[] = [];
  const used: string[] = [];
  let out = '';
  let index = 0;

  while (index < template.length) {
    if (template[index] === '$' && template[index + 1] === '$' && template[index + 2] === '{') {
      out += '${';
      index += 3;
      continue;
    }
    const placeholder = readPlaceholder(template, index);
    if (placeholder === undefined) {
      out += template[index];
      index += 1;
      continue;
    }
    const capture = captures.get(placeholder.name);
    if (capture === undefined) missing.push(placeholder.name);
    else {
      if (out.length + capture.length > limit) {
        return { ok: false, tooLong: out.length + capture.length, limit };
      }
      used.push(placeholder.name);
      out += capture;
    }
    index = placeholder.end;
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true, value: out, used };
};

/** True when the template has at least one placeholder, so a caller can skip the work when it has not. */
export const hasPlaceholder = (template: string): boolean => {
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] === '$' && template[index + 1] === '$' && template[index + 2] === '{') {
      index += 2;
      continue;
    }
    if (readPlaceholder(template, index) !== undefined) return true;
  }
  return false;
};
