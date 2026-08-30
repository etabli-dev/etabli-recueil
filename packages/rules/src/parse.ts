/**
 * Reading a rule set from YAML or JSON, and saying precisely what is wrong when it is wrong.
 *
 * A rule set is edited by a human in a text box. The error messages are therefore part of the
 * feature, not an afterthought: "Invalid input at rules.3.when.match" tells the author nothing,
 * while "rules[3].when.match: lookahead is not supported by the linear engine (at position 0 of
 * /(?=x)y/)" tells them exactly what to change. Zod reports a union failure as every branch's
 * complaint at once, so `flattenIssues` picks the branch that came closest and reports that one.
 *
 * The YAML parser is given an explicit alias budget. An anchor expanded a thousand times is the
 * classic YAML denial of service, and a rule set arrives over the API.
 *
 * The document itself is bounded twice, and neither bound is the alias budget. An alias budget stops
 * one document from *expanding* without limit; it says nothing about one that arrives enormous, and
 * nothing at all about one that arrives deep.
 *
 * - `maxLength` bounds the text before either parser sees it. `JSON.parse` and the YAML reader both
 *   build the whole tree synchronously with no ceiling of their own.
 * - `MAX_DOCUMENT_DEPTH` bounds the nesting before the schema sees it. A condition is recursive —
 *   `all`, `any` and `not` take conditions — so `{"not":{"not":…}}` three thousand deep is a
 *   24 KB document, inside every other limit, that made `RuleSetSchema.safeParse` throw a bare
 *   `RangeError: Maximum call stack size exceeded` out of a function whose whole contract is to
 *   return the issues instead of throwing. The check is an iterative walk, so it cannot be the
 *   thing that overflows, and a depth cap also terminates on a cyclic value.
 *
 * ADR-0022 §2: the operation is bounded by the call, not inspected afterwards.
 */
import { LineCounter, parse as parseYaml, YAMLParseError } from 'yaml';
import * as z from 'zod';

import { RuleSetSchema } from './schema/index.js';
import type { RuleSet } from './schema/index.js';
import { SUPPORTED_RULE_FORMAT_VERSIONS } from './version.js';

export interface RuleSetIssue {
  /** Dotted path into the document, in the form a rule author sees: `rules[3].when.match`. */
  readonly path: string;
  readonly message: string;
}

export type RuleSetParse = { readonly ok: true; readonly ruleSet: RuleSet } | { readonly ok: false; readonly issues: readonly RuleSetIssue[] };

export class RuleSetError extends Error {
  override readonly name = 'RuleSetError';

  constructor(readonly issues: readonly RuleSetIssue[]) {
    super(`rule set is not valid:\n${formatIssues(issues)}`);
  }
}

const renderPath = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((out, part) => (typeof part === 'number' ? `${out}[${part}]` : out === '' ? String(part) : `${out}.${String(part)}`), '');

/**
 * Flatten Zod's issue tree, preferring the union branch that failed by the least.
 *
 * A `Matcher` is a seven-way union of strict objects. A typo in one of them produces seven
 * complaints, six of which are "you did not write the operator I am about", and one of which is
 * the real problem. The branch with the fewest issues is that one, near enough always, and picking
 * it turns an unreadable wall into one line.
 */
export const flattenIssues = (issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[] = []): readonly RuleSetIssue[] => {
  const out: RuleSetIssue[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      const closest = issue.errors.reduce((best, branch) => (branch.length < best.length ? branch : best), issue.errors[0]!);
      out.push(...flattenIssues(closest, path));
      continue;
    }
    out.push({ path: renderPath(path), message: issue.message });
  }
  return out;
};

export const formatIssues = (issues: readonly RuleSetIssue[]): string =>
  issues.map((issue) => `  ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`).join('\n');

/**
 * How deeply a rule-set document may nest.
 *
 * A `when` in a rule a person wrote is three or four levels; sixty-four is far past the point at
 * which a condition tree is comprehensible, and far short of the stack. It is checked over the
 * decoded value rather than over the text so that it covers YAML, JSON and a row read back out of
 * the database alike.
 */
export const MAX_DOCUMENT_DEPTH = 64;

/**
 * The nesting depth of a decoded value, walked iteratively and abandoned at `limit`.
 *
 * Iterative on purpose: a recursive depth check on a value deep enough to overflow the stack
 * overflows the stack. The return is the depth reached, capped, so the caller can name the limit.
 */
const depthOf = (value: unknown, limit: number): number => {
  const stack: { readonly node: unknown; readonly depth: number }[] = [{ node: value, depth: 1 }];
  let deepest = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > deepest) deepest = depth;
    if (depth > limit) return depth;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    } else if (typeof node === 'object' && node !== null) {
      for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return deepest;
};

