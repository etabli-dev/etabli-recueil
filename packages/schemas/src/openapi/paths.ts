/**
 * The path items of the generated document.
 *
 * Phase 0 ships exactly one operation. That is not a placeholder for its own sake: the Phase 0
 * exit criterion is "`recueil serve` returns health with an empty library" (CONCEPT.md §7), and
 * `/health` is the only endpoint that criterion needs. Every other resource group arrives with the
 * feature that serves it, from Phase 1 onwards — see `phase1Paths` at the foot of this file.
 */
import type { ZodOpenApiPathsObject } from 'zod-openapi';

import { HealthResponseSchema } from '../envelopes/health.js';
import { PROBLEM_CONTENT_TYPE, ProblemDetailsSchema } from '../envelopes/problem.js';

export const JSON_CONTENT_TYPE = 'application/json';

/** Where the versioned resources live. `/health` deliberately does not, so a probe never versions. */
export const API_BASE_PATH = '/api/v1';

/**
 * `GET /health` — unauthenticated, unversioned, cheap.
 *
 * Unauthenticated because a container health check has no token (deploy/docker-compose.yml runs
 * it), and unversioned because a probe that has to know the API version is a probe that breaks on
 * the day the version changes.
 */
export const healthPaths: ZodOpenApiPathsObject = {
  '/health': {
    get: {
      operationId: 'getHealth',
      summary: 'Service health',
      description:
        'Reports whether the server is serving, which components are up, and — as the Phase 0 ' +
        'exit criterion requires — the size of the library, which may legitimately be empty.',
      tags: ['System'],
      security: [],
      responses: {
        '200': {
          description: 'The server is serving. `status` may still be `degraded` if an optional component is down.',
          content: {
            [JSON_CONTENT_TYPE]: { schema: HealthResponseSchema },
          },
        },
        '503': {
          description: 'The server is not serving. The body is a problem document naming the failed component.',
          content: {
            [PROBLEM_CONTENT_TYPE]: { schema: ProblemDetailsSchema },
          },
        },
      },
    },
  },
};

/* ============================================================================================== */
/* EXTENSION POINT — Phase 1 routes                                                                 */
/* ============================================================================================== */
/**
 * Phase 1 adds the library resources: `/api/v1/items`, `/documents`, `/attachments`,
 * `/collections`, `/tags`, `/fields`, `/notes`, `/annotations`, `/creators` (docs/api.qmd,
 * CONCEPT.md §5.12). Add them here, one exported `ZodOpenApiPathsObject` per resource group, and
 * spread them into this object; `createOpenApiDocument` picks them up with no further wiring.
 *
 * The schemas those routes need already exist and are already registered as components — see
 * `src/openapi/components.ts`. Nothing about adding a route should require touching a schema:
 * that separation is what stops the document and the implementation from drifting (P6).
 *
 * Conventions for the routes that land here:
 *
 * - list endpoints take `PageParams` and return the matching `*Page` schema (cursor pagination);
 * - bulk endpoints take the `Idempotency-Key` header and return `BulkResult` (P9, IK2);
 * - every non-2xx response is `application/problem+json` carrying `ProblemDetails` (RFC 9457);
 * - a conditional write carries the item `version` as an ETag and returns 409 on a stale one (P1).
 */
export const phase1Paths: ZodOpenApiPathsObject = {};

/** Every path the document currently declares. */
export const paths: ZodOpenApiPathsObject = {
  ...healthPaths,
  ...phase1Paths,
};
