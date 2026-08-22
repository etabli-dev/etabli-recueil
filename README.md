# Recueil

> Gather. Verify. Map.

Self-hosted, API-first document and reference manager with built-in reference
verification, bibliometrics and systematic-review workflow.

Recueil gathers documents from anywhere (browser, mail, scanner, WebDAV,
camera), keeps a content-addressed library with a bibliographic facet, verifies
and enriches references against the open scholarly graph, and exposes the whole
library to R, Python and LLMs as data. Systematic reviews and bibliometric
mapping are native workflows, not exports.

**Status:** Phase 1 in the tree, unreleased. It builds and runs from a source
checkout; there is no tagged release, no image on `ghcr.io` and no installable
binary.

`pnpm install && pnpm -r build` produces a working server, CLI and web client.
What has been exercised end to end here:

- **`recueil serve`** answers 93 operations over 70 paths — items, documents,
  attachments, collections, tags, custom fields, notes, annotations, creators,
  search, trash, export, tokens, events and the Zotero connector endpoints. The
  contract in [`spec/openapi.yaml`](spec/openapi.yaml) is generated from the Zod
  schemas the server validates with, and the route table and the document are
  asserted equal in both directions.
- **`recueil import zotero <zotero.sqlite>`** migrates a Zotero library and writes
  a verification report. Against the generated fixture library in
  [`fixtures/zotero`](fixtures/zotero) it reaches exact per-item-type parity
  (67/67 regular items, 9 collections, 23 tags, 11 notes, 8 annotations, 17
  attachment records), resolves 12 of the 14 declared files with SHA-256s matching
  `fixtures/expected-counts.json`, names the two that are genuinely missing, and
  re-runs without duplicating anything.
- **`GET /api/v1/collections/{id}/bibliography.bib`** returns BibTeX to a
  read-only scoped token given in the URL, which is what Overleaf and Quarto need.
- **The web client** is a keyboard-first three-pane library with an item pane and
  a PDF.js reader, covered by a Playwright suite that drives the built bundle
  against a real server.
- 1 157 unit and integration tests across the seven packages that exist
  (`pnpm -r test`), plus a six-case Playwright suite
  (`pnpm --filter @recueil/web run test:e2e`).

Not done: `recueil token`, background jobs and everything from Phase 2 onwards
report the phase they arrive in and exit non-zero. And the Zotero migration has
been proved against the fixture library, **not** against a real personal library —
which is what milestone M1 in [`CONCEPT.md`](CONCEPT.md) §7 actually asks for, so
M1 is not claimed.

See [`CONCEPT.md`](CONCEPT.md) for the full concept, architecture and roadmap.

## Layout

Directories marked *placeholder* hold a README describing what will go there and
nothing else yet.

| Path | Contents |
|---|---|
| `apps/server` | the Fastify server and the REST contract |
| `apps/cli` | the `recueil` command line |
| `apps/web` | the web client |
| `apps/desktop`, `apps/mobile`, `apps/connector`, `apps/mcp` | placeholder |
| `packages/schemas` | the Zod contract and the OpenAPI components |
| `packages/core` | data model, migrations, content-addressed store, services |
| `packages/formats` | BibTeX, BibLaTeX, RIS, CSL-JSON and citation keys |
| `packages/import-zotero` | the Zotero migrator and its verification report |
| `packages/plugin-sdk`, `packages/client-ts` | placeholder |
| `plugins/` | first-party plugins — placeholder |
| `spec/` | OpenAPI, plugin manifest schema, ADRs, data model |
| `docs/` | Quarto documentation site |
| `deploy/` | Dockerfile and docker-compose with sidecar profiles (untested) |
| `fixtures/` | the generated Zotero library and the format fixtures |

## Licence

AGPL-3.0-or-later — see [`LICENSE`](LICENSE).