/** Check the two fields that decide how the rest is read, so their errors are not buried in a union. */
const checkEnvelope = (value: unknown): readonly RuleSetIssue[] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path: '', message: 'a rule set must be a mapping with `version`, `kind` and `rules`' }];
  }
  const record = value as Record<string, unknown>;
  const issues: RuleSetIssue[] = [];
  if (record['version'] === undefined) {
    issues.push({ path: 'version', message: `required; this build reads version ${SUPPORTED_RULE_FORMAT_VERSIONS.join(', ')}` });
  } else if (typeof record['version'] !== 'number' || !SUPPORTED_RULE_FORMAT_VERSIONS.includes(record['version'])) {
    issues.push({
      path: 'version',
      message: `rule format version ${JSON.stringify(record['version'])} is not one this build reads (${SUPPORTED_RULE_FORMAT_VERSIONS.join(', ')})`,
    });
  }
  if (record['kind'] !== 'ingestion' && record['kind'] !== 'dedup') {
    issues.push({ path: 'kind', message: 'must be `ingestion` (CONCEPT.md §5.3 stage 8) or `dedup` (§5.6)' });
  }
  return issues;
};

/** Validate an already-decoded value — a JSON body from the API, or a row read back from the database. */
export const loadRuleSet = (value: unknown): RuleSetParse => {
  const envelope = checkEnvelope(value);
  if (envelope.length > 0) return { ok: false, issues: envelope };
  const depth = depthOf(value, MAX_DOCUMENT_DEPTH);
  if (depth > MAX_DOCUMENT_DEPTH) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          message:
            `the document nests more than ${MAX_DOCUMENT_DEPTH} levels deep (MAX_DOCUMENT_DEPTH); ` +
            'a condition tree that deep is not one a person wrote',
        },
      ],
    };
  }
  const parsed = RuleSetSchema.safeParse(value);
  return parsed.success ? { ok: true, ruleSet: parsed.data } : { ok: false, issues: flattenIssues(parsed.error.issues) };
};

export interface ParseRuleSetOptions {
  /** `auto` sniffs: a document whose first non-space character is `{` is JSON. */
  readonly format?: 'yaml' | 'json' | 'auto';
  /** How many times one YAML anchor may be expanded. Low on purpose; a rule set needs none. */
  readonly maxAliasCount?: number;
  /** Longest document, in characters, that will be parsed at all. Default `MAX_RULE_SET_CHARS`. */
  readonly maxLength?: number;
}

/**
 * One mebibyte of rule-set source.
 *
 * The largest plausible real rule set — a few hundred rules with descriptions — is tens of
 * kilobytes, so this is two orders of magnitude of headroom and still a refusal rather than a
 * synchronous parse of whatever arrived. The schema's own caps (64 rules of actions each, 4 096
 * characters per pattern, 1 000 members per `equalsAny`) bound a *valid* document; this bounds an
 * invalid one, which is the one an attacker sends.
 */
export const MAX_RULE_SET_CHARS = 1024 * 1024;

/** Read a rule set from text. YAML is a superset of JSON, but a JSON error message is better on JSON. */
export const parseRuleSet = (text: string, options: ParseRuleSetOptions = {}): RuleSetParse => {
  const maxLength = options.maxLength ?? MAX_RULE_SET_CHARS;
  if (text.length > maxLength) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          message: `the document is ${text.length} characters; the limit is ${maxLength} (maxLength)`,
        },
      ],
    };
  }
  const format = options.format ?? 'auto';
  const looksJson = text.trimStart().startsWith('{');
  let document: unknown;

  if (format === 'json' || (format === 'auto' && looksJson)) {
    try {
      document = JSON.parse(text);
    } catch (error) {
      return { ok: false, issues: [{ path: '', message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  } else {
    const counter = new LineCounter();
    try {
      document = parseYaml(text, { lineCounter: counter, maxAliasCount: options.maxAliasCount ?? 20, prettyErrors: true });
    } catch (error) {
      // Every failure from the YAML parser is reported, not only `YAMLParseError`: the alias-budget
      // refusal — the billion-laughs defence — arrives as a plain `ReferenceError`, and a rule set
      // that tried to exhaust the parser must come back as an invalid document rather than as a
      // stack trace escaping into whatever called us.
      const at = error instanceof YAMLParseError ? error.linePos?.[0] : undefined;
      const where = at === undefined ? '' : ` at line ${at.line}, column ${at.col}`;
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      return { ok: false, issues: [{ path: '', message: `not valid YAML${where}: ${message}` }] };
    }
  }

  if (document === null || document === undefined) {
    return { ok: false, issues: [{ path: '', message: 'the document is empty' }] };
  }
  return loadRuleSet(document);
};

/** The throwing form, for callers that would only rethrow. */
export const parseRuleSetOrThrow = (text: string, options: ParseRuleSetOptions = {}): RuleSet => {
  const result = parseRuleSet(text, options);
  if (!result.ok) throw new RuleSetError(result.issues);
  return result.ruleSet;
};
