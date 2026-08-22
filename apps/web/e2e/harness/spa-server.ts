/**
 * The built SPA, served the way it is deployed: same-origin with the API.
 *
 * In production the Fastify application serves `dist/` itself, so the client uses relative paths
 * and there is no CORS mode, no base URL and no cookie policy that exists only in development
 * (CONCEPT.md §5.15). The server does not serve static files yet, so this stands in for that half:
 * a static handler for `dist/` and a reverse proxy for `/api` and `/health`, on one port. It is
 * deliberately not `vite preview` — the thing under test is the *built bundle* over one origin, and
 * a development server with its own transform pipeline in front of it would be testing something
 * else.
 *
 * The proxy pipes rather than buffers, because the reader fetches a PDF and the content endpoint
 * answers `206 Partial Content` to a range request. Reading the body into memory would work today
 * and stop working the moment a document is large enough to matter.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

import { webDistDirectory } from './paths.js';

export interface SpaServer {
  /** `http://127.0.0.1:<port>` — where the browser goes. */
  readonly url: string;
  readonly stop: () => Promise<void>;
}

/** Paths the API owns. Everything else is the SPA's. */
const isApiPath = (pathname: string): boolean =>
  pathname === '/health' || pathname === '/api' || pathname.startsWith('/api/');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/**
 * Start the origin.
 *
 * @param apiOrigin  where `/api` and `/health` are proxied — the running Recueil server.
 */
export const startSpaServer = async (apiOrigin: string): Promise<SpaServer> => {
  await assertBundleBuilt();
  const api = new URL(apiOrigin);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (isApiPath(url.pathname)) {
      proxy(request, response, api);
      return;
    }
    void serveStatic(url.pathname, response);
  });

  const url = await listen(server);
  return {
    url,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};

const assertBundleBuilt = async (): Promise<void> => {
  try {
    await stat(join(webDistDirectory, 'index.html'));
  } catch {
    throw new Error(
      `No built bundle at ${webDistDirectory}. Run \`pnpm --filter @recueil/web build\` first: the ` +
        'end-to-end suite drives the production bundle, not the development server.',
    );
  }
};

const listen = (server: Server): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('The static server bound to no port.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

const proxy = (request: IncomingMessage, response: ServerResponse, api: URL): void => {
  const upstream = httpRequest(
    {
      protocol: api.protocol,
      hostname: api.hostname,
      port: api.port,
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      // The `host` header must name the upstream, not this proxy, or a server that builds absolute
      // URLs from it builds them wrong.
      headers: { ...request.headers, host: api.host },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on('error', (error: Error) => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`The API proxy failed: ${error.message}`);
  });

  request.pipe(upstream);
};

/**
 * One file from `dist/`, or `index.html`.
 *
 * The fallback is what makes `/reader/<id>` reachable by reload and by deep link — the router is in
 * the browser, and a reload of a client-side route must still be answered with the application.
 * A request that escapes `dist/` is refused rather than resolved: this is a test harness, but a
 * path-traversal hole in a test harness still reads files.
 */
const serveStatic = async (pathname: string, response: ServerResponse): Promise<void> => {
  const decoded = safeJoin(pathname);
  if (decoded !== null) {
    try {
      const stats = await stat(decoded);
      if (stats.isFile()) {
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(decoded)] ?? 'application/octet-stream',
          'content-length': stats.size,
          'cache-control': 'no-store',
        });
        createReadStream(decoded).pipe(response);
        return;
      }
    } catch {
      // Fall through to the SPA entry point.
    }
  }

  const index = join(webDistDirectory, 'index.html');
  const stats = await stat(index);
  response.writeHead(200, {
    'content-type': CONTENT_TYPES['.html'] as string,
    'content-length': stats.size,
    'cache-control': 'no-store',
  });
  createReadStream(index).pipe(response);
};

const safeJoin = (pathname: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const resolved = normalize(join(webDistDirectory, decoded));
  return resolved === webDistDirectory || resolved.startsWith(webDistDirectory + sep) ? resolved : null;
};
