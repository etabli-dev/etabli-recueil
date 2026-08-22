/**
 * `GET /api/v1/system/info` — the versioned counterpart to `/health`.
 *
 * Under `/api/v1` because, unlike a health probe, this is part of the API surface a client codes
 * against: `/system` is listed in docs/api.qmd under Platform.
 */
import type { FastifyPluginAsync } from 'fastify';

import { API_BASE_PATH } from '@recueil/schemas';

import { SystemInfoSchema, buildSystemInfo } from '../system.js';

export const systemRoutes: FastifyPluginAsync = async (app) => {
  const { config, library, version, startedAt } = app.recueil;

  app.get(`${API_BASE_PATH}/system/info`, { config: { public: true } }, async (_request, reply) =>
    reply.send(SystemInfoSchema.parse(buildSystemInfo({ config, recueil: library, version, startedAt }))),
  );
};
