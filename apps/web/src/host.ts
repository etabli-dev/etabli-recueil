/**
 * The embedding host, when this bundle runs inside one.
 *
 * In a browser the client talks to its own origin: a deployment serves `dist/` and proxies the API
 * on the same origin, and development does the same through Vite's proxy, so the base URL is empty
 * and there is nothing to configure. A shell that serves this bundle from an origin of its own —
 * the desktop application in `apps/desktop` — cannot rely on that, because its origin is not the
 * server's. Such a shell defines `globalThis.recueilHost` before the entry module runs, and the
 * client is built from the connection it answers.
 *
 * The contract is deliberately one asynchronous question, answered with a base URL and an optional
 * bearer token. Where the address is stored and which credential store holds the token stay on the
 * shell's side of the line; the client is still a client of the REST contract and nothing else (P6).
 */
import type { RecueilClientOptions } from './api/client.js';

export interface HostConnection {
  /** The server's base URL: `http://127.0.0.1:3000`, or `https://example.org/recueil` behind a proxy. */
  readonly baseUrl: string;
  /** A scoped API token, when the server requires one. */
  readonly token?: string;
}

export interface RecueilHost {
  connection(): Promise<HostConnection>;
}

/** The host, if one has been installed in `scope`. Anything that is not shaped like one is ignored. */
export const embeddingHost = (scope: object = globalThis): RecueilHost | undefined => {
  const candidate: unknown = (scope as { recueilHost?: unknown }).recueilHost;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  if (typeof (candidate as { connection?: unknown }).connection !== 'function') return undefined;
  return candidate as RecueilHost;
};

/** The client options for a host's answer. A trailing slash is dropped: paths start with one. */
export const clientOptionsFor = (connection: HostConnection): RecueilClientOptions => ({
  baseUrl: connection.baseUrl.replace(/\/+$/u, ''),
  ...(connection.token === undefined || connection.token === '' ? {} : { token: connection.token }),
});
