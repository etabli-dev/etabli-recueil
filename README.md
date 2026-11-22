# Recueil

> Gather. Verify. Map.

Self-hosted, API-first document and reference manager with built-in reference
verification, bibliometrics and systematic-review workflow.

Recueil gathers documents from anywhere (browser, mail, scanner, WebDAV,
camera), keeps a content-addressed library with a bibliographic facet, verifies
and enriches references against the open scholarly graph, and exposes the whole
library to R, Python and LLMs as data. Systematic reviews and bibliometric
mapping are native workflows, not exports.

**Status:** Phases 1–5 in the tree, unreleased. It builds and runs from a
source checkout; there is no tagged release, no image on `ghcr.io` and no
published installable binary.

**Platforms:** the server runs wherever Node 22 or Docker runs. A desktop
application for Linux, Windows and macOS (`apps/desktop`, Tauri 2) is in the
tree as a client of a running server: its Linux `.deb` and AppImage have been
built and launched here, while the Windows and macOS packages are built only
in CI, which has not run yet, and nothing is signed. iOS and Android are
planned for Phase 8. See the [platform roadmap](docs/platform-roadmap.md).

## First use from source

Prerequisites: Node.js 22.23.4 (the locally verified runtime), pnpm 9.15.4,
and a recent Git. SQLite is embedded; no database server is required.

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/index.js serve --host 127.0.0.1 --port 3000 \
  --database ./local-library.sqlite --storage ./local-storage
