/**
 * Small builders for the OpenAPI path items each route module declares.
 *
 * Every route in `routes/` exports two things: the Fastify plugin that serves it and the
 * `ZodOpenApiPathsObject` that describes it. Keeping them in the same file is what makes the
 * contract hard to forget — you cannot add a handler without the empty space beside it being
 * obvious — and `test/openapi.test.ts` closes the loop by walking Fastify's own route table and
 * failing on anything the document does not declare.
 *
 * These helpers exist so that the description is short enough to be worth writing. Without them a
 * single operation is thirty lines of nesting, and thirty lines of nesting is how a contract ends
 * up describing the endpoint somebody meant to write.
 */
import {
  IdSchema,
  JSON_CONTENT_TYPE,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  PublicIdSchema,
} from '@recueil/schemas';
import type { ZodOpenApiOperationObject, ZodOpenApiResponsesObject } from 'zod-openapi';
import * as z from 'zod';

export { JSON_CONTENT_TYPE, PROBLEM_CONTENT_TYPE };

/** A 2xx response carrying JSON. */
export const jsonResponse = (description: string, schema: z.ZodType) => ({
  description,
  content: { [JSON_CONTENT_TYPE]: { schema } },
});

/** A response with no body: 204, and 304 on the cacheable endpoints. */
export const emptyResponse = (description: string) => ({ description });

/** One problem response. Every non-2xx on this surface is RFC 9457 (docs/api.qmd). */
export const problemResponse = (description: string) => ({
  description,
  content: { [PROBLEM_CONTENT_TYPE]: { schema: ProblemDetailsSchema } },
});

/** The standard prose for the statuses this surface raises, so it is worded once. */
const PROBLEM_DESCRIPTIONS: Record<string, string> = {
  '304': 'The representation you hold is current.',
  '400': 'The request could not be understood — a malformed header or an unparseable body.',
  '401': 'No usable credential was presented.',
  '403': 'The token does not hold the scope this operation requires.',
  '404': 'No such record, or it is in the trash and you did not ask for trashed records.',
  '409': 'The write is refused by a uniqueness rule, a state rule or a data-model invariant.',
  '412': 'The `If-Match` version is stale. Re-read and retry; nothing was merged (P1).',
  '415': 'The request body is not in a media type this operation accepts.',
  '416': 'The requested byte range lies outside the document.',
  '422': 'The request is well-formed and its content is not valid. `errors` names each field.',
  '503': 'A required component is unavailable.',
};

/** Attach the standard problem responses for the statuses an operation can raise. */
export const problems = (...statuses: readonly (keyof typeof PROBLEM_DESCRIPTIONS)[]): ZodOpenApiResponsesObject =>
  Object.fromEntries(
    statuses.map((status) => [
      status,
      status === '304'
        ? emptyResponse(PROBLEM_DESCRIPTIONS[status] as string)
        : problemResponse(PROBLEM_DESCRIPTIONS[status] as string),
    ]),
  ) as ZodOpenApiResponsesObject;

/** A JSON request body. */
export const jsonBody = (schema: z.ZodType, description?: string) => ({
  required: true,
  ...(description === undefined ? {} : { description }),
  content: { [JSON_CONTENT_TYPE]: { schema } },
});

/** The `{id}` path parameter every single-record route takes. */
export const idPath = (name = 'id', description = 'The record id (a ULID).') =>
  z.object({ [name]: IdSchema.meta({ description }) });

/** `{key}` for the routes addressed by the eight-character public key (`spec/data-model.md` §1.3). */
export const publicIdPath = (name = 'key') =>
  z.object({ [name]: PublicIdSchema.meta({ description: 'The eight-character public key.' }) });

/**
 * Assemble an operation.
 *
 * A thin wrapper, but it makes `tags` and `security` impossible to forget: an operation with no tag
 * disappears from every generated client's grouping, and one with no scope in its description is
 * one a caller cannot get a token for.
 */
export const operation = (input: {
  operationId: string;
  summary: string;
  description: string;
  tags: readonly string[];
  scope?: string;
  requestParams?: ZodOpenApiOperationObject['requestParams'];
  requestBody?: ZodOpenApiOperationObject['requestBody'];
  responses: ZodOpenApiResponsesObject;
  /** Unauthenticated on purpose: `/health`, the contract, the connector handshake. */
  security?: ZodOpenApiOperationObject['security'];
}): ZodOpenApiOperationObject => ({
  operationId: input.operationId,
  summary: input.summary,
  description:
    input.scope === undefined
      ? input.description
      : `${input.description}\n\n**Scope:** \`${input.scope}\`.`,
  tags: [...input.tags],
  ...(input.security === undefined ? {} : { security: input.security }),
  ...(input.requestParams === undefined ? {} : { requestParams: input.requestParams }),
  ...(input.requestBody === undefined ? {} : { requestBody: input.requestBody }),
  responses: input.responses,
});

/**
 * The query parameters every cursor-paged list accepts.
 *
 * Declared as a plain object rather than by reusing `PageParamsSchema`, because a component
 * registered once and referenced from thirty operations renders as a `$ref` to an object, and
 * OpenAPI wants the individual parameters spelled out where they are used.
 */
export const pageQuery = {
  cursor: z
    .string()
    .max(2048)
    .optional()
    .meta({ description: 'Opaque continuation token from the previous page. Never construct one.' }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .meta({ description: 'Page size, 1 to 200. Defaults to 25.' }),
  order: z.enum(['asc', 'desc']).optional().meta({ description: 'Sort direction. Defaults to `desc`.' }),
} as const;

/** `?includeTrashed=true` — the trash is not the library, so it is opt-in everywhere (P5). */
export const includeTrashedQuery = {
  includeTrashed: z.coerce
    .boolean()
    .optional()
    .meta({ description: 'Include trashed records. Off by default: the trash is not the library (P5).' }),
} as const;
