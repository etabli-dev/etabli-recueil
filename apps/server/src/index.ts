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
export type { BuildAppDeps, RecueilContext } from './app.js';

export { authPlugin, actorForRequest, TOKEN_QUERY_PARAM } from './auth.js';
export type { AuthPluginOptions, RequestPrincipal } from './auth.js';

export { ConfigError, LOG_LEVELS, RUN_MODES, ServerEnvSchema, loadConfig } from './config.js';
export type { LogLevel, RunMode, ServerConfig, ServerEnv } from './config.js';

export { start } from './server.js';
export type { RunningServer, StartOptions } from './server.js';

export {
  ApiHealthSchema,
  DatabaseHealthSchema,
  SearchHealthSchema,
  ServerHealthResponseSchema,
  StorageHealthSchema,
  checkDatabase,
  checkSearch,
  checkStorage,
  countLibrary,
  ensureStoragePath,
} from './health.js';
export type {
  ApiHealth,
  DatabaseHealth,
  SearchHealth,
  ServerHealthResponse,
  StorageHealth,
} from './health.js';

export { EventBus, EMITTED_EVENT_TYPES, LIFECYCLE_EVENT_TYPES, renderSseFrame } from './events.js';
export type { EventEnvelope, EventListener, LifecycleEventType, PublishInput } from './events.js';

export { TokenService, hashTokenSecret, parseScopes, TOKEN_CLIENTS, TOKEN_SECRET_PREFIX } from './tokens.js';
export type { CreatedToken, CreateTokenInput, TokenClient, TokenPrincipal } from './tokens.js';

export {
  ADMIN_SCOPE,
  KNOWN_SCOPES,
  SCOPE_RESOURCES,
  SCOPE_VERBS,
  grantSatisfies,
  hasScope,
  isGrantableScope,
  isReadOnly,
} from './scopes.js';
export type { ScopeResource, ScopeVerb } from './scopes.js';

export {
  EXPORT_FORMATS,
  FORMAT_MEDIA,
  MAX_EXPORT_ITEMS,
  citationKeys,
  renderExport,
  resolveSelection,
} from './export.js';
export type { ExportFormat, RenderedExport, Selection } from './export.js';

export { apiPaths, apiRoutes } from './routes/index.js';
export { MATCHED_CONNECTOR_VERSION } from './routes/connector.js';

export { OPENAPI_PATH, SystemInfoSchema, buildSystemInfo } from './system.js';
export type { SystemInfo } from './system.js';

export { buildOpenApiDocument, renderSpecYaml, serverPaths } from './openapi.js';
export type { BuildOpenApiDocumentOptions } from './openapi.js';

export {
  ApiError,
  PROBLEM_CONTENT_TYPE,
  notFound,
  problem,
  scopeRequired,
  sendProblem,
  toProblem,
  unauthenticated,
} from './problem.js';
export type { ProblemOptions } from './problem.js';

export { RequestValidationError, coerceQuery, dottedPath, parseOrThrow, refuse } from './validate.js';

export { PACKAGE_NAME, PACKAGE_VERSION, resolveVersion } from './version.js';
