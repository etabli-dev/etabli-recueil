/**
 * `GET /api/v1/system/info`.
 *
 * The difference from `/health` is who is asking. `/health` answers a container probe every thirty
 * seconds and has to stay cheap and unauthenticated; this answers a person, a client deciding what
 * the server supports, or a bug report, and so it says what the server *is* rather than whether it
 * is currently well: which release, which API version, which runtime, where the contract document
 * is, and which optional pieces are configured.
 *
 * It is deliberately static — nothing here queries the library — so that it stays a safe thing for
 * a client to call on start-up.
 */
import type { Recueil } from '@recueil/core';
import { API_BASE_PATH, API_VERSION, OPENAPI_VERSION } from '@recueil/schemas';
import * as z from 'zod';

import type { ServerConfig } from './config.js';
import { PACKAGE_NAME } from './version.js';

export const SystemInfoSchema = z
  .strictObject({
    name: z.literal('recueil'),
    package: z.string().max(128).meta({ description: 'The npm package serving this API.' }),
    version: z.string().max(64),
    apiVersion: z.string().max(16),
    apiBasePath: z.string().max(64),
    openapi: z
      .strictObject({
        version: z.string().max(16).meta({ description: 'The OpenAPI version of the served document.' }),
        url: z.string().max(1024).meta({ description: 'Where to fetch the contract from this server.' }),
      })
      .meta({ id: 'SystemInfoOpenApi', title: 'SystemInfoOpenApi' }),
    mode: z.enum(['server', 'sidecar']),
    runtime: z
      .strictObject({
        node: z.string().max(32),
        platform: z.string().max(32),
        arch: z.string().max(32),
      })
      .meta({ id: 'SystemInfoRuntime', title: 'SystemInfoRuntime' }),
    startedAt: z.string().max(32),
    uptimeSeconds: z.number().min(0),
    storageBackend: z.enum(['local', 'webdav', 's3']),
    /** Absent unless the operator set `RECUEIL_BASE_URL` (docs/self-hosting.qmd). */
    baseUrl: z.string().max(1024).optional(),
    licence: z.literal('AGPL-3.0-or-later'),
  })
  .meta({
    id: 'SystemInfo',
    title: 'SystemInfo',
    description:
      'What this server is: release, API version, runtime and where the OpenAPI contract lives. ' +
      'Static; for liveness use `GET /health`.',
  });

export type SystemInfo = z.infer<typeof SystemInfoSchema>;

/** Where the generated contract is served from. Unversioned, like `/health`, so a client can find it. */
export const OPENAPI_PATH = '/openapi.json';

export interface SystemInfoInput {
  readonly config: ServerConfig;
  readonly recueil: Recueil;
  readonly version: string;
  readonly startedAt: Date;
}

export const buildSystemInfo = (input: SystemInfoInput): SystemInfo => {
  const info: SystemInfo = {
    name: 'recueil',
    package: PACKAGE_NAME,
    version: input.version,
    apiVersion: API_VERSION,
    apiBasePath: API_BASE_PATH,
    openapi: { version: OPENAPI_VERSION, url: OPENAPI_PATH },
    mode: input.config.mode,
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    startedAt: input.startedAt.toISOString(),
    uptimeSeconds: Math.max(0, (Date.now() - input.startedAt.getTime()) / 1000),
    storageBackend: input.recueil.storage.backend,
    licence: 'AGPL-3.0-or-later',
  };
  if (input.config.baseUrl !== undefined) info.baseUrl = input.config.baseUrl;
  return info;
};
