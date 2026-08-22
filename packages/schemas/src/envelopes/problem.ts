/**
 * Errors as RFC 9457 problem documents (docs/api.qmd, "Conventions").
 *
 * A stable `type` URI, a human `title`, and a `detail` that names the field. The stability of the
 * `type` URI is the contract: clients switch on it, so it is versioned with the API and never
 * reworded, whereas `title` and `detail` are prose and may change.
 */
import * as z from 'zod';

import { IdSchema } from '../primitives.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** The base URI every built-in problem type extends. */
export const PROBLEM_TYPE_BASE = 'https://recueil.org/problems/';

/** The problem types Phase 0 and Phase 1 can raise. Plugins add their own under their own path. */
export const CORE_PROBLEM_TYPES = {
  validation: `${PROBLEM_TYPE_BASE}validation`,
  notFound: `${PROBLEM_TYPE_BASE}not-found`,
  conflict: `${PROBLEM_TYPE_BASE}conflict`,
  versionConflict: `${PROBLEM_TYPE_BASE}version-conflict`,
  unauthenticated: `${PROBLEM_TYPE_BASE}unauthenticated`,
  forbidden: `${PROBLEM_TYPE_BASE}forbidden`,
  scopeRequired: `${PROBLEM_TYPE_BASE}scope-required`,
  rateLimited: `${PROBLEM_TYPE_BASE}rate-limited`,
  idempotencyKeyReused: `${PROBLEM_TYPE_BASE}idempotency-key-reused`,
  fieldLocked: `${PROBLEM_TYPE_BASE}field-locked`,
  integrity: `${PROBLEM_TYPE_BASE}integrity`,
  unavailable: `${PROBLEM_TYPE_BASE}unavailable`,
  internal: `${PROBLEM_TYPE_BASE}internal`,
} as const;

export type CoreProblemType = (typeof CORE_PROBLEM_TYPES)[keyof typeof CORE_PROBLEM_TYPES];

/** One field-level complaint. The path is the JSON pointer-ish path a client can highlight. */
export const ProblemErrorSchema = z
  .strictObject({
    path: z
      .string()
      .max(512)
      .meta({ description: 'Dotted path to the offending value, e.g. `bibliographic.doi` or `creators.0.role`.' }),
    message: z.string().max(1024),
    code: z
      .string()
      .max(64)
      .optional()
      .meta({ description: 'The validator code, e.g. `invalid_format`, so a client can branch without parsing prose.' }),
  })
  .meta({ id: 'ProblemError', title: 'ProblemError' });

export const ProblemDetailsSchema = z
  .strictObject({
    type: z
      .string()
      .max(512)
      .meta({
        description: 'A stable URI identifying the problem type. Clients switch on this and nothing else.',
        examples: [CORE_PROBLEM_TYPES.validation],
      }),
    title: z.string().max(255).meta({ description: 'A short, human-readable summary. Prose: it may be reworded.' }),
    status: z.number().int().min(100).max(599),
    detail: z
      .string()
      .max(4096)
      .optional()
      .meta({ description: 'An explanation of this occurrence, naming the field where there is one.' }),
    instance: z
      .string()
      .max(1024)
      .optional()
      .meta({ description: 'The request path this occurrence relates to.' }),
    errors: z
      .array(ProblemErrorSchema)
      .max(1000)
      .optional()
      .meta({ description: 'Field-level detail for a validation failure. RFC 9457 extension member.' }),
    traceId: z
      .string()
      .max(128)
      .optional()
      .meta({ description: 'Correlates the response with the server log line. RFC 9457 extension member.' }),
    jobId: IdSchema.optional().meta({ description: 'The job this problem came from, where one exists.' }),
    retryAfterSeconds: z.number().int().min(0).optional(),
  })
  .meta({
    id: 'ProblemDetails',
    title: 'ProblemDetails',
    description:
      'An RFC 9457 problem document, served as `application/problem+json`. Every error response ' +
      'in the API has this shape.',
  });

export type ProblemError = z.infer<typeof ProblemErrorSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
