/**
 * Errors, as the client sees them.
 *
 * docs/api.qmd promises that every error response is an RFC 9457 problem document, and
 * `apps/server/src/problem.ts` is the single place that makes one. This module is its mirror: the
 * single place that turns a response back into something the interface can display, so that no
 * component ever inspects a status code or reads `response.statusText`.
 *
 * Two rules follow from the server's own:
 *
 * - **`type` is the contract.** Branching happens on `problem.type` against `CORE_PROBLEM_TYPES`,
 *   never on prose, and never on the status alone.
 * - **A failure that is not a problem document is still a problem document.** A proxy 502 with an
 *   HTML body, a dropped connection, a JSON body that does not parse — each is normalised here
 *   into the same shape, because an error state that can only render one of the two kinds of
 *   failure is an error state that shows a blank screen on the other.
 */
import type { ProblemDetails, ProblemError } from '@recueil/schemas';

export type { ProblemDetails, ProblemError };

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * The stable problem-type URIs, restated.
 *
 * `@recueil/schemas` exports these as `CORE_PROBLEM_TYPES`, and importing them would be the obvious
 * thing to do — except that the module they live in builds Zod schemas at load time, so importing
 * two string constants from it drags a quarter of a megabyte of schema machinery into a browser
 * bundle that never validates anything. Restating them is the lesser evil, and it is only safe
 * because `test/contract.test.ts` imports the real table and asserts that this one equals it: the
 * two cannot drift without the test suite saying so.
 */
export const CORE_PROBLEM_TYPES = {
  validation: 'https://recueil.org/problems/validation',
  notFound: 'https://recueil.org/problems/not-found',
  conflict: 'https://recueil.org/problems/conflict',
  versionConflict: 'https://recueil.org/problems/version-conflict',
  unauthenticated: 'https://recueil.org/problems/unauthenticated',
  forbidden: 'https://recueil.org/problems/forbidden',
  scopeRequired: 'https://recueil.org/problems/scope-required',
  rateLimited: 'https://recueil.org/problems/rate-limited',
  idempotencyKeyReused: 'https://recueil.org/problems/idempotency-key-reused',
  fieldLocked: 'https://recueil.org/problems/field-locked',
  integrity: 'https://recueil.org/problems/integrity',
  unavailable: 'https://recueil.org/problems/unavailable',
  internal: 'https://recueil.org/problems/internal',
} as const;

/** The problem type used when the failure never reached the server at all. */
export const TRANSPORT_PROBLEM_TYPE = 'https://recueil.org/problems/transport';

/**
 * A failed request. Carries the whole problem document rather than a message, because the item
 * pane wants `errors[]` to highlight a field and the error banner wants `traceId` to quote.
 */
export class ApiError extends Error {
  readonly problem: ProblemDetails;

  readonly request: { method: string; url: string };

  constructor(problem: ProblemDetails, request: { method: string; url: string }) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.problem = problem;
    this.request = request;
  }

  get status(): number {
    return this.problem.status;
  }

  get type(): string {
    return this.problem.type;
  }

  /** True when the server refused the write because a manual lock holds the field (P4-2). */
  get isFieldLocked(): boolean {
    return this.problem.type === CORE_PROBLEM_TYPES.fieldLocked;
  }

  /** True when the item moved under us and the conditional write was rejected rather than merged (P1). */
  get isVersionConflict(): boolean {
    return this.problem.type === CORE_PROBLEM_TYPES.versionConflict;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

/** A structurally valid problem document, or `null`. Nothing here trusts the body's shape. */
export const parseProblemDocument = (body: unknown): ProblemDetails | null => {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.type !== 'string') return null;
  if (typeof candidate.title !== 'string') return null;
  if (typeof candidate.status !== 'number') return null;
  const problem: ProblemDetails = {
    type: candidate.type,
    title: candidate.title,
    status: candidate.status,
  };
  if (typeof candidate.detail === 'string') problem.detail = candidate.detail;
  if (typeof candidate.instance === 'string') problem.instance = candidate.instance;
  if (typeof candidate.traceId === 'string') problem.traceId = candidate.traceId;
  if (typeof candidate.jobId === 'string') problem.jobId = candidate.jobId;
  if (typeof candidate.retryAfterSeconds === 'number') {
    problem.retryAfterSeconds = candidate.retryAfterSeconds;
  }
  if (Array.isArray(candidate.errors)) {
    const errors = candidate.errors.filter(isProblemError);
    if (errors.length > 0) problem.errors = errors;
  }
  return problem;
};

const isProblemError = (value: unknown): value is ProblemError => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === 'string' && typeof candidate.message === 'string';
};

/** What a bare status means when the server sent no problem document. */
const STATUS_FALLBACKS: Record<number, { type: string; title: string }> = {
  400: { type: CORE_PROBLEM_TYPES.validation, title: 'Bad request' },
  401: { type: CORE_PROBLEM_TYPES.unauthenticated, title: 'Authentication required' },
  403: { type: CORE_PROBLEM_TYPES.forbidden, title: 'Forbidden' },
  404: { type: CORE_PROBLEM_TYPES.notFound, title: 'Not found' },
  409: { type: CORE_PROBLEM_TYPES.conflict, title: 'Conflict' },
  412: { type: CORE_PROBLEM_TYPES.versionConflict, title: 'Version conflict' },
  422: { type: CORE_PROBLEM_TYPES.validation, title: 'Invalid input' },
  429: { type: CORE_PROBLEM_TYPES.rateLimited, title: 'Too many requests' },
  503: { type: CORE_PROBLEM_TYPES.unavailable, title: 'Service unavailable' },
};

export const problemFromStatus = (status: number, detail?: string): ProblemDetails => {
  const fallback = STATUS_FALLBACKS[status] ?? {
    type: CORE_PROBLEM_TYPES.internal,
    title: status >= 500 ? 'Server error' : 'Request failed',
  };
  const problem: ProblemDetails = { type: fallback.type, title: fallback.title, status };
  if (detail !== undefined && detail !== '') problem.detail = detail;
  return problem;
};

/**
 * The transport failed: no response, no status, nothing to switch on. Reported as a 0-status
 * problem so that the error state has exactly one shape to render.
 */
export const problemFromTransportFailure = (cause: unknown): ProblemDetails => ({
  type: TRANSPORT_PROBLEM_TYPE,
  title: 'Could not reach the server',
  status: 0,
  detail:
    cause instanceof Error && cause.message !== ''
      ? cause.message
      : 'The request did not complete. The server may be down, or the connection may have dropped.',
});
