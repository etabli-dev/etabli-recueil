/**
 * Request validation, with a pointer the client can act on.
 *
 * Every body, every query string and every path parameter on this surface is parsed by the Zod
 * schema `@recueil/schemas` publishes for it, and the *same* schema is what the OpenAPI document
 * declares (P6). That is the whole reason validation lives here rather than in Fastify's JSON-schema
 * compiler: one schema, used twice, cannot drift from itself.
 *
 * A failure becomes an RFC 9457 problem document with the `errors` member filled in, one entry per
 * offending value, each carrying the dotted path `ProblemErrorSchema` promises — `bibliographic.doi`,
 * `creators.0.role`. A client that highlights a field needs the path; a client that logs the error
 * needs the message; neither should have to parse prose.
 */
import { CORE_PROBLEM_TYPES } from '@recueil/schemas';
import type { ProblemError } from '@recueil/schemas';
import * as z from 'zod';

/**
 * A refusal at the boundary.
 *
 * A distinct class rather than a `RecueilError`, because the core's `ValidationError` describes a
 * value the *services* rejected and this describes one that never reached them; only this one can
 * carry per-field detail.
 */
export class RequestValidationError extends Error {
  readonly status = 422 as const;

  readonly type = CORE_PROBLEM_TYPES.validation;

  readonly errors: readonly ProblemError[];

  constructor(message: string, errors: readonly ProblemError[]) {
    super(message);
    this.name = 'RequestValidationError';
    this.errors = errors;
  }
}

/** The dotted path of `ProblemError.path`: `bibliographic.doi`, `creators.0.role`, `''` at the root. */
export const dottedPath = (path: readonly PropertyKey[]): string =>
  path.map((segment) => String(segment)).join('.');

/**
 * Flatten Zod's issue tree into the `errors` member.
 *
 * Two transformations, both because the raw tree points a client at the wrong thing.
 *
 * **An unrecognised key** is reported against the *containing* object, so the pointer is extended
 * with the offending key: `body.titel` rather than `body`.
 *
 * **A union failure** is reported as every branch's complaint at once, and the *summary* is the
 * useless string "Invalid input". A rule condition is a twelve-way union of strict objects and an
 * ingestion source config is a three-way one, so without this a mistyped rule comes back as
 * `body.when Invalid input` and the author has nothing to act on. The branch with the fewest issues
 * is near enough always the one they meant, so that branch is reported and the rest are dropped —
 * the same choice `@recueil/rules` makes for its own parser, for the same reason.
 */
const problemErrors = (
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = [],
): ProblemError[] =>
  issues.flatMap((issue) => {
    const here = [...prefix, ...issue.path];

    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      const closest = issue.errors.reduce(
        (best, branch) => (branch.length < best.length ? branch : best),
        issue.errors[0] as readonly z.core.$ZodIssue[],
      );
      return problemErrors(closest, here);
    }

    const path =
      issue.code === 'unrecognized_keys' && issue.keys.length > 0
        ? dottedPath([...here, issue.keys[0] as string])
        : dottedPath(here);
    return [{ path, message: issue.message, code: issue.code }];
  });

/**
 * Parse a value, or throw a `RequestValidationError`.
 *
 * `where` names the part of the request being parsed and is prepended to every path, so a client
 * told `query.limit` knows to look at the query string rather than at the body.
 */
export const parseOrThrow = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  where: 'body' | 'query' | 'path' | 'headers' | '' = '',
): z.output<TSchema> => {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const errors = problemErrors(result.error.issues).map((entry) => ({
    ...entry,
    path: where === '' ? entry.path : entry.path === '' ? where : `${where}.${entry.path}`,
  }));

  const first = errors[0];
  throw new RequestValidationError(
    first === undefined
      ? 'The request is not valid.'
      : `${first.path === '' ? 'The request' : first.path} ${first.message}`,
    errors,
  );
};

/** One complaint, hand-made, for a rule no schema expresses. */
export const refuse = (path: string, message: string, code = 'custom'): never => {
  throw new RequestValidationError(`${path} ${message}`, [{ path, message, code }]);
};

/**
 * Query strings are strings.
 *
 * Fastify hands over `{ limit: '50' }`, and the contract's `PageParams` wants a number. Rather than
 * loosening the published schema to accept strings — which would make the OpenAPI document describe
 * a shape no sensible client sends — the coercion happens here, once, in front of it.
 */
export const coerceQuery = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = typeof raw === 'string' ? coerceScalar(raw) : raw;
  }
  return out;
};

const coerceScalar = (raw: string): unknown => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Only a bare integer or decimal, and only when the round trip is exact: '007' and '1e3' stay
  // strings, because a caller who wrote them meant a string.
  if (/^-?\d+(?:\.\d+)?$/u.test(raw) && String(Number(raw)) === raw) return Number(raw);
  return raw;
};