```

In another terminal at the repository root:

```sh
curl --fail http://127.0.0.1:3000/health
pnpm --filter @recueil/web dev --host 127.0.0.1
# Open http://127.0.0.1:5173
node apps/cli/dist/index.js --help
```

The web development server proxies the API. For a production deployment, serve
`apps/web/dist` and proxy `/api`, `/health` and `/openapi.json` on the same origin;
the API server does not serve the web assets itself. Configure authentication
before exposing it beyond localhost; see [`deploy/README.md`](deploy/README.md).
Keep the SQLite database and its content store together when backing up; see
`node apps/cli/dist/index.js backup --help` and `restore --help`.

Run the local gates with `pnpm lint`, `pnpm typecheck`, `pnpm check:spec`,
`pnpm test`, and `pnpm --filter @recueil/web test:e2e` after installing Chromium
with `pnpm --filter @recueil/web exec playwright install chromium`.
The [October refinement record](spec/refinement-2026-10.md) distinguishes current
checks from historical measurements and external release gates.

## Implemented workflows

`pnpm install --frozen-lockfile && pnpm build` produces a server, CLI and web client.
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
- Unit and integration tests across twelve packages and apps (`pnpm test`),
  plus the Playwright suite
  (`pnpm --filter @recueil/web run test:e2e`). Not one of them needs a container:
  OCR, GROBID, Paperless-ngx, WebDAV, S3 and IMAP are each behind an interface
  with an in-process fake.

- **`recueil sync zotero`** syncs the library with the zotero.org libraries an API key
  reaches, both ways ([ADR-0025](spec/adr/0025-two-way-zotero-sync.md)): a per-field three-way
  merge against the last agreed state, conflicts held on both sides until decided with
  `recueil sync zotero resolve`, fields locked in Recueil never overwritten by a pull, every write
  conditional on the version last seen, files checked against Zotero's MD5, and a dry run that
  writes nothing to either side. Tested against an in-process fake of the Web API, **not yet
  against a real zotero.org account**.

- **Phase 3 — enrichment, checks, deduplication, plugins.** An in-process plugin host
  (`packages/plugin-host`, ADR-0012) loads plugins written against `@recueil/plugin-sdk`, whose
  types are generated from `spec/hooks.md`. Three first-party plugins ship: eleven resolvers
  (`recueil enrich`), the thirteen checks including bibliography audit (`recueil check --audit`),
  and identifier and fuzzy dedup rules (`recueil dedup`, reversible merges, `dedup undo`). Plugins
  are installed disabled; `recueil plugin enable --builtin` turns them on. Parity tests carry the
  behaviour of the three Zotero plugins this phase retires ([`spec/parity-zotero-plugins.md`](spec/parity-zotero-plugins.md)).
  The upstream sources are exercised against recorded responses, **not yet against the live
  services**, and no real manuscript audit has been delivered, so **M3 is not claimed**.

- **Phase 4 — reading.** Annotations are records (`/api/v1/annotations`, ADR-0009): the reader
  highlights a selection with an optional comment, lists every annotation in reading order, turns
  one into a note that quotes it and ends in a Pandoc citation (`[@key, p. 12]`), and downloads the
  PDF with all of them embedded (`/documents/{id}/annotated.pdf`; the stored file is untouched).
  Saved searches take filters as well as text — types, tags, collection, years, files, retraction
  status, failing checks — and smart collections list their items. `recueil check --audit
  manuscript.pdf` reads the reference list through a GROBID sidecar (`RECUEIL_GROBID_URL`), whose
  adapter has not been run against a live GROBID here. Not yet: the desktop shell's tray, URI
  scheme and folder picker (they need new Rust crates and move to the platform step), and the
  Meilisearch backend (it needs the job runner to keep its index in step).

- **Phase 5 — graph and bibliometrics.** `recueil graph collect` reads reference lists from
  OpenAlex and Crossref into a citation graph; cited works outside the library are shadow works,
  matched to library items by DOI and PMID, so the local citation network falls out of it.
  `recueil graph derive` builds co-citation and coupling (association strength or Salton).
  Exports: Web of Science plain text that bibliometrix's `convert2df` reads (checked in CI with
  bibliometrix itself), VOSviewer JSON, GEXF, GraphML and the analytics tables as CSV, through
  the CLI and `/api/v1/analytics` and `/api/v1/graph`. `clients/r` (`rc_bibliometrix()`,
  `rc_network()` as tidygraph) and `clients/python` (pandas, networkx) read them; the web app
  draws the citation map with coverage beside it. Not yet: the MeSH vocabulary layer and co-word
  maps, Parquet encoding of the tables (CSV for now), and the deep dive.

### The hardening round

An adversarial review between Phase 2 and Phase 3 returned 8 critical, 8 major and
5 minor findings, every one reproduced by a runnable script and none of them found
by the suite. They are recorded verbatim in
[`spec/findings-phase-2.md`](spec/findings-phase-2.md) and the round that closed
them is [`spec/hardening-2026-08.md`](spec/hardening-2026-08.md), which carries a
per-defect audit: what closed it, and which test was watched going red with the fix
reverted. Two of the findings recurred across independent reviewers, which made
them design faults rather than mistakes, and both are now binding ADRs —
[0021](spec/adr/0021-a-verification-check-queries-both-sides.md), a verification
check queries both sides, and
[0022](spec/adr/0022-resource-budgets-on-untrusted-input.md), resource budgets on
untrusted input. Three minor findings remain open and are named in that document.

### Phase 2, measured

The M2 exit criteria were rehearsed against the repository's own fixtures, in
throwaway libraries, with no container anywhere, and re-run after the hardening
round:

| Criterion | Result |
|---|---|
| Scanner → searchable item, zero manual steps | **Yes.** Folder source configured over `POST /api/v1/ingestion/sources`, `fixtures/scans/*.pdf` dropped in, `recueil ingest watch` running: 6/6 items, 0 to review, every one found again through `GET /search` by a word carried only by its own text layer or its own recognised text, and every hit resolving to exactly the item that file became. 1.6 s and 1.9 s from drop to searchable, over two runs on this machine. Re-run under `consume: delete` after the hardening round, the watched folder empties with no refused acknowledgement. |
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
| `apps/desktop` | the Tauri 2 desktop shell: the web client against a configured server ([platform roadmap](docs/platform-roadmap.md), phase A) |
| `apps/mobile`, `apps/connector`, `apps/mcp` | placeholder |
| `packages/schemas` | the Zod contract and the OpenAPI components |
| `packages/core` | data model, migrations, content-addressed store, services |
| `packages/formats` | BibTeX, BibLaTeX, RIS, CSL-JSON and citation keys |
| `packages/import-zotero` | the Zotero migrator and its verification report |
| `packages/import-paperless` | the Paperless-ngx migrator and its verification report |
| `packages/sync-zotero` | two-way sync with zotero.org through the Web API ([ADR-0025](spec/adr/0025-two-way-zotero-sync.md)) |
| `packages/ingest` | the ten-stage ingestion pipeline of CONCEPT.md §5.3 |
| `packages/ingest-sources` | watched folders, the WebDAV feed and the IMAP mailbox |
| `packages/rules` | the YAML/JSON rule language, its engine and the dry-run report |
| `packages/storage-backends` | WebDAV and S3, and the conformance suite all three pass |
| `packages/plugin-sdk` | the plugin API 1.0.0 types, errors and helpers |
| `packages/plugin-host` | the plugin host and the enrichment, checks and dedup engines |
| `packages/client-ts` | placeholder |
| `plugins/` | first-party plugins: `resolvers-core`, `checks-core`, `dedup-core` |
| `spec/` | OpenAPI, plugin manifest schema, ADRs, data model |
| `docs/` | Quarto documentation site |
| `deploy/` | Dockerfile and docker-compose with sidecar profiles (untested) |
| `fixtures/` | the generated Zotero library, the format fixtures, and the Phase 2 corpora: scans, mail, archives, a Paperless-ngx dump and rule cases |

## Licence

AGPL-3.0-or-later — see [`LICENSE`](LICENSE).
