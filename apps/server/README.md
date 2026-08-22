# `@recueil/server`

The Fastify application: the HTTP surface of a Recueil library.

The server owns no data model. It opens a library with `createRecueil` from
[`@recueil/core`](../../packages/core), validates with the Zod schemas in
[`@recueil/schemas`](../../packages/schemas), and serves them — which is the whole of P6. There is
one implementation of "create an item", it lives in `core`, and this package is one of its clients
rather than a privileged back channel (CONCEPT.md §5.12).

Scope is Phase 0: the health endpoint that the phase's exit criterion is written in, the server's
own identity endpoint, and the generated OpenAPI document. The library resources arrive in Phase 1;
`src/routes/` is where they go.

## Layout

| Path | What lives there |
|---|---|
| `src/config.ts` | The environment, parsed with Zod. Fails loudly and names every bad variable |
| `src/app.ts` | `buildApp(deps)` — logging, request ids, CORS, RFC 9457, shutdown. Listens on nothing |
| `src/server.ts` | `start()` — environment → library → application → socket → signals. This is `recueil serve` |
| `src/health.ts` | The health schema and the three probes behind it |
| `src/system.ts` | `GET /api/v1/system/info` and its schema |
| `src/openapi.ts` | The served contract: the package document plus the operations this server adds |
| `src/problem.ts` | Anything thrown → an RFC 9457 problem document |
| `src/routes/` | One module per route group. Phase 1's resources land here |

## Running it

```sh
pnpm --filter @recueil/server run dev      # tsx, watching src/
pnpm --filter @recueil/server run build
pnpm --filter @recueil/server run start    # node dist/server.js
```

```sh
curl -s http://127.0.0.1:3000/health | jq
```

## Embedding it

`buildApp` never opens a database, reads the environment or binds a port. The caller decides all
three, which is what makes the CLI, the Tauri sidecar and the test suite the same code path.

```ts
import { createRecueil } from '@recueil/core';
import { buildApp, loadConfig } from '@recueil/server';

const config = loadConfig();
const recueil = createRecueil({
  databaseUrl: config.databaseUrl,
  storagePath: config.storagePath,
});

const app = buildApp({ config, recueil });
await app.listen({ port: config.port, host: config.host });
```

Or hand the whole thing over:

```ts
import { start } from '@recueil/server';

const server = await start();      // parses the environment, migrates, listens, handles signals
await server.stop();               // drains, then closes the library
```

## Configuration

Every variable is read once, at boot, and validated. A bad value stops the process with exit code
78 (`EX_CONFIG`) and a message naming each offending variable — a server that starts with a mistyped
port and silently uses the default is a server that is not where you left it.

| Variable | Default | What it does |
|---|---|---|
| `RECUEIL_PORT` | `3000` | Listen port. `0` asks the OS for a free one |
| `RECUEIL_HOST` | `127.0.0.1` | Bind address. The container image sets `0.0.0.0`, because that is a decision an image can make and a default cannot |
| `RECUEIL_DATABASE_URL` | `file:./data/recueil.db` | `:memory:`, a path, or a `file:`/`sqlite:` URL (ADR-0003) |
| `RECUEIL_STORAGE_PATH` | `./data/storage` | Root of the content-addressed store (ADR-0004). Resolved to an absolute path and created at start-up |
| `RECUEIL_LOG_LEVEL` | `info` | `trace` … `fatal`, or `silent`. Output is structured JSON on stdout |
| `RECUEIL_MODE` | `server` | `server` or `sidecar`. Reported by `/health`; the code is identical (CONCEPT.md §5.1) |
| `RECUEIL_BASE_URL` | — | Public URL behind a reverse proxy. Also becomes the `servers` entry of the served OpenAPI document |
| `RECUEIL_CORS_ORIGIN` | — | Comma-separated origins, or `*`. Unset means no cross-origin browser access at all |
| `RECUEIL_TRUST_PROXY` | `false` | Trust `X-Forwarded-*`. Only behind a proxy you control |
| `RECUEIL_SHUTDOWN_TIMEOUT_MS` | `10000` | How long a shutdown waits for in-flight requests before exiting anyway |
| `RECUEIL_VERSION` | package version | The release string reported by `/health`. Stamped in at image build time |

