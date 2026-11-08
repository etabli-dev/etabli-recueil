/**
 * What the connection page says about a probe result.
 *
 * Kept apart from the page so that every outcome's wording — and in particular the one exact
 * setting a user has to change — is checked by a test rather than by looking at a window.
 */
import type { ProbeResult } from './probe.js';

export interface Diagnosis {
  tone: 'ok' | 'warning' | 'error';
  title: string;
  /** Plain sentences. */
  detail: string;
  /** A command or setting to copy, when there is one. */
  code?: string;
}

/**
 * The origin the server has to allow: `tauri://localhost` on Linux and macOS, `http://tauri.localhost`
 * on Windows. Built from the protocol and host because `location.origin` is `"null"` for a custom
 * scheme in some engines, and `"null"` is not something to tell anyone to put in a configuration.
 */
export const shellOrigin = (location: Pick<Location, 'protocol' | 'host'>): string =>
  `${location.protocol}//${location.host}`;

/** How to start a server from a source checkout so that this window may talk to it. */
export const localServerCommand = (origin: string): string =>
  `RECUEIL_CORS_ORIGIN=${origin} node apps/cli/dist/index.js serve --host 127.0.0.1 --port 3000`;

export const diagnose = (result: ProbeResult, serverUrl: string, origin: string): Diagnosis => {
  switch (result.kind) {
    case 'connected':
      return {
        tone: result.status === 'ok' ? 'ok' : 'warning',
        title: `Connected to Recueil ${result.version}`,
        detail:
          result.status === 'ok'
            ? `${serverUrl} answers and accepts this application.`
            : `${serverUrl} answers, but reports itself degraded: an optional component is not working. The library is usable.`,
      };
    case 'unreachable':
      return {
        tone: 'error',
        title: 'No Recueil server is reachable',
        detail:
          `Nothing answered at ${serverUrl}. Recueil keeps the library on a server and this window is a client of it. ` +
          'Start a server on this computer — from a source checkout, after pnpm install and pnpm build, with the command below — ' +
          'or enter the address of the server you use. A desktop application that starts its own server is planned (docs/platform-roadmap.md).',
        code: localServerCommand(origin),
      };
    case 'cors-refused':
      return {
        tone: 'error',
        title: 'The server does not allow this application',
        detail:
          `Something answered at ${serverUrl}, but it does not accept requests from this window's origin, ${origin}. ` +
          'Add the origin to RECUEIL_CORS_ORIGIN on the server (a comma-separated list) and restart it.',
        code: `RECUEIL_CORS_ORIGIN=${origin}`,
      };
    case 'not-recueil':
      return {
        tone: 'error',
        title: 'That is not a Recueil server',
        detail: `${serverUrl}/health answered with HTTP ${result.httpStatus}, but not with Recueil's health document. Check the address, including any path a reverse proxy adds.`,
      };
    case 'unhealthy':
      return {
        tone: 'error',
        title: 'The server is not healthy',
        detail: `Recueil ${result.version} at ${serverUrl} reports an error in its database or storage. Its log says which.`,
      };
    case 'token-required':
      return {
        tone: 'warning',
        title: 'The server requires an API token',
        detail:
          'It runs with RECUEIL_REQUIRE_AUTH=true. Create a token through its token API (POST /api/v1/tokens, as deploy/README.md describes) and enter the secret below; it is kept in the system credential store, not in a file.',
      };
    case 'token-refused':
      return {
        tone: 'error',
        title: 'The server refused the token',
        detail:
          result.httpStatus === 403
            ? 'The token is valid but lacks the scope to read the library.'
            : 'The token is unknown to the server, expired or revoked.',
      };
    case 'api-error':
      return {
        tone: 'error',
        title: 'The server answered with an error',
        detail: `GET /api/v1/items answered HTTP ${result.httpStatus}. The server log has the request id.`,
      };
  }
};
