/**
 * Errors as RFC 9457 problem documents.
 *
 * docs/api.qmd promises that every error response in the API is a problem document with a stable
 * `type` URI, and `@recueil/schemas` owns that URI list. This module is the single place where a
 * thrown thing becomes one, which is why there is no `try/catch` in a route handler anywhere in
 * this app: handlers throw, and this decides what the client sees.
 *
 * Three rules:
 *
 * - **`type` is the contract.** Clients switch on it and nothing else, so it comes from
 *   `CORE_PROBLEM_TYPES` and is never composed from prose.
 * - **`traceId` is the request id**, which is also the `x-request-id` response header and the
 *   `reqId` on every log line for that request. An operator given a trace id can find the log line
 *   without asking the user for anything else.
 * - **A 5xx says nothing.** The message of an unexpected error goes to the log at `error`, not into
 *   a response body: it is the one place where a stack trace, a file path or a SQL fragment could
 *   walk out of the process.
 */
import { RecueilError } from '@recueil/core';
import { CORE_PROBLEM_TYPES, PROBLEM_CONTENT_TYPE } from '@recueil/schemas';
import type { ProblemDetails, ProblemError } from '@recueil/schemas';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import { RequestValidationError } from './validate.js';

export { PROBLEM_CONTENT_TYPE };

/**
 * An error a route decided on rather than one a service threw.
 *
 * Authentication, scopes and idempotency-key reuse are properties of the HTTP surface — the
 * services below know nothing about tokens — so they need a carrier of their own that still lands
 * in the one place a thrown thing becomes a problem document.
 */
export class ApiError extends Error {
  readonly type: string;

  readonly status: number;

  readonly title: string;

  readonly errors?: readonly ProblemError[];

  readonly headers?: Readonly<Record<string, string>>;

