/**
 * `buildApp` — the Fastify application, assembled from dependencies it is handed.
 *
 * Nothing in here opens a database, reads the environment or listens on a port. That is
 * `server.ts`'s job, and the separation is what makes the whole surface testable through
 * `fastify.inject()` with no sockets and no clean-up: a test builds a library in a temporary
 * directory, hands it to this function, and asks the returned instance questions.
 *
 * What the application guarantees, in the order the request meets it:
 *
 * 1. **Every request has an id.** An inbound `x-request-id` is honoured — a reverse proxy or a
 *    client-side retry has usually already assigned one — and otherwise a ULID is minted with the
 *    same generator the data model uses. It goes on every log line for the request, into the
 *    `traceId` of any problem document, and back out as a response header, so a user's screenshot
 *    of an error is enough to find the log line.
 * 2. **Structured logs.** JSON on stdout at the configured level (docs/self-hosting.qmd), with the
 *    `authorization` and `cookie` headers redacted. Tokens must not reach the log: the log is the
 *    artefact most likely to be pasted into a bug report.
 * 3. **CORS, off by default.** A single-user server serves its own UI from its own origin and needs
 *    no cross-origin access at all. `RECUEIL_CORS_ORIGIN` turns it on, per origin.
 * 4. **RFC 9457 for every error**, including 404s and Fastify's own — see `problem.ts`.
 * 5. **A shutdown that finishes what it started.** The `onClose` hook closes the library after
 *    Fastify has drained in-flight requests, so a `SIGTERM` during a write does not close the
 *    database out from under it.
 */
import { newId } from '@recueil/core';
import type { Recueil } from '@recueil/core';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify';

import type { ServerConfig } from './config.js';
import { ensureStoragePath } from './health.js';
import { sendProblem, toProblem } from './problem.js';
import { healthRoutes } from './routes/health.js';
import { openApiRoutes } from './routes/openapi.js';
import { systemRoutes } from './routes/system.js';
import { resolveVersion } from './version.js';

/**
 * Everything a route needs, under one decorator.
 *
 * One rather than four, because a Fastify instance is a shared namespace: `version` is already
 * Fastify's own, and every further decorator is a name a plugin cannot then use. `app.recueil` is
 * the only name this application claims.
 */
export interface RecueilContext {
  /** The parsed environment this instance was built with. */
  readonly config: ServerConfig;
  /** The open library: the database, the store and the services (`@recueil/core`). */
  readonly library: Recueil;
  /** The release string reported by `/health` and `/api/v1/system/info`. */
  readonly version: string;
  /** When this instance was built, which is what `uptimeSeconds` counts from. */
  readonly startedAt: Date;
}

declare module 'fastify' {
  interface FastifyInstance {
    readonly recueil: RecueilContext;
  }
}

/** The maximum JSON body Phase 0 accepts. Uploads are multipart and arrive with Phase 1. */
const DEFAULT_BODY_LIMIT = 1_048_576;

export interface BuildAppDeps {
  readonly config: ServerConfig;
  /** An open library. `buildApp` never opens one, so the caller decides its lifetime. */
  readonly recueil: Recueil;
  /** Overrides `RECUEIL_VERSION` and the package version. */
  readonly version?: string;
  /** Overrides the boot time, for a test that wants a predictable uptime. */
  readonly startedAt?: Date;
  /**
   * Close the library when the application closes. False by default: whoever opened it owns it, and
   * a test that closes its own library should not have it closed twice.
   */
  readonly closeLibraryOnShutdown?: boolean;
  /** Extra Fastify options, merged last. Escape hatch for the desktop sidecar and for tests. */
  readonly fastify?: FastifyServerOptions;
}

export const buildApp = (deps: BuildAppDeps): FastifyInstance => {
  const { config, recueil } = deps;
  const version = resolveVersion(deps.version);
  const startedAt = deps.startedAt ?? new Date();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // ISO-8601 rather than epoch milliseconds: these logs are read by a person tailing a
      // container far more often than they are read by a log shipper.
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (request: { method: string; url: string; id: string }) => ({
          method: request.method,
          url: request.url,
          id: request.id,
        }),
      },
    },
    // A ULID, so a request id sorts by time like every other id in the system (§1.3).
    genReqId: (request) => {
      const inbound = request.headers['x-request-id'];
      const supplied = Array.isArray(inbound) ? inbound[0] : inbound;
      return supplied !== undefined && supplied.length > 0 && supplied.length <= 128
        ? supplied
        : newId();
    },
    requestIdHeader: false,
    trustProxy: config.trustProxy,
    bodyLimit: DEFAULT_BODY_LIMIT,
    // A trailing slash is the same resource. Under `routerOptions` because the top-level form is
    // deprecated in Fastify 5 and goes away in 6.
    routerOptions: { ignoreTrailingSlash: true },
    ...deps.fastify,
  });

  app.decorate('recueil', { config, library: recueil, version, startedAt } satisfies RecueilContext);

  app.register(sensible);
  app.register(cors, {
    origin: config.corsOrigin,
    credentials: config.corsOrigin !== true && config.corsOrigin !== false,
    exposedHeaders: ['x-request-id'],
  });

  // Echo the request id on every response, success or failure.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('x-request-id')) reply.header('x-request-id', request.id);
    return payload;
  });

  /**
   * Unknown route. It is a problem document like everything else, because a client that has to
   * parse two error formats will parse one of them wrong.
   */
  app.setNotFoundHandler((request, reply) =>
    sendProblem(
      request,
      reply,
      toProblem({ statusCode: 404, message: `No route for ${request.method} ${request.url}.` }, {
        instance: request.url,
        traceId: request.id,
      }),
    ),
  );

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = Number(error.statusCode ?? 500);

    // 5xx is a bug or an outage and belongs in the log with its stack; 4xx is the client being
    // told something and belongs at `warn` at most.
    if (status >= 500 || Number.isNaN(status)) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.warn({ err: error, statusCode: status }, 'request refused');
    }

    return sendProblem(
      request,
      reply,
      toProblem(error, {
        instance: request.url,
        traceId: request.id,
        exposeDetail: config.logLevel === 'debug' || config.logLevel === 'trace',
      }),
    );
  });

  app.register(healthRoutes);
  app.register(systemRoutes);
  app.register(openApiRoutes);

  // The store root is created when the application becomes ready rather than in a probe: a health
  // check should observe, not repair, and a first run should not report `degraded` until somebody
  // happens to upload a file.
  app.addHook('onReady', async () => {
    if (recueil.storage.backend !== 'local') return;
    try {
      await ensureStoragePath(config.storagePath);
    } catch (error) {
      app.log.error({ err: error, path: config.storagePath }, 'cannot create the storage root');
    }
  });

  app.addHook('onClose', async (instance) => {
    instance.log.info('closing the library');
    if (deps.closeLibraryOnShutdown === true) recueil.close();
  });

  return app;
};