## Endpoints

### `GET /health`

Unauthenticated and unversioned — a probe that needs a token cannot run in a container health check,
and a probe that needs to know the API version breaks on the day it changes.

```json
{
  "status": "ok",
  "name": "recueil",
  "version": "0.1.0",
  "apiVersion": "v1",
  "checkedAt": "2026-08-22T09:15:00.000Z",
  "startedAt": "2026-08-22T09:14:58.000Z",
  "uptimeSeconds": 2.0,
  "mode": "server",
  "components": [
    { "name": "database", "status": "ok", "required": true, "latencyMs": 0.13 },
    { "name": "storage", "status": "ok", "required": true }
  ],
  "library": { "items": 0, "documents": 0, "attachments": 0, "collections": 0 },
  "database": { "ok": true, "migrationsApplied": 1 },
  "storage": { "ok": true, "path": "/data/storage", "backend": "local" }
}
```

**Every number here is measured on the way past.** The Phase 0 exit criterion is "`recueil serve`
returns health with an empty library" (CONCEPT.md §7), and the word doing the work is *empty*: the
row counts come out of SQLite, the migration count out of the migration ledger, and the store probe
touches the directory. A health endpoint that returns constants passes its own test and tells an
operator nothing, so `test/health.test.ts` asserts the empty case and the filled case on the same
database — a hard-coded `items: 0` passes the first and fails the second.

A required component down is `status: "error"` and HTTP 503, with the same body, so a probe that
gets a 503 learns which component failed without a second request. An optional component down is
`degraded` and still 200, because the library is still serving.

The body is a strict superset of `HealthResponse` from `@recueil/schemas`: everything the shared
contract declares, plus the `database` and `storage` objects that carry the two facts an operator
reaches for first. `/openapi.json` publishes the widened schema, and the route validates against it
before sending, so the document and the response cannot drift apart.

### `GET /api/v1/system/info`

What the server *is*, rather than whether it is currently well: release, API version, runtime, and
where the contract lives. Static, so a client can call it on start-up.

### `GET /openapi.json`

The OpenAPI 3.1 document, generated from the same Zod schemas the server validates with, and built
once at start-up rather than per request. Unauthenticated, because a client that cannot read the
contract cannot work out how to authenticate against it.

## Conventions this package enforces

- **RFC 9457 for every error**, including the ones nobody wrote a handler for. A 404 on an unrouted
  path and a throw from inside a handler both come back as `application/problem+json` with a stable
  `type` URI from `CORE_PROBLEM_TYPES`. Clients switch on `type` and nothing else, so it is
  versioned with the API and never reworded.
- **A 5xx says nothing.** The message of an unexpected error goes to the log at `error`; the
  response body carries a type, a title and a trace id. It is the one place where a stack trace, a
  file path or a SQL fragment could walk out of the process.
- **Every request has an id.** An inbound `x-request-id` is honoured, otherwise a ULID is minted.
  It appears on every log line for the request, in the `traceId` of any problem document, and in the
  `x-request-id` response header — so a screenshot of an error is enough to find the log line.
- **Tokens never reach the log.** The `authorization` and `cookie` headers are redacted by the
  logger, because the log is the artefact most likely to end up in a bug report.
- **Shutdown finishes what it started.** `SIGTERM` drains in-flight requests and then closes the
  library; a second signal, or `RECUEIL_SHUTDOWN_TIMEOUT_MS`, ends it anyway.

## Tests

```sh
pnpm --filter @recueil/server run test
```

Nothing is mocked. Each test builds a real library — a SQLite file and a content-addressed store —
in a temporary directory and drives the application through `fastify.inject()`; `test/server.test.ts`
goes further and binds an actual socket, because "`recueil serve` returns health" is a sentence
about a process, not about a function.

## Licence

AGPL-3.0-or-later. See [`LICENSE`](../../LICENSE) and [ADR-0005](../../spec/adr/0005-agpl-30-or-later.md).
