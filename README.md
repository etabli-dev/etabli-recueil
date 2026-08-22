# Recueil

> Gather. Verify. Map.

Self-hosted, API-first document and reference manager with built-in reference
verification, bibliometrics and systematic-review workflow.

Recueil gathers documents from anywhere (browser, mail, scanner, WebDAV,
camera), keeps a content-addressed library with a bibliographic facet, verifies
and enriches references against the open scholarly graph, and exposes the whole
library to R, Python and LLMs as data. Systematic reviews and bibliometric
mapping are native workflows, not exports.

**Status:** Draft v0.1 — specification stage (Phase 0). Nothing runs yet.

See [`CONCEPT.md`](CONCEPT.md) for the full concept, architecture and roadmap.

## Layout

| Path | Contents |
|---|---|
| `apps/` | server, web, desktop, mobile, connector, cli, mcp |
| `packages/` | core, schemas, plugin-sdk, client-ts |
| `plugins/` | first-party plugins |
| `spec/` | OpenAPI, plugin manifest schema, ADRs, ERD |
| `docs/` | Quarto documentation site |
| `deploy/` | docker-compose with sidecar profiles |
| `fixtures/` | test libraries |

## Licence

AGPL-3.0-or-later — see [`LICENSE`](LICENSE).
