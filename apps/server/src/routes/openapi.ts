/**
 * `GET /openapi.json`.
 *
 * Generated once when the route is registered rather than per request: the document is a few
 * hundred kilobytes of JSON built from every Zod schema in the contract, it cannot change while the
 * process runs, and a client generator that fetches it in a loop should not be able to make the
 * server do that work twice.
 *
 * Unauthenticated on purpose. A client that cannot read the contract cannot work out how to
 * authenticate against it, and the document describes shapes rather than data.
 */
import type { FastifyPluginAsync } from 'fastify';

import { buildOpenApiDocument } from '../openapi.js';
import { OPENAPI_PATH } from '../system.js';

export const openApiRoutes: FastifyPluginAsync = async (app) => {
  const { config, version } = app.recueil;

  const document = buildOpenApiDocument({
    version,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
  });

  app.get(OPENAPI_PATH, async (_request, reply) =>
    reply.type('application/json; charset=utf-8').send(document),
  );
};
