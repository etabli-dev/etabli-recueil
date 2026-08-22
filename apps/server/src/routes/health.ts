/**
 * The `/health` route.
 *
 * Unversioned and unauthenticated: a probe that has to know the API version breaks on the day the
 * version changes, and a probe that has to hold a token is a probe that cannot run in a container
 * health check (`@recueil/schemas` `healthPaths`, deploy/docker-compose.yml).
 *
 * The status rules, from `HealthStatusSchema`:
 *
 * - a required component down → `error`, and HTTP 503, because the library is not serving;
 * - an optional component down → `degraded`, and still HTTP 200, because it is;
 * - everything up → `ok`.
 *
 * The body is the same document either way. A probe that gets a 503 and a body it can read learns
 * which component failed without a second request.
 */
import type { ComponentHealth, HealthStatus } from '@recueil/schemas';
import { API_VERSION } from '@recueil/schemas';
import type { FastifyPluginAsync } from 'fastify';

import { API_BASE_PATH } from '@recueil/schemas';

import {
  ServerHealthResponseSchema,
  checkDatabase,
  checkSearch,
  checkStorage,
  countLibrary,
} from '../health.js';
import type { ServerHealthResponse } from '../health.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  const { config, library, version, startedAt, events } = app.recueil;

  app.get('/health', { config: { public: true } }, async (_request, reply) => {
    const checkedAt = new Date();

    const database = checkDatabase(library);
    const storage = await checkStorage(library, config.storagePath);
    const search = checkSearch(library);

    // The counts need a working database; asking for them when it is down would throw inside the
    // one handler that must always answer.
    const librarySummary = database.ok
      ? { ...(await countLibrary(library)), countedAt: checkedAt.toISOString() }
      : undefined;

    const components: ComponentHealth[] = [
      {
        name: 'database',
        status: database.ok ? 'ok' : 'error',
        required: true,
        checkedAt: checkedAt.toISOString(),
        ...(database.latencyMs === undefined ? {} : { latencyMs: database.latencyMs }),
        ...(database.detail === undefined ? {} : { detail: database.detail }),
      },
      {
        name: 'storage',
        status: storage.ok ? 'ok' : 'error',
        required: true,
        checkedAt: checkedAt.toISOString(),
        ...(storage.detail === undefined ? {} : { detail: storage.detail }),
      },
      {
        // Optional: a library with no FTS5 module still serves everything but `/api/v1/search`,
        // which is `degraded` and not `error` (ADR-0011).
        name: 'search',
        status: search.available ? 'ok' : 'degraded',
        required: false,
        checkedAt: checkedAt.toISOString(),
        ...(search.available
          ? {}
          : { detail: 'This SQLite build has no FTS5 module, so full-text search is unavailable.' }),
      },
    ];

    const status: HealthStatus = components.some(
      (component) => component.required && component.status === 'error',
    )
      ? 'error'
      : components.some((component) => component.status !== 'ok')
        ? 'degraded'
        : 'ok';

    const body: ServerHealthResponse = {
      status,
      name: 'recueil',
      version,
      apiVersion: API_VERSION,
      checkedAt: checkedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.max(0, (checkedAt.getTime() - startedAt.getTime()) / 1000),
      mode: config.mode,
      components,
      database,
      storage,
      search,
      api: {
        basePath: API_BASE_PATH,
        eventSubscribers: events.subscriberCount,
        authRequired: config.requireAuth,
      },
      ...(librarySummary === undefined ? {} : { library: librarySummary }),
    };

    // Validated against the schema the served OpenAPI document publishes. This is not belt and
    // braces: it is the mechanism that stops the contract and the implementation drifting (P6), and
    // it costs microseconds on a document this size.
    const validated = ServerHealthResponseSchema.parse(body);

    return reply.code(status === 'error' ? 503 : 200).send(validated);
  });
};
