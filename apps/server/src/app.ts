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
import { ensureIngestSchema } from '@recueil/ingest';
import type { Recueil } from '@recueil/core';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify';

import { authPlugin } from './auth.js';
import type { ServerConfig } from './config.js';
import { EventBus } from './events.js';
import { ensureStoragePath } from './health.js';
import { ensureIngestionConfigSchema } from './ingestion/install.js';
import { QueueService } from './ingestion/queue.js';
import { ReviewService } from './ingestion/review.js';
import { RuleStore } from './ingestion/rules-store.js';
import { IngestionRunner } from './ingestion/runner.js';
import { SecretBox } from './ingestion/secrets.js';
import { IngestionSourceService } from './ingestion/sources.js';
import { StorageBackendService } from './ingestion/storage.js';
import { ApiError, sendProblem, toProblem } from './problem.js';
import { apiRoutes } from './routes/index.js';
import { ANNOUNCED_ZOTERO_VERSION } from './routes/connector.js';
import { healthRoutes } from './routes/health.js';
import { openApiRoutes } from './routes/openapi.js';
import { systemRoutes } from './routes/system.js';
import { TokenService } from './tokens.js';
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
  /** Scoped API tokens: minting, hashing at rest, verification (`spec/data-model.md` §3.2). */
  readonly tokens: TokenService;
  /** The lifecycle event bus behind `GET /api/v1/events` (`spec/hooks.md` §7). */
  readonly events: EventBus;
  /** Phase 2: the configured sources, the queue, the review queue, the rules and the backends. */
  readonly ingestion: IngestionContext;
}

/** Everything `/api/v1/ingestion`, `/api/v1/rules` and `/api/v1/storage` are served from. */
export interface IngestionContext {
  readonly sources: IngestionSourceService;
  readonly queue: QueueService;
  readonly review: ReviewService;
  readonly rules: RuleStore;
  readonly storage: StorageBackendService;
  readonly runner: IngestionRunner;
  /** False when no `RECUEIL_SECRET_KEY` is configured: a credential cannot then be stored. */
  readonly secretsAvailable: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    readonly recueil: RecueilContext;
  }
}

/**
 * The maximum JSON body.
 *
 * Sixteen megabytes rather than Fastify's one, because a bulk create of a thousand items with
 * abstracts is a legitimate request on this API (`BULK_MAX_OPERATIONS` is 1000) and a Zotero
 * import posts exactly that. File bytes never travel as JSON — they are multipart, and bounded
 * separately by `RECUEIL_MAX_UPLOAD_BYTES`.
 */
const DEFAULT_BODY_LIMIT = 16 * 1_048_576;

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
  /**
   * The `fetch` the WebDAV source and the WebDAV storage backend use.
   *
   * Injected so a test can point a connection check at an in-process fake server without a socket
   * or a container. Production leaves it unset and the global `fetch` is used.
   */
  readonly fetch?: typeof fetch;
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

  const events = new EventBus((error, envelope) => {
    app.log.error({ err: error, event: envelope.type }, 'an event subscriber threw');
  });
  const tokens = new TokenService(recueil.db, recueil.audit, recueil.user.id);

  // The Phase 2 configuration tables are installed here rather than in a migration, for the reason
  // `ingestion/install.ts` gives: they are not in `spec/data-model.md` and core's migration series
  // is not this package's to extend. Idempotent, so a restart is free.
  ensureIngestionConfigSchema(recueil.connection);
  // `review_queue` and `ingest_checkpoints` belong to `@recueil/ingest`, which installs them from
  // its own DDL. Calling it here means the review endpoints work before the first ingestion run
  // rather than 404-ing until one has happened.
  ensureIngestSchema(recueil.connection);

  const secrets = SecretBox.fromConfig(config.secretKey);
  const sources = new IngestionSourceService({
    recueil,
    secrets,
    allowedRoots: config.ingestAllowedRoots,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  const rules = new RuleStore(recueil);
  const ingestion: IngestionContext = {
    sources,
    rules,
    queue: new QueueService(recueil),
    review: new ReviewService(recueil),
    storage: new StorageBackendService({
      recueil,
      secrets,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(config.ingestScratchPath === undefined ? {} : { scratchDirectory: config.ingestScratchPath }),
    }),
    runner: new IngestionRunner({
      recueil,
      config,
      events,
      rules,
      sources,
      log: (level, message, data) => {
        app.log[level]({ ...data }, message);
      },
    }),
    secretsAvailable: secrets.available,
  };

  app.decorate('recueil', {
    config,
    library: recueil,
    version,
    startedAt,
    tokens,
    events,
    ingestion,
  } satisfies RecueilContext);

  app.register(sensible);
  // Uploads are streamed and hashed on the way past (`routes/documents.ts`), so the only limit
  // that matters here is the ceiling on a single file. `files: 1` is deliberate: one upload is one
  // document, and a request carrying five files would have five hashes and one response.
  app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 32, fieldSize: 1_048_576 },
  });
  app.register(cors, {
    origin: config.corsOrigin,
    credentials: config.corsOrigin !== true && config.corsOrigin !== false,
    exposedHeaders: ['x-request-id'],
  });

  // Echo the request id on every response, success or failure.
  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('x-request-id')) reply.header('x-request-id', request.id);
    // The connector's transport reads `X-Zotero-Version` off every response and, on any status of
    // 400 or more that lacks it, sets a *global* `isOnline = false` — see
    // `fixtures/zotero-connector/connector.callMethod.online-state.js`, captured verbatim from
    // `src/common/connector.js` at `c279ccc`. So one unimplemented `/connector/*` sub-call
    // answering a bare 404 would take browser capture offline entirely rather than failing
    // locally. The hook is registered here, on the root instance, and not inside the connector
    // plugin: Fastify's encapsulation means a plugin's `onSend` never runs for the root
    // `notFoundHandler`, which is exactly the response that most needs the header.
    if (request.url.startsWith('/connector/')) {
      reply.header('x-zotero-version', ANNOUNCED_ZOTERO_VERSION);
    }
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

    // An `ApiError` may carry headers the status is meaningless without — `WWW-Authenticate` on a
    // 401 is the whole difference between "denied" and "denied, and here is how to authenticate".
    if (error instanceof ApiError && error.headers !== undefined) {
      for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
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

  app.register(authPlugin, {
    tokens,
    localUserId: recueil.user.id,
    requireAuth: config.requireAuth,
  });

  app.register(healthRoutes);
  app.register(systemRoutes);
  app.register(openApiRoutes);
  app.register(apiRoutes);

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
    // Ingestion runs continue after the response that started them, so a shutdown aborts them and
    // waits: closing the database out from under a pipeline mid-commit is the one way an ingest can
    // lose a document it has already told a source it had.
    instance.log.info('draining ingestion runs');
    await ingestion.runner.drain();
    instance.log.info('closing the library');
    if (deps.closeLibraryOnShutdown === true) recueil.close();
  });

  return app;
};
