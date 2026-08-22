# `@recueil/server`

The Fastify application: the HTTP surface of a Recueil library.

The server owns no data model. It opens a library with `createRecueil` from
[`@recueil/core`](../../packages/core), validates with the Zod schemas in
[`@recueil/schemas`](../../packages/schemas), and serves them — which is the whole of P6. There is
one implementation of "create an item", it lives in `core`, and this package is one of its clients
rather than a privileged back channel (CONCEPT.md §5.12).

Scope is Phase 1: the whole `/api/v1` library surface — items, documents, attachments, collections,
tags, notes, custom fields, creators, search, export, trash and tokens — the SSE event stream, the
tokened `.bib` feeds Overleaf and Quarto fetch, and the Zotero Connector endpoints (ADR-0006).

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
| `src/auth.ts` | Bearer tokens, scope enforcement and the audit actor, as Fastify hooks |
| `src/tokens.ts` | Minting, hashing at rest and verification (`spec/data-model.md` §3.2) |
| `src/scopes.ts` | The whole authorisation model: three rules over `resource:verb` pairs |
| `src/validate.ts` | Zod → a problem document with a pointer at the offending field |
| `src/http.ts` | Cursor pagination, ETags, conditional writes, schema-checked sends |
| `src/wire.ts` | Database rows → contract shapes. One place, because the schemas are strict |
| `src/queries.ts` | The few projections `@recueil/core` does not expose, and nothing that decides anything |
| `src/schemas.ts` | The response and request shapes that belong to this surface rather than to the data model |
| `src/events.ts` | The lifecycle event bus and the SSE framing (`spec/hooks.md` §7) |
| `src/publish.ts` | Building each event payload, post-commit |
| `src/export.ts` | Choosing a selection and serialising it (CONCEPT.md §5.11, ADR-0016) |
| `src/idempotency.ts` | `Idempotency-Key` → the `jobs` table, and the replay (IK1–IK3) |
| `src/openapi-kit.ts` | Small builders so a path item is worth writing by hand |
| `src/routes/` | One module per route group. Each exports **both** its Fastify plugin and its OpenAPI path items |
| `src/bin/write-openapi.ts` | Writes `spec/openapi.yaml` |

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
| `RECUEIL_REQUIRE_AUTH` | `false` | Refuse an unauthenticated call to `/api/v1`. Off by default because v1 is a single-user server on loopback; **turn it on for anything reachable beyond it** |
| `RECUEIL_MAX_UPLOAD_BYTES` | `536870912` | Ceiling on one uploaded file. Enforced during the streaming hash, before anything is recorded |

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
    { "name": "storage", "status": "ok", "required": true },
    { "name": "search", "status": "ok", "required": false }
  ],
  "library": { "items": 0, "documents": 0, "attachments": 0, "collections": 0 },
  "database": { "ok": true, "migrationsApplied": 4 },
  "storage": { "ok": true, "path": "/data/storage", "backend": "local" },
  "search": { "available": true, "backend": "fts5" },
  "api": { "basePath": "/api/v1", "eventSubscribers": 0, "authRequired": false }
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

`spec/openapi.yaml` is the same document, committed:

```sh
pnpm --filter @recueil/server run openapi
```

Each route module in `src/routes/` exports its Fastify plugin **and** the path items that describe
it, and `routes/index.ts` assembles both lists from the same array — so a handler cannot be added
without a description beside it. `test/openapi.test.ts` closes the remaining gap in both directions:
it walks Fastify's own route table and fails on a route the document does not declare, and walks the
document and fails on an operation the router does not answer. A third test asserts the committed
`spec/openapi.yaml` is byte-identical to what this code generates.

> **Note.** `packages/schemas` also has an `openapi` script. It can only see the schemas, not which
> operations a server implements, so running it would overwrite `spec/openapi.yaml` with the Phase 0
> document. Until that script is retired or fed from here, **`@recueil/server`'s is the one that
> writes the committed file.**

## `/api/v1` at a glance

| Group | Endpoints |
|---|---|
| Items | list, create, bulk, fetch (by id and by public key), update, facet writes with provenance, provenance and locks, trash, restore, and the sub-resources: attachments, creators, tags, notes, field values |
| Documents | multipart upload with a streaming hash, lookup by digest, metadata, ranged download, trash, restore |
| Attachments | attach, reorder, fetch, detach, restore |
| Collections | list, tree, create, update, move, membership, trash, restore, `bibliography.bib` |
| Tags | list, create, fetch, rename, items, merge, trash, restore, and the tag set of one item |
| Notes | list, create, fetch, update, trash, restore |
| Fields | define, list, fetch, update, remove, and the typed values on an item |
| Creators | list, create, fetch, update, works, merge, trash, restore |
| Search | ranked full-text search over items, notes and extracted document text |
| Export | BibTeX, BibLaTeX, RIS, CSL-JSON over a selection; the two `.bib` feeds |
| Trash | list, summary, restore, purge |
| Tokens | list, mint, fetch, revoke |
| Events | the SSE lifecycle stream |
| Connector | `ping`, `getSelectedCollection`, `saveItems`, `saveSnapshot`, `sessionProgress` |

