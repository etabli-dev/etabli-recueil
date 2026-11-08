/**
 * Asking an address whether it is a Recueil server this window can use.
 *
 * The window's origin is the shell's own (`tauri://localhost`, or `http://tauri.localhost` on
 * Windows), not the server's, so every request to the server is cross-origin and the server has to
 * allow this origin (`RECUEIL_CORS_ORIGIN`). From inside the page a refused cross-origin request and
 * an absent server fail identically — both are a `TypeError` with no detail, by design of the
 * platform — so the probe asks twice: a normal request first and, when that fails, an opaque
 * `no-cors` one, which succeeds whenever something answered at all. That is the difference between
 * "start a server" and "allow this application on the server you have", and it is the difference
 * the first-run page most needs to explain.
 *
 * `/health` is public, so it cannot tell whether a token is needed or accepted. The second request,
 * one item from `/api/v1/items`, is the cheapest call that can.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ProbeResult =
  | { kind: 'connected'; version: string; status: 'ok' | 'degraded' }
  | { kind: 'unreachable' }
  | { kind: 'cors-refused' }
  | { kind: 'not-recueil'; httpStatus: number }
  | { kind: 'unhealthy'; version: string }
  | { kind: 'token-required' }
  | { kind: 'token-refused'; httpStatus: number }
  | { kind: 'api-error'; httpStatus: number };

export interface ProbeOptions {
  /** The token to try. Absent means "as an unauthenticated client". */
  token?: string;
  fetch?: FetchLike;
  /** Per request. A loopback server answers in milliseconds; this bounds a dead remote one. */
  timeoutMs?: number;
}

interface HealthBody {
  name: 'recueil';
  status: 'ok' | 'degraded' | 'error';
  version: string;
  apiVersion: string;
}

/** The fields of `HealthResponse` (`@recueil/schemas`) the probe relies on, and no more. */
export const isRecueilHealth = (body: unknown): body is HealthBody => {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return (
    candidate.name === 'recueil' &&
    typeof candidate.version === 'string' &&
    typeof candidate.apiVersion === 'string' &&
    (candidate.status === 'ok' || candidate.status === 'degraded' || candidate.status === 'error')
  );
};

const DEFAULT_TIMEOUT_MS = 5_000;

export const probeServer = async (baseUrl: string, options: ProbeOptions = {}): Promise<ProbeResult> => {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const healthUrl = `${baseUrl}/health`;

  let health: Response;
  try {
    health = await doFetch(healthUrl, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    try {
      await doFetch(healthUrl, {
        mode: 'no-cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { kind: 'cors-refused' };
    } catch {
      return { kind: 'unreachable' };
    }
  }

  const body: unknown = await health.json().catch(() => null);
  if (!isRecueilHealth(body)) return { kind: 'not-recueil', httpStatus: health.status };
  if (body.status === 'error') return { kind: 'unhealthy', version: body.version };

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token !== undefined && options.token !== '') headers.authorization = `Bearer ${options.token}`;

  let items: Response;
  try {
    items = await doFetch(`${baseUrl}/api/v1/items?limit=1`, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // `/health` answered a moment ago, so this is the preflight a token header triggers being
    // refused, or the server going away between the two requests.
    return { kind: 'cors-refused' };
  }

  if (items.status === 401) {
    return headers.authorization === undefined
      ? { kind: 'token-required' }
      : { kind: 'token-refused', httpStatus: 401 };
  }
  if (items.status === 403) return { kind: 'token-refused', httpStatus: 403 };
  if (!items.ok) return { kind: 'api-error', httpStatus: items.status };
  return { kind: 'connected', version: body.version, status: body.status };
};