  constructor(
    type: string,
    status: number,
    title: string,
    message: string,
    options: { errors?: readonly ProblemError[]; headers?: Readonly<Record<string, string>> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.type = type;
    this.status = status;
    this.title = title;
    if (options.errors !== undefined) this.errors = options.errors;
    if (options.headers !== undefined) this.headers = options.headers;
  }
}

/** 401. The `WWW-Authenticate` header is what makes a bare `curl` say something useful. */
export const unauthenticated = (detail: string): ApiError =>
  new ApiError(CORE_PROBLEM_TYPES.unauthenticated, 401, 'Authentication required', detail, {
    headers: { 'www-authenticate': 'Bearer realm="recueil"' },
  });

/** 403, naming the scope that was missing. A client that is told which scope can ask for it. */
export const scopeRequired = (scope: string): ApiError =>
  new ApiError(
    CORE_PROBLEM_TYPES.scopeRequired,
    403,
    'Scope required',
    `This token does not hold the '${scope}' scope.`,
    { errors: [{ path: 'scopes', message: `requires '${scope}'`, code: 'scope_required' }] },
  );

/** 404 for a resource this surface owns rather than one a service resolves. */
export const notFound = (what: string): ApiError =>
  new ApiError(CORE_PROBLEM_TYPES.notFound, 404, 'Not found', what);

/** The problem types the core's own errors map onto. */
const CORE_ERROR_TYPES: Record<string, { type: string; status: number; title: string }> = {
  'recueil:not-found': { type: CORE_PROBLEM_TYPES.notFound, status: 404, title: 'Not found' },
  'recueil:version-conflict': {
    type: CORE_PROBLEM_TYPES.versionConflict,
    status: 412,
    title: 'Version conflict',
  },
  'recueil:conflict': { type: CORE_PROBLEM_TYPES.conflict, status: 409, title: 'Conflict' },
  'recueil:invalid-input': { type: CORE_PROBLEM_TYPES.validation, status: 422, title: 'Invalid input' },
  'recueil:invariant-violated': {
    type: CORE_PROBLEM_TYPES.integrity,
    status: 409,
    title: 'Integrity violation',
  },
};

/** What a plain HTTP status means when nothing more specific is known. */
const STATUS_TYPES: Record<number, { type: string; title: string }> = {
  400: { type: CORE_PROBLEM_TYPES.validation, title: 'Bad request' },
  401: { type: CORE_PROBLEM_TYPES.unauthenticated, title: 'Authentication required' },
  403: { type: CORE_PROBLEM_TYPES.forbidden, title: 'Forbidden' },
  404: { type: CORE_PROBLEM_TYPES.notFound, title: 'Not found' },
  409: { type: CORE_PROBLEM_TYPES.conflict, title: 'Conflict' },
  412: { type: CORE_PROBLEM_TYPES.versionConflict, title: 'Version conflict' },
  415: { type: CORE_PROBLEM_TYPES.validation, title: 'Unsupported media type' },
  422: { type: CORE_PROBLEM_TYPES.validation, title: 'Invalid input' },
  429: { type: CORE_PROBLEM_TYPES.rateLimited, title: 'Too many requests' },
  503: { type: CORE_PROBLEM_TYPES.unavailable, title: 'Service unavailable' },
};

const INTERNAL = { type: CORE_PROBLEM_TYPES.internal, title: 'Internal server error' } as const;

export interface ProblemOptions {
  readonly instance?: string;
  readonly traceId?: string;
  readonly errors?: ProblemError[];
  readonly detail?: string;
}

/** Build a problem document by hand, for the cases a route decides on rather than throws. */
export const problem = (
  type: string,
  status: number,
  title: string,
  options: ProblemOptions = {},
): ProblemDetails => {
  const document: ProblemDetails = { type, title, status };
  if (options.detail !== undefined) document.detail = options.detail;
  if (options.instance !== undefined) document.instance = options.instance;
  if (options.errors !== undefined && options.errors.length > 0) document.errors = options.errors;
  if (options.traceId !== undefined) document.traceId = options.traceId;
  return document;
};

/** Fastify's own validation failures, turned into the field-level `errors` member. */
const validationErrors = (error: FastifyError): ProblemError[] =>
  (error.validation ?? []).map((issue) => ({
    path: (issue.instancePath ?? '').replace(/^\//u, '').replace(/\//gu, '.'),
    message: issue.message ?? 'is not valid',
    ...(issue.keyword ? { code: issue.keyword } : {}),
  }));

/**
 * Turn anything thrown into a problem document.
 *
 * `exposeDetail` is the switch that keeps 5xx bodies empty of internals; it is off unless a caller
 * (a test, or an operator who set the log level to `debug`) asks for it.
 */
export const toProblem = (
  error: unknown,
  options: ProblemOptions & { exposeDetail?: boolean } = {},
): ProblemDetails => {
  const base = { instance: options.instance, traceId: options.traceId };

  if (error instanceof RequestValidationError) {
    return problem(error.type, error.status, 'Invalid input', {
      ...base,
      detail: error.message,
      errors: [...error.errors],
    });
  }

  if (error instanceof ApiError) {
    return problem(error.type, error.status, error.title, {
      ...base,
      detail: error.message,
      ...(error.errors === undefined ? {} : { errors: [...error.errors] }),
    });
  }

  if (error instanceof RecueilError) {
    const mapped = CORE_ERROR_TYPES[error.type];
    if (mapped) {
      return problem(mapped.type, mapped.status, mapped.title, { ...base, detail: error.message });
    }
    return problem(CORE_PROBLEM_TYPES.internal, error.status, INTERNAL.title, {
      ...base,
      detail: error.message,
    });
  }

  const fastifyError = error as FastifyError | undefined;
  const status = Number(fastifyError?.statusCode ?? 500);

  if (fastifyError?.validation && fastifyError.validation.length > 0) {
    return problem(CORE_PROBLEM_TYPES.validation, status >= 400 && status < 500 ? status : 400, 'Invalid input', {
      ...base,
      detail: fastifyError.message,
      errors: validationErrors(fastifyError),
    });
  }

  if (status >= 500 || Number.isNaN(status)) {
    return problem(INTERNAL.type, Number.isNaN(status) ? 500 : status, INTERNAL.title, {
      ...base,
      detail: options.exposeDetail === true && fastifyError?.message ? fastifyError.message : undefined,
    });
  }

  const mapped = STATUS_TYPES[status] ?? {
    type: CORE_PROBLEM_TYPES.validation,
    title: fastifyError?.name ?? 'Request failed',
  };

  return problem(mapped.type, status, mapped.title, { ...base, detail: fastifyError?.message });
};

/** Send a problem document with the right status and content type. */
export const sendProblem = (
  request: FastifyRequest,
  reply: FastifyReply,
  document: ProblemDetails,
): FastifyReply =>
  reply
    .code(document.status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({ ...document, instance: document.instance ?? request.url, traceId: document.traceId ?? request.id });
