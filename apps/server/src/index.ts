/**
 * `@recueil/server` — the Fastify application.
 *
 * Two entry points, and the choice between them is about who owns the process. `buildApp` returns a
 * configured instance and listens on nothing, which is what a test, an embedding host or a future
 * in-process job runner wants. `start` does the whole thing — environment, library, application,
 * socket, signals — and is what `recueil serve` and the container entrypoint call.
 *
 * Everything else exported here is exported so that the CLI, the desktop sidecar and the tests can
 * reuse the pieces without reimplementing them: the configuration parser, the problem-document
 * mapper, the health collectors and the served OpenAPI document.
 */
export { buildApp } from './app.js';
export type { BuildAppDeps } from './app.js';

export { ConfigError, LOG_LEVELS, RUN_MODES, ServerEnvSchema, loadConfig } from './config.js';
export type { LogLevel, RunMode, ServerConfig, ServerEnv } from './config.js';

export { start } from './server.js';
export type { RunningServer, StartOptions } from './server.js';

export {
  DatabaseHealthSchema,
  ServerHealthResponseSchema,
  StorageHealthSchema,
  checkDatabase,
  checkStorage,
  countLibrary,
  ensureStoragePath,
} from './health.js';
export type { DatabaseHealth, ServerHealthResponse, StorageHealth } from './health.js';

export { OPENAPI_PATH, SystemInfoSchema, buildSystemInfo } from './system.js';
export type { SystemInfo } from './system.js';

export { buildOpenApiDocument, serverPaths } from './openapi.js';
export type { BuildOpenApiDocumentOptions } from './openapi.js';

export { PROBLEM_CONTENT_TYPE, problem, sendProblem, toProblem } from './problem.js';
export type { ProblemOptions } from './problem.js';

export { PACKAGE_NAME, PACKAGE_VERSION, resolveVersion } from './version.js';
