/**
 * The document this server serves at `/openapi.json`.
 *
 * P6 says the OpenAPI document is the contract, and docs/api.qmd says the document and the
 * implementation "are the same source". Serving `@recueil/schemas`' document unchanged would keep
 * the first half of that promise and break the second, because this server answers two operations
 * the package does not declare — `/api/v1/system/info`, which belongs to the application rather
 * than to the data model, and a `/health` whose body carries the `database` and `storage` objects
 * of `src/health.ts`.
 *
 * `createOpenApiDocument` takes a `paths` object and merges it over its own for exactly this
 * reason, so the served document is the package's document plus what this server actually
 * implements — and the two response schemas below are the same Zod objects the routes validate
 * with, so a change to one cannot miss the other.
 */
import {
  API_BASE_PATH,
  JSON_CONTENT_TYPE,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  createOpenApiDocument,
} from '@recueil/schemas';
import type { OpenApiDocument } from '@recueil/schemas';
import type { ZodOpenApiPathsObject } from 'zod-openapi';

import { ServerHealthResponseSchema } from './health.js';
import { OPENAPI_PATH, SystemInfoSchema } from './system.js';

/** The path items this server adds to, or widens in, the package's document. */
export const serverPaths: ZodOpenApiPathsObject = {
  '/health': {
    get: {
      operationId: 'getHealth',
      summary: 'Service health',
      description:
        'Reports whether the server is serving, which components are up, where the file store is ' +
        'and how large the library is. Unauthenticated, unversioned and cheap: a container health ' +
        'check runs it every thirty seconds.\n\n' +
        'Every number is measured on the way past, so `library` being all zeroes means an empty ' +
        'library and not an unimplemented endpoint — which is the Phase 0 exit criterion ' +
        '(CONCEPT.md §7).',
      tags: ['System'],
      security: [],
      responses: {
        '200': {
          description:
            'The server is serving. `status` may still be `degraded` when an optional component is down.',
          content: { [JSON_CONTENT_TYPE]: { schema: ServerHealthResponseSchema } },
        },
        '503': {
          description:
            'A required component is down. The body is the same health document, so a probe that ' +
            'gets a 503 still learns which component failed.',
          content: { [JSON_CONTENT_TYPE]: { schema: ServerHealthResponseSchema } },
        },
      },
    },
  },
  [`${API_BASE_PATH}/system/info`]: {
    get: {
      operationId: 'getSystemInfo',
      summary: 'Server identity and capabilities',
      description:
        'Release, API version, runtime and the location of the contract document. Static: for ' +
        'liveness use `GET /health`.',
      tags: ['System'],
      security: [],
      responses: {
        '200': {
          description: 'What this server is.',
          content: { [JSON_CONTENT_TYPE]: { schema: SystemInfoSchema } },
        },
        '500': {
          description: 'Something went wrong.',
          content: { [PROBLEM_CONTENT_TYPE]: { schema: ProblemDetailsSchema } },
        },
      },
    },
  },
  [OPENAPI_PATH]: {
    get: {
      operationId: 'getOpenApiDocument',
      summary: 'The OpenAPI 3.1 contract',
      description:
        'The document generated from the Zod schemas this server validates with, including the ' +
        'operations this server adds to the shared contract. Unauthenticated, because a client ' +
        'that cannot read the contract cannot work out how to authenticate.',
      tags: ['System'],
      security: [],
      responses: {
        '200': {
          description: 'The OpenAPI document.',
          content: { [JSON_CONTENT_TYPE]: { schema: { type: 'object', additionalProperties: true } } },
        },
      },
    },
  },
};

export interface BuildOpenApiDocumentOptions {
  /** The release this document describes. */
  readonly version?: string;
  /** Advertised servers. A deployment behind a proxy should pass its public base URL. */
  readonly baseUrl?: string;
}

/** Build the served document. Pure, so it can be generated once at boot and cached. */
export const buildOpenApiDocument = (options: BuildOpenApiDocumentOptions = {}): OpenApiDocument =>
  createOpenApiDocument({
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.baseUrl === undefined
      ? {}
      : { servers: [{ url: options.baseUrl, description: 'This deployment' }] }),
    paths: serverPaths,
  });