### Authentication and scopes

A token is a bearer credential; the server stores its SHA-256 and its first twelve characters and
**cannot reproduce the secret** (`spec/data-model.md` §3.2). Scopes are `resource:verb` pairs, either
half of which may be `*`; `write` implies `read` on the same resource; `admin:*` is everything. Each
route declares the scope it needs in its Fastify `config`, and `test/auth.test.ts` walks the route
table and fails on a `/api/v1` route that declares none — because a handler that forgets to check is
a hole nothing else would notice.

Every write is attributed. The `audit_log` row for a call made with a token carries
`actor_type = 'token'`, the token id, the request id, the route, the client address and the user
agent (P4, AL2, AL3).

### The `.bib` feeds

```
GET /api/v1/collections/{id}/bibliography.bib?token=rcu_…
GET /api/v1/saved-searches/{id}/bibliography.bib?token=rcu_…
```

CONCEPT.md §5.11 asks for exactly this, and every detail of it is load-bearing. The path ends in
`.bib` because Overleaf and Quarto take the file type from the URL. The credential may travel in the
query string because neither tool can set a header — this is the **only** place on the API where
that is accepted, and a `bib_feed` token may hold no write scope (invariant A2), because a
credential in a project setting is a credential that has been published. The `ETag` is a digest of
the bytes served, so a build that refetches on every run gets a 304 and does not re-parse the file.

Citation keys follow ADR-0016: a stored key always wins, a pinned key is never recomputed, and only
keyless items get a generated key — disambiguated against the keys already in the batch, so a new
item can never take one a manuscript points at.

### The event stream

`GET /api/v1/events` is Server-Sent Events. Each frame carries the lifecycle type in `event:`, the
envelope of `spec/hooks.md` §7.1 as JSON in `data:`, and the monotonic `sequence` as the SSE id.
There is no replay — a subscriber receives events from the moment it subscribes (§7.2) — and order
is by `sequence`, never by `occurredAt`, which has clock resolution and can tie.

This phase can cause `item.created`, `item.updated`, `item.trashed`, `item.restored`,
`document.ingested` and `attachment.added`. The other six of the twelve arrive with the phases that
implement them.

**Known deviation.** §7.1 says `sequence` is "persisted, continues across restarts". Here it is
monotonic within the *process*: persisting it needs a table Phase 1's migrations do not have, and a
counter that silently restarted at 1 would be worse than one whose scope is written down.

## Connector compatibility (ADR-0006)

The endpoints under `/connector/` are the ones the **unmodified** Zotero Connector talks to. They
are mounted with no `/api/v1` prefix and no version because that is how the client serves them, and
they are unauthenticated because the extension has no way to hold a token and the client it is
imitating has none either.

**Matched against:** Zotero Connector 5.0.x and the Zotero 7 client's
`connector/server_connector.js` request and response shapes. The protocol is undocumented; ADR-0006
says so and pins versions for exactly this reason. Where a shape could not be confirmed, the reading
taken is stated in a comment above the handler rather than presented as fact.

**Where it listens.** The extension looks for a client on `http://127.0.0.1:23119`. A deployment
that wants browser capture binds the server — or a reverse proxy for `/connector/*` alone — on that
port. Changing the path would need the extension modified, which is the one thing the ADR is buying
its way out of.

> **Exposing port 23119 beyond loopback publishes an unauthenticated write endpoint.** Zotero's own
> service has the same property and the same mitigation: it is a loopback service. Do not forward it.

**What is not implemented, and is not pretended:**

- `/connector/saveSingleFile` — the endpoint the connector posts a SingleFile snapshot to. Without
  it, `saveSnapshot` creates the `webpage` item but stores no page bytes, and says so in the item's
  `extra` rather than implying the page was archived.
- `targets` on `getSelectedCollection` — the collection-picker list. It is optional in the responses
  observed, and offering a picker whose choices this implementation would then ignore would be worse
  than not offering one.
- `/connector/updateSession`, `/connector/getTranslators`, `/connector/detect`,
  `/connector/installStyle` and the Google Docs integration calls.
- Attachments named in a `saveItems` payload are recorded as part of the item but **not fetched**: a
  server that went and downloaded a publisher URL on its own behalf would be doing something the
  user did not ask for.

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
in a temporary directory and drives the application through `fastify.inject()`. Two go further and
bind an actual socket: `test/server.test.ts`, because "`recueil serve` returns health" is a sentence
about a process rather than about a function, and `test/events.test.ts`, because SSE framing cannot
be observed through an injected response.

`test/export.test.ts` asserts the `.bib` endpoint by feeding its output back through
`@recueil/formats`' own importer: "it returned some text" is not the claim being made, "Overleaf can
parse this" is.

## Licence

AGPL-3.0-or-later. See [`LICENSE`](../../LICENSE) and [ADR-0005](../../spec/adr/0005-agpl-30-or-later.md).
