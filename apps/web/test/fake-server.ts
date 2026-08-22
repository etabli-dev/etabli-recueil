/**
 * A hand-written fake server, at the `fetch` boundary.
 *
 * The tests exercise the real `RecueilClient` against this rather than a stubbed client object,
 * because half of what the client does is build the request — the path, the query string, the
 * `If-Match` header, the JSON body — and a fake that replaced the client would test none of it.
 * The recorded requests are what "editing a field issues the right request body" is asserted
 * against.
 *
 * It is hand-written rather than MSW because it needs to be exactly one thing: a routing table and
 * a log. A service worker, a request interceptor and a lifecycle are all more machinery than the
 * question asks for.
 */
import { PROBLEM_CONTENT_TYPE } from '../src/api/problem.js';
import type { ProblemDetails } from '../src/api/problem.js';

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (request: RecordedRequest) => unknown | Promise<unknown>;

/** Thrown by a handler to answer with a problem document instead of a body. */
export class FakeProblem extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.title);
    this.name = 'FakeProblem';
  }
}

export interface FakeServer {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Every request, in order. */
  requests: RecordedRequest[];
  /** The requests to one path, which is usually what an assertion means. */
  requestsTo: (method: string, path: string) => RecordedRequest[];
}

/**
 * Routes are `"<METHOD> <path>"`, matched exactly on the path, with `:param` segments.
 * An unrouted request is a 404 problem document rather than a thrown error, because that is what a
 * real server does and the client has to handle it either way.
 */
export const createFakeServer = (routes: Record<string, Handler>): FakeServer => {
  const requests: RecordedRequest[] = [];
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method = 'GET', pattern = '/'] = key.split(' ');
    return { method: method.toUpperCase(), segments: pattern.split('/'), handler, pattern };
  });

  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();

    const record: RecordedRequest = {
      method,
      url: input,
      path: url.pathname,
      query: url.searchParams,
      headers: normaliseHeaders(init.headers),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    requests.push(record);

    const pathSegments = url.pathname.split('/');
    const route = compiled.find(
      (candidate) =>
        candidate.method === method &&
        candidate.segments.length === pathSegments.length &&
        candidate.segments.every(
          (segment, index) => segment.startsWith(':') || segment === pathSegments[index],
        ),
    );

    if (route === undefined) {
      return problemResponse({
        type: 'https://recueil.org/problems/not-found',
        title: 'Not found',
        status: 404,
        detail: `The fake server has no route for ${method} ${url.pathname}.`,
      });
    }

    try {
      const body = await route.handler(record);
      if (body === undefined) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (cause) {
      if (cause instanceof FakeProblem) return problemResponse(cause.problem);
      throw cause;
    }
  };

  return {
    fetch,
    requests,
    requestsTo: (method, path) =>
      requests.filter((request) => request.method === method.toUpperCase() && request.path === path),
  };
};

const problemResponse = (problem: ProblemDetails): Response =>
  new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE },
  });

const normaliseHeaders = (headers: HeadersInit | undefined): Record<string, string> => {
  const result: Record<string, string> = {};
  if (headers === undefined) return result;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key !== undefined && value !== undefined) result[key.toLowerCase()] = value;
    }
    return result;
  }
  for (const [key, value] of Object.entries(headers)) result[key.toLowerCase()] = value;
  return result;
};
