/**
 * The one matcher shape every condition uses, whatever it is matching.
 *
 * A rule author who has learnt `{ contains: "…" }` for a sender has learnt it for a filename, a
 * MIME type and a line of OCR output as well, and the UI needs one form widget rather than eleven.
 * The variants are separate strict objects rather than one object with optional keys, so that
 * "exactly one operator" is expressible in JSON Schema as `anyOf` and the API rejects
 * `{ equals: "a", contains: "b" }` instead of silently preferring one.
 *
 * `matches` is validated here by compiling it with the linear engine (`../regex/index.ts`). An
 * unsupported construct is therefore a validation error on the rule set, with a position in the
 * pattern, rather than a surprise at ingest time.
 */
import * as z from 'zod';

import { RegexSyntaxError, SafeRegex } from '../regex/index.js';
import { globToPattern } from '../glob.js';

const caseSensitive = z
  .boolean()
  .optional()
  .meta({ description: 'Default false: matching ignores case unless a rule asks for it.' });

const PatternTextSchema = z.string().min(1).max(4096);
const MatchTextSchema = z.string().min(1).max(4096);

const EqualsMatcherSchema = z
  .strictObject({ equals: MatchTextSchema, caseSensitive })
  .meta({ id: 'EqualsMatcher', description: 'The whole value, exactly.' });

const EqualsAnyMatcherSchema = z
  .strictObject({ equalsAny: z.array(MatchTextSchema).min(1).max(1000), caseSensitive })
  .meta({ id: 'EqualsAnyMatcher', description: 'The whole value, exactly, against any member of the list.' });

const ContainsMatcherSchema = z.strictObject({ contains: MatchTextSchema, caseSensitive }).meta({ id: 'ContainsMatcher' });

const StartsWithMatcherSchema = z.strictObject({ startsWith: MatchTextSchema, caseSensitive }).meta({ id: 'StartsWithMatcher' });

const EndsWithMatcherSchema = z.strictObject({ endsWith: MatchTextSchema, caseSensitive }).meta({ id: 'EndsWithMatcher' });

const RegexMatcherSchema = z
  .strictObject({
    matches: PatternTextSchema,
    caseSensitive,
    multiline: z
      .boolean()
      .optional()
      .meta({ description: 'Make `^` and `$` match at every line break. Useful against extracted text.' }),
    dotAll: z.boolean().optional().meta({ description: 'Make `.` match a line break as well.' }),
  })
  .check((ctx) => {
    try {
      SafeRegex.compile(ctx.value.matches, { flags: '' });
    } catch (error) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value.matches,
        path: ['matches'],
        message: error instanceof RegexSyntaxError ? error.message : String(error),
      });
    }
  })
  .meta({
    id: 'RegexMatcher',
    description:
      'A regular expression, anywhere in the value. Runs on a linear-time engine: backreferences, ' +
      'lookahead and lookbehind are not available, and no pattern can backtrack.',
  });

const GlobMatcherSchema = z
  .strictObject({ glob: PatternTextSchema, caseSensitive })
  .check((ctx) => {
    try {
      SafeRegex.compile(globToPattern(ctx.value.glob), { flags: '' });
    } catch (error) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value.glob,
        path: ['glob'],
        message: error instanceof RegexSyntaxError ? error.message : String(error),
      });
    }
  })
  .meta({
    id: 'GlobMatcher',
    description: 'A path glob, anchored to the whole value. `*` stays within a segment, `**` crosses them.',
  });

export const MatcherSchema = z
  .union([
    EqualsMatcherSchema,
    EqualsAnyMatcherSchema,
    ContainsMatcherSchema,
    StartsWithMatcherSchema,
    EndsWithMatcherSchema,
    RegexMatcherSchema,
    GlobMatcherSchema,
  ])
  .meta({
    id: 'Matcher',
    description: 'One test against one string. Exactly one operator per matcher.',
  });

export type Matcher = z.infer<typeof MatcherSchema>;
export type RegexMatcher = z.infer<typeof RegexMatcherSchema>;
export type GlobMatcher = z.infer<typeof GlobMatcherSchema>;
