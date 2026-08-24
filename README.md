# Recueil

> Gather. Verify. Map.

Self-hosted, API-first document and reference manager with built-in reference
verification, bibliometrics and systematic-review workflow.

Recueil gathers documents from anywhere (browser, mail, scanner, WebDAV,
camera), keeps a content-addressed library with a bibliographic facet, verifies
and enriches references against the open scholarly graph, and exposes the whole
library to R, Python and LLMs as data. Systematic reviews and bibliometric
mapping are native workflows, not exports.

**Status:** Phases 1 and 2 in the tree, unreleased. It builds and runs from a
source checkout; there is no tagged release, no image on `ghcr.io` and no
installable binary.

`pnpm install && pnpm -r build` produces a working server, CLI and web client.
What has been exercised end to end here:

- **`recueil serve`** answers 124 operations over 92 paths — items, documents,
  attachments, collections, tags, custom fields, notes, annotations, creators,
  search, trash, export, tokens, events, storage, ingestion sources, the
  ingestion queue and review, the rule sets, and the Zotero connector endpoints.
  The contract in [`spec/openapi.yaml`](spec/openapi.yaml) is generated from the
  Zod schemas the server validates with, and the route table and the document
  are asserted equal in both directions.
- **`recueil import zotero <zotero.sqlite>`** migrates a Zotero library and writes
  a verification report. Against the generated fixture library in
  [`fixtures/zotero`](fixtures/zotero) it reaches exact per-item-type parity
  (67/67 regular items, 9 collections, 23 tags, 11 notes, 8 annotations, 17
  attachment records), resolves 12 of the 14 declared files with SHA-256s matching
  `fixtures/expected-counts.json`, names the two that are genuinely missing, and
  re-runs without duplicating anything.
- **The ingestion pipeline** — the ten stages of `CONCEPT.md` §5.3 — behind
  `recueil ingest`, `recueil ingest watch`, the folder / WebDAV / IMAP sources,
  the YAML rule engine, the confidence gate and the review queue. A folder source
  configured over the API, six scans dropped into it and the daemon left running
  produced six items, all six findable by full-text search, in **under two
  seconds from the drop, with no manual step** — see *Phase 2, measured* below.
- **`recueil import paperless`** migrates a Paperless-ngx library and writes the
  same shape of verification report. Against the committed corpus in
  [`fixtures/paperless`](fixtures/paperless) — 11 documents, 9 tags, 6
  correspondents, 5 document types, 6 custom fields, 7 archive serial numbers —
  every count matches `fixtures/expected-counts.json`, the one original the
  server refuses is routed to the review queue with its reason, and the run is
  idempotent.
- **Three storage backends** — local filesystem, WebDAV and S3 — pass one shared
  16-case conformance suite (`packages/storage-backends`), against a local WebDAV
  server and a local S3 fake, with one declared difference: only the two remote
  backends verify the digest on read.
- **`GET /api/v1/collections/{id}/bibliography.bib`** returns BibTeX to a
  read-only scoped token given in the URL, which is what Overleaf and Quarto need.
- **The web client** is a keyboard-first three-pane library with an item pane, a
  PDF.js reader, a sources screen, a review workspace and a rules editor, covered
  by a Playwright suite that drives the built bundle against a real server.
- 2 190 unit and integration tests across the twelve packages and apps that have
  them (`pnpm -r test`, all passing), plus the Playwright suite
  (`pnpm --filter @recueil/web run test:e2e`). Not one of them needs a container:
  OCR, GROBID, Paperless-ngx, WebDAV, S3 and IMAP are each behind an interface
  with an in-process fake.

### Phase 2, measured

The M2 exit criteria were rehearsed against the repository's own fixtures, in
throwaway libraries, with no container anywhere:

| Criterion | Result |
|---|---|
| Scanner → searchable item, zero manual steps | **Yes.** Folder source configured over `POST /api/v1/ingestion/sources`, `fixtures/scans/*.pdf` dropped in, `recueil ingest watch` running: 6/6 items, 0 to review, every one found by a word carried only by its text layer. 1.6 s and 1.9 s from drop to searchable, over two runs on this machine. |
| Mail → library | **Yes.** All eight `fixtures/mail/*.eml` through an in-process IMAP server: attachments became documents under the names the messages gave them, bodies became notes, a nested forward was descended into, and rules by sender were applied. |
| Paperless import verified | **Yes, against the fixture corpus.** `PASS`, 11/11 documents, 90.9 % original hash coverage with the one unfetchable file explained, 1 review entry. |
| Storage backends interchangeable | **Yes.** LocalFs, WebDAV and S3, 16 cases each, all passing. |

What that is **not**: the real M2. `CONCEPT.md` §7 asks for the author's actual
scanner, the author's actual mailbox, and a real Paperless-ngx instance
decommissioned after a verified import of *its* data. None of those has happened,
none of them can happen in this repository, and **M2 is not claimed**.

Three limits worth knowing before pointing this at real paper:

- **OCR is off unless you configure it.** `RECUEIL_OCR_ENGINE=ocrmypdf` (server)
  and `recueil ingest --ocr ocrmypdf` (CLI) run the OCRmyPDF adapter against a
  local binary, but **that adapter has never been run against a real OCRmyPDF
  here** — the tests exercise the `OcrEngine` interface through an in-process
  fake. GROBID and translation-server are in the same position.
- **OCR is decided per document, not per page.** A PDF that carries a text layer
  on page 1 and a scan on page 2 — `fixtures/scans/mixed-text-and-scan.pdf` is
  exactly that — is treated as having a text layer, and the scanned page is never
  recognised or indexed.
- **The Paperless client speaks API versions 9 and 10** (Paperless-ngx 3.x). The
  committed corpus declares 2.14.7 / API 6, and pointed at a server advertising
  that, the importer refuses with a named error rather than half-reading it.
  There is a test for that refusal.

Not done: `recueil token`, background jobs, and everything from Phase 3 onwards
report the phase they arrive in and exit non-zero. And the Zotero migration has
been proved against the fixture library, **not** against a real personal library —
which is what milestone M1 in [`CONCEPT.md`](CONCEPT.md) §7 actually asks for, so
M1 is not claimed either.

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
| `packages/import-paperless` | the Paperless-ngx migrator and its verification report |
| `packages/ingest` | the ten-stage ingestion pipeline of CONCEPT.md §5.3 |
| `packages/ingest-sources` | watched folders, the WebDAV feed and the IMAP mailbox |
| `packages/rules` | the YAML/JSON rule language, its engine and the dry-run report |
| `packages/storage-backends` | WebDAV and S3, and the conformance suite all three pass |
| `packages/plugin-sdk`, `packages/client-ts` | placeholder |
| `plugins/` | first-party plugins — placeholder |
| `spec/` | OpenAPI, plugin manifest schema, ADRs, data model |
| `docs/` | Quarto documentation site |
| `deploy/` | Dockerfile and docker-compose with sidecar profiles (untested) |
| `fixtures/` | the generated Zotero library, the format fixtures, and the Phase 2 corpora: scans, mail, archives, a Paperless-ngx dump and rule cases |

## Licence

AGPL-3.0-or-later — see [`LICENSE`](LICENSE).
