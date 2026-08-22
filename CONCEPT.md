# Recueil — Concept and Roadmap

| | |
|---|---|
| Status | Draft v0.1 |
| Date | 2026-08-22 |
| Name | *Recueil* (working title; alternatives in §9, decision in ADR-019) |
| License | AGPL-3.0 (ADR-005) |
| Scope | Self-hosted, API-first document and reference manager with built-in reference verification, bibliometrics and systematic-review workflow |

---

## 0. One-liner

Recueil is a self-hosted server that gathers documents from anywhere (browser, mail, scanner, WebDAV, camera), keeps a content-addressed library with a bibliographic facet, verifies and enriches references against the open scholarly graph, and exposes the whole library to R, Python and LLMs as data. Systematic reviews and bibliometric mapping are native workflows, not exports.

**Positioning:** Zotero's capture ecosystem + Paperless-ngx's ingestion model + bibliometrix/VOSviewer's analysis layer + Covidence/Rayyan's screening workflow, in one AGPL server with thin cross-platform clients.

**Tagline:** Gather. Verify. Map.

---

## 1. Problem statement

Reference managers are desktop-first with sync bolted on. Self-hosting is painful or impossible, plugin APIs churn, there is no first-class read/write API, and systematic-review and bibliometric work happens outside the library via export files. Document managers (Paperless-ngx) solve ingestion but have no bibliographic model. SR and bibliometric tools are SaaS or file-based, so data leaves the library and comes back by hand. Reviewers have no tool that verifies a reference list for existence, retraction or preprint status.

The current working stack is Zotero + three self-written plugins + Paperless-ngx + R scripts + manual glue. Every integration is a one-off.

---

## 2. Goals and non-goals

### Goals (v1, measurable)

| # | Goal | Measure |
|---|---|---|
| G1 | Replace Zotero for daily use | Own library imported with 100% item-count match and attachment-hash coverage report; daily capture via connector; no Zotero launch for 30 days |
| G2 | Replace Paperless-ngx for incoming paper | Scanner/mail/WebDAV → library with zero manual filing for standard flows; auto-accept rate > 90% |
| G3 | Retire Metadata Mender, Attaclone-dedup, Argus One | Parity tests pass on a fixture library; plugins archived |
| G4 | Bibliometrics in R in one call | `rc_bibliometrix()` returns a bibliometrix `M` data frame that runs in biblioshiny unmodified |
| G5 | One systematic review end-to-end | PRISMA 2020 flow exported from live counts; extraction data loads in R without reshaping |
| G6 | Nothing is UI-only | Every feature reachable via REST and MCP |

### Non-goals (v1)

| Non-goal | Why |
|---|---|
| Word / LibreOffice / Google Docs citation plugins | Hardest part of Zotero; BibTeX + CSL-JSON + Quarto cover the LaTeX/Overleaf workflow. Revisit via Zotero's integration protocol post-1.0 |
| Paperless-ngx feature parity | Only what ingestion needs (consume, rules, custom fields). Workflows/permissions UI is a rabbit hole |
| Multi-user collaboration | Single user with token auth first; data model designed for users/groups so it can be added without migration pain |
| Offline-first sync / CRDTs | Server is the source of truth; clients cache and queue writes. Real offline sync is a multi-year project |
| Own citation engine, translators, OCR, layout engine | Reused (citeproc-js, Zotero translators, OCRmyPDF, Cytoscape.js/Sigma.js) |
| A Gephi/VOSviewer competitor | In-app maps for orientation and curation; heavy layout and analysis exported |
| Full management UI on mobile | Mobile is capture and reading |

---

## 3. Binding principles

| # | Principle | Consequence |
|---|---|---|
| P1 | Server is the source of truth | All clients are thin; no per-device sync engine; conflicts logged, not merged |
| P2 | Content hash is identity | Files are deduplicated by SHA-256; path, name and mtime never define sameness |
| P3 | Flag, never guess | Ambiguous ingestion, dedup and enrichment outcomes go to a review queue with a logged reason |
| P4 | Provenance on every derived fact | Metadata fields, graph edges and merges carry source, timestamp and confidence |
| P5 | Never delete | Trash with restore; append-only audit log |
| P6 | API-first | OpenAPI spec is the contract; web UI, CLI, MCP, R and Python are clients of the same API |
| P7 | Reuse over rebuild | Every component in §5.16 was chosen because someone else maintains it |
| P8 | Plugin contract before UI | Hook catalogue and manifest schema are Phase 0 deliverables; first-party features are plugins |
| P9 | Idempotent, resumable batch operations | Imports, enrichment and dedup runs can be re-run safely |
| P10 | No lock-in | Everything exportable in open formats; file storage readable without the application |

---

## 4. Benchmarks

| Tool | Take | Leave |
|---|---|---|
| Zotero | Connector protocol, translators, CSL, item/attachment model, annotation concepts, Zotero-style keys | XUL/Firefox desktop, sync server, plugin API churn |
| JabRef | BibTeX fidelity, field customisation, integrity checks | File-based model |
| EndNote | Style coverage expectations | Closed, desktop |
| Paperpile | Chrome-first capture, clean web UI | Proprietary, Google-bound |
| Paperless-ngx | Consume pipeline, mail consumer, ASN, custom fields, tags, OCR, Docker packaging | No bibliographic model |
| Citavi | Knowledge organisation (quotes/thoughts), task planning | Windows, dormant |
| Covidence / Rayyan | Screening UX, conflict resolution, PRISMA counting | SaaS |
| bibliometrix / biblioshiny | Analysis catalogue, `M` data frame conventions | Export-file workflow |
| VOSviewer / CiteSpace | Maps, thesaurus files, burst detection | Standalone, no library |
| Connected Papers / Litmaps / ResearchRabbit / Local Citation Network | Deep-dive UX, seed-and-expand | External-only; proprietary (LCN excepted) |
| Scite | Citation context and intent | Proprietary model; Recueil runs SciCite locally on owned PDFs |
| I, Librarian / Wikindx | Precedent for web-based self-hosted reference management | Dormant, PHP |

---

## 5. Architecture

### 5.1 Topology

```
CLIENTS
  Web UI (SPA) | Tauri 2 desktop (macOS/Win/Linux) | Tauri 2 / Capacitor mobile (iOS/Android)
  PWA | WebExtension connector (Chrome/Edge/Firefox/Safari) | CLI | R package | Python package | MCP server
        |                         |                           |
        v                         v                           v
RECUEIL SERVER  (Node/TypeScript, one Docker image; same binary as Tauri sidecar in local mode)
  REST /api/v1 (OpenAPI 3.1)  ·  SSE events + webhooks  ·  /connector/* (Zotero protocol)  ·  MCP
  Core services: ingestion · enrichment · checks · dedup · graph · search · export · SR · plugin host · job queue
        |
        v
STORAGE
  SQLite (default) or Postgres  ·  file backends: local FS | WebDAV | S3  ·  analytics export: Parquet
        |
        v
OPTIONAL SIDECARS (docker-compose profiles)
  GROBID · OCRmyPDF/Tesseract worker · Meilisearch · zotero/translation-server · SciCite intent model
```

Local mode: the Tauri desktop shell bundles the server as a sidecar process on localhost. Docker and local mode run identical code.

### 5.2 Data model (core entities)

| Entity | Key fields | Notes |
|---|---|---|
| Document | id, sha256, mime, size, created, source provenance | Every file is a Document. Identity = hash (P2) |
| Item | id, type, facets | The library record. Types: article, book, chapter, report, thesis, dataset, preprint, webpage, invoice, letter, contract, photo, … |
| Item.Bibliographic | title, creators, venue, date, identifiers (DOI, PMID, PMCID, arXiv, ISBN, OpenAlex, S2), abstract, keywords, MeSH, language, citation_key, field-level provenance + manual-lock flags | Facet present on scholarly items |
| Item.Office | correspondent, document date, ASN, amount, reference number | Facet for private/office documents (Paperless mapping) |
| Attachment | item_id, document_id, role (primary, supplement, snapshot, scan), has_annotations | Many-to-many between Items and Documents |
| Collection | hierarchical | |
| Tag | name, colour, scheme | |
| CustomField / FieldValue | typed: text, number, date, choice, multi, json, item-reference | Basis for SR extraction forms |
| Note | markdown, item_id optional | |
| Annotation | target (document + selector), body, type (highlight, note, area, ink), colour, author | W3C Web Annotation data model; stored as records, exportable to embedded PDF annotations |
| Creator | name forms, ORCID, OpenAlex author id, disambiguation status | |
| Term | scheme (author_keyword, mesh, tag, openalex_topic, custom), hierarchy (MeSH tree numbers), ThesaurusMap rules | Vocabulary layer for graph roll-ups |
| GraphNode | type (item, shadow_work, creator, venue, term, institution), external ids | |
| GraphEdge | type (cites, co_cited, coupled, co_occurs, co_author, same_as, version_of), weight, provenance (source, fetched_at, confidence), evidence (e.g. citation context) | |
| ShadowWork | external work stub from reference lists / deep dive | Promotable to Item; never pollutes the library |
| ReviewQueueEntry | subject, reason, proposed action, status | P3 |
| Job | type, params, state, idempotency key, log | P9 |
| AuditLog / Trash | actor, action, before/after, timestamp | P5 |
| Review, SearchRun, ScreeningDecision, ExtractionForm, RoBAssessment, PrismaCounts | §5.10 | |
| CuratedNetwork | JSON document: nodes (item refs), edges, layout, style, annotations; version history; frozen snapshot | §5.9 |
| Plugin | manifest, version, enabled, settings | §5.13 |
| User / ApiToken | single user in v1; schema ready for multi-user | |

### 5.3 Ingestion pipeline

**Sources** (all feed the same pipeline): watched folders · WebDAV feed (e.g. a Nextcloud share) · IMAP mailbox (attachments as Documents, body as Note, rules by sender/subject) · scanner (ADS-4700W → folder/SFTP/WebDAV/mail) · mobile capture (camera scan, barcode ISBN/DOI, share sheet) · WebExtension connector (Zotero protocol) · translation-server (URL, DOI, PMID, ISBN, arXiv) · API/CLI upload · bulk importers (§6).

**Stages:**

1. Hash, size, MIME type.
2. Exact duplicate check against Document hashes → link to existing, log, stop.
3. Archive extraction (zip, eml) to scratch; inner files re-enter at stage 1.
4. Type detection (scholarly PDF, scan, office document, image).
5. OCR when no text layer (OCRmyPDF) → text layer + extracted text.
6. Metadata extraction: GROBID for scholarly PDFs (title, authors, DOI, abstract, reference list, in-text citation contexts); date/correspondent heuristics for office documents.
7. Identifier resolution → enrichment (§5.4).
8. Rule engine: match on source, sender, path, text regex, resolver result → item type, collection, tags, custom fields.
9. Confidence gate: auto-accept above threshold, otherwise ReviewQueue with reason (P3).
10. Single transaction commit; events emitted.

Properties: idempotent by (hash, source, path); resumable; configurable concurrency with a conservative default; scratch space for archive extraction is cleaned after hashing.

### 5.4 Enrichment (resolvers)

| Source | Use | Key |
|---|---|---|
| Crossref | DOI metadata, references, update-to (retractions), polite pool | Optional Plus token |
| OpenAlex | Works, authors, venues, topics, `referenced_works`, `cited_by`, metrics (`cited_by_count`, venue `2yr_mean_citedness`); CC0 | Optional key (needed at scale) |
| PubMed / NCBI E-utilities | PMID/PMCID, MeSH, abstracts | Optional key |
| Semantic Scholar | Citations, citation intents, influential citations, TLDR | Optional key |
| DataCite | Dataset and software DOIs | — |
| arXiv | Preprints, versions, published DOI relation | — |
| OpenLibrary / Google Books | ISBN | — |
| ORCID | Author identity | — |
| Unpaywall | OA PDF location | Email |

Design: one `Resolver` interface (lookup by id · search by metadata · fetch references/citations · fetch metrics) · adaptive per-source rate limiting (ported from Metadata Mender) · per-field merge policy with preferred source order · manual edits locked per field and never overwritten · batch jobs with cache and TTL · metrics stored with timestamp for time series.

### 5.5 Checks (verification engine)

Each check has an id, severity, auto-fix capability and a human-readable explanation. Results are stored with a timestamp and exportable as a report (CSV, Markdown).

| Check | Detects |
|---|---|
| completeness | Required fields per item type / citation style |
| identifier_syntax | Malformed DOI, ISBN checksum, PMID format |
| doi_resolves | DOI does not resolve, or resolved metadata disagrees with the record (title similarity, year, first author) |
| existence | No identifier and no match in Crossref/OpenAlex/PubMed/S2 → "unverifiable, possible fabrication" |
| retraction | Retraction, correction, expression of concern (Crossref update-to, Retraction Watch) |
| preprint_published | A published version exists for a preprint record (OpenAlex/Crossref relations, arXiv DOI) |
| version_duplicate | Same work, different versions in the library |
| author_consistency | Name forms disagree with ORCID/OpenAlex |
| venue_issn | Invalid or mismatched ISSN |
| plausibility | Page ranges, volume/issue, dates out of range |
| oa_status | OA copy available but not attached |
| citation_key | Collisions, drift from formula |
| attachment_integrity | Hash mismatch, no text layer, PDF title does not match record |

Modes: on import, on demand, scheduled. **Bibliography audit mode:** paste a reference list (text or BibTeX) that is not in the library → parse (GROBID / AnyStyle) → run checks → report. This is the peer-review deliverable.

### 5.6 Deduplication engine

**File layer:** exact (hash) → auto-link. Near-duplicate (simhash of extracted text, e.g. re-scans, different PDF versions) → flag only. Routing: byte-identical → auto; differing annotations or notes → review (Attaclone logic).

**Record layer:** identifier match after normalisation (DOI, PMID, PMCID, arXiv, ISBN) → fuzzy match (normalised title + year ± 1 + first author + venue, configurable thresholds, blocking for scale). Merge policy configurable: winner rule (newest `dateAdded` / most complete / manual), union of collections, tags, notes; attachments re-parented; loser kept in trash with a reversible merge record (Argus One logic). Rules editable as YAML/JSON in the UI; dry-run report before execution.

**SR-specific:** dedup across database exports with per-source tracking, because PRISMA needs "records identified per source" and "duplicates removed".

### 5.7 Search and full text

SQLite FTS5 baseline; Meilisearch sidecar for larger libraries. Indexed: metadata, notes, annotations, extracted text. Faceted filters, boolean query syntax, per-field search, saved searches as smart collections. "Find similar" via text embeddings is a post-1.0 plugin.

### 5.8 Graph and bibliometrics

**Edge acquisition:** reference lists and citing works from OpenAlex, Crossref and Semantic Scholar; reference lists and in-text citation contexts from owned PDFs via GROBID. Local citation network (which library items cite which) is computed on demand and scheduled.

**Derived networks:** co-citation, bibliographic coupling, co-word (per vocabulary scheme, with thesaurus roll-up), co-authorship, institutional collaboration. Thresholds and normalisation (association strength, Salton) configurable.

**Auto mode:** projection + similarity measure + threshold → rendered map (Sigma.js, WebGL), with coverage statistics shown next to every map (P4): how many items had reference data, from which sources, fetched when.

**Deep dive:** seed (items, collection, search) → expand along cites / cited-by / similar, with a budget (node cap, depth, per-source quota) → results stored as ShadowWorks → optional promotion to Items → optional screening queue. Deep dive is backward/forward snowballing; in SR context every expansion is logged in PRISMA-S terms.

**Citation contexts:** GROBID in-text references → surrounding sentences → optional SciCite classifier (background / method / result) running in a local container → stored as edge evidence. Enables "how does my corpus cite X" queries. Nothing open source does this on a personal library.

**Analytics layer (the R/Python integration):** `GET /analytics/export` produces a Parquet bundle (works, creators, works_creators, terms, works_terms, edges, metrics, sr tables). DuckDB can attach the SQLite file directly in local mode. Converters: bibliometrix `M` data frame (WoS tag mapping: AU, AF, TI, SO, DT, DE, ID, AB, C1, CR, TC, PY, DI, SR, …), VOSviewer network/map JSON, Gephi GEXF, GraphML, CiteSpace WoS text, CSV.

### 5.9 Curated networks (publication preparation)

A CuratedNetwork is a versioned JSON document, not a picture: nodes reference item ids (so metadata updates propagate), plus free nodes and groups; edges are manual or inherited with provenance; layout holds positions, pinned nodes, algorithm and parameters, optional timeline axis by year; style maps colour/shape/size to fields or manual values; annotations cover labels, callouts, clusters/hulls, legends, text boxes. A frozen snapshot embeds metadata at freeze time for reproducibility.

Editor: Cytoscape.js with undo/redo, import of selections from auto maps, and exports to SVG/PDF/PNG, GraphML/GEXF/JSON, TikZ, and tidygraph (via the R package) for final rendering in ggraph. The depth of in-app publication rendering is ADR-013 (open).

### 5.10 Systematic review module

PRISMA 2020 pipeline, solo-first, data model ready for a second screener.

1. **Review setup:** protocol fields, PICO, registration id, automation disclosure setting (ADR-020).
2. **Sources:** search runs (database, query string, date, n) with import of PubMed, Embase RIS, WoS, Scopus, Cochrane exports and direct OpenAlex queries; every record tagged with its source.
3. **Dedup** with source tracking (§5.6).
4. **Title/abstract screening:** keyboard-driven, exclusion reasons, tags, undo, progress, blind mode reserved for a second screener.
5. **Full-text retrieval** (Unpaywall, manual) and **full-text screening** with mandatory exclusion reasons.
6. **Snowballing** via deep dive (§5.8), logged per PRISMA-S.
7. **Extraction forms** generated from custom-field schemas; templates for RCT, observational, diagnostic designs; repeatable arms and outcomes.
8. **Risk of bias:** RoB 2, ROBINS-I, Newcastle-Ottawa, QUADAS-2 as JSON schemas (signalling questions → domain judgements); traffic-light export via `robvis`.
9. **PRISMA counts** computed live; flow diagram export (PRISMA2020 R package input, SVG).
10. **Export:** `meta`/`metafor`-ready data frames, CSV/Parquet, Quarto report template.
11. **Audit trail** for every decision.

Build order: import + dedup → screening → PRISMA counter → export → extraction → RoB → snowballing → report template.

### 5.11 Citation and export

CSL via citeproc-js (bundled style repository, updatable). Formats: CSL-JSON, BibTeX/BibLaTeX with stable citation keys (formula compatible with Better BibTeX defaults, key pinned per item, lockable; ADR-016), RIS, JSON-LD. Per-collection and per-saved-search `.bib` endpoints with tokened URLs for Overleaf, Quarto and Pandoc. Word-processor integration deferred (non-goal); the likely post-1.0 route is implementing Zotero's integration protocol so existing Word/LibreOffice plugins can talk to Recueil.

### 5.12 API, MCP and language clients

**REST `/api/v1`** from an OpenAPI 3.1 spec generated from Zod schemas. Resources: items, documents, attachments, collections, tags, fields, notes, annotations, creators, terms, graph (nodes, edges, deep-dive), analytics, checks, dedup, ingestion (sources, queue, review), sr (reviews, screening, extraction, rob, prisma), networks, plugins, jobs, search, export, system. Scoped API tokens; session auth for the UI; SSE event stream and webhooks; bulk endpoints with idempotency keys; cursor pagination for records, Parquet for analytics.

**MCP server:** tool set derived from the OpenAPI spec (search, get/add/update item, run checks, dedup dry-run, deep dive, export BibTeX, screening decisions, extraction writes), resources (library statistics, review status), prompts (reference audit, screening assistance). Writes made through MCP are attributed in the audit log like any other API token.

**CLI:** `recueil serve | import | export | check | dedup | ingest | graph | sr | backup | restore`, mirroring the API.

**R package `recueil`** (httr2): `rc_items()`, `rc_search()`, `rc_bibtex()`, `rc_analytics()` (Arrow/DuckDB), `rc_bibliometrix()` → `M` data frame, `rc_graph()` → tidygraph/igraph, `rc_network_export()` (VOSviewer, Gephi), `rc_sr_*()` (screening, extraction, PRISMA), `rc_checks()`. Vignettes: migrate from Zotero, bibliometric study, SR extraction to `metafor`. CRAN-ready.

**Python package `recueil`** (httpx): typed models from OpenAPI, polars/pandas frames, networkx/igraph graphs, same function surface.

### 5.13 Plugin system

Four extension surfaces, in order of expected use:

1. **API and MCP scripts.** Most "plugins" are scripts. A complete API removes the need for most plugins.
2. **Server plugins.** npm packages with a `recueil.plugin.json` manifest (name, version, plugin-API range, permissions, hooks implemented, settings schema, UI contributions). In-process and trusted in v1; worker/WASM sandboxing deferred (ADR-018).
3. **UI plugins.** Registry API for item-pane sections, sidebar panels, context actions, network renderers, screening panels. Manifest modelled on WebExtensions (manifest + declared permissions + sandboxed script) because every extension developer already knows it.
4. **Translators.** Zotero's, via translation-server and the connector protocol.

**Hook catalogue (v1):** `resolver`, `check`, `dedupRule`, `ingestSource`, `ingestStage`, `storageBackend`, `exporter`, `importer`, `graphEdgeProvider`, `analyticsExport`, `srTemplate`; lifecycle events `item.created|updated|merged|trashed|restored`, `document.ingested`, `attachment.added`, `annotation.created`, `check.completed`, `job.started|finished|failed`.

**Developer experience:** `@recueil/plugin-sdk` (typed), `create-recueil-plugin` template with a working example, compatibility test suite plugins run in their own CI, plugin API versioned independently of the app with a two-minor-version deprecation window, registry as a JSON index in a GitHub repo with install-from-URL.

**First-party plugins (dogfood the contract):** resolver-openalex, resolver-crossref, resolver-pubmed, resolver-s2, resolver-datacite, resolver-isbn, checks-core, dedup-files, dedup-records, ingest-imap, ingest-webdav, ingest-folder, storage-webdav, storage-s3, export-bibliometrix, export-vosviewer, export-gephi, sr-templates, citation-context-scicite.

### 5.14 Clients

**Web UI:** React + TypeScript; three-pane library; item pane composed of sections (core + plugin); PDF reader (PDF.js) with the annotation layer; graph views; SR workspace; review queue; settings. Keyboard-first.

**Desktop (Tauri 2, macOS/Windows/Linux):** watched folders, local storage backend, localhost connector endpoint, tray, `recueil://item/<id>` URI scheme for deep links from Overleaf/Quarto, open-in-external-app (Acrobat, Okular), native dialogs, auto-update. Caveat: Linux renders in WebKitGTK; PDF.js performance there is a Phase 4 test.

**Mobile (Tauri 2 mobile, Capacitor as fallback):** capture first: camera document scan with edge detection, barcode ISBN/DOI lookup, share sheet "save to library"; reading on cached PDFs with annotations; queued writes; search. No management UI. PWA covers anyone who will not install an app.

**Connector:** Zotero Connector unchanged in Phases 1–7; own WebExtension in Phase 8 (same protocol plus collection/tag picker, office-document capture, page snapshot → Document), published to Chrome Web Store, AMO and Safari.

**Offline model:** cache + write queue + conflict log. Server wins on conflict; the rejected write stays in the log for manual replay. No merging.

### 5.15 Security and operations

Single user with scoped tokens; HTTPS via reverse proxy; Tailscale-friendly; secrets via environment; structured logs; `/health` and Prometheus metrics; `recueil backup` produces a consistent snapshot of database + storage manifest + config in a restic-friendly layout; restore is tested in CI. Multi-user (users, groups, shared libraries, per-item permissions) is designed for, not built, in v1.

### 5.16 Technology decisions

| ADR | Decision | Reason |
|---|---|---|
| 001 | Server-first architecture | Every listed feature needs a server; desktop is a shell |
| 002 | TypeScript monorepo | Server, web UI, extension and Zotero translators share one language and runtime |
| 003 | SQLite default, Postgres optional (Drizzle ORM) | Single-user simplicity; Postgres for multi-user deployments |
| 004 | Content-hash identity | P2 |
| 005 | AGPL-3.0 | Required by Zotero translators and translation-server; prevents SaaS capture |
| 006 | Zotero connector protocol compatibility | Existing extension and ~600 translators work on day one |
| 007 | Tauri 2 for desktop and mobile shells | One UI codebase, no Electron, mobile support |
| 008 | Parquet/DuckDB analytics layer | Bibliometrics needs tables, not paginated JSON |
| 009 | Annotations as records (W3C Web Annotation model) | Portable across PDF.js on every platform; exportable to embedded annotations |
| 010 | Persistent in-process job queue (SQLite-backed); Redis/BullMQ optional with Postgres | No mandatory Redis for single-user |
| 011 | FTS5 baseline, Meilisearch optional | Small libraries need no sidecar |
| 012 | Plugin host in-process, trusted, in v1 | Sandboxing only when multi-user exists |

Stack: Node 22 LTS · TypeScript · Fastify · Drizzle · Zod → OpenAPI · React + Vite · TanStack Query/Router · PDF.js · Cytoscape.js · Sigma.js · citeproc-js · Tauri 2 · Vitest + Playwright · pnpm workspaces · Turborepo · Changesets · Docker multi-arch (amd64/arm64) · GitHub Actions · Renovate · Quarto docs → GitHub Pages.

Licence compatibility to verify per component (all known compatible with AGPL-3.0): GROBID (Apache-2.0), OCRmyPDF (MPL-2.0), Meilisearch (MIT), PDF.js (Apache-2.0), citeproc-js (CPAL/AGPL dual), Cytoscape.js (MIT), Sigma.js (MIT), translation-server (AGPL-3.0), translators (AGPL-3.0).

---

## 6. Migration and import

**Zotero (first-class, Phase 1):** read `zotero.sqlite` (items, fields, creators, collections, tags, notes, relations, imported and linked attachments, annotations, Zotero 8 native citation keys or Better BibTeX keys from `better-bibtex.sqlite` / Extra) → storage directory or WebDAV zips → hash → Documents. Produces a verification report (counts per type, attachment hash coverage, missing files routed to `_REVIEW/` with reasons). Idempotent re-runs; Zotero item keys kept as external ids. Zotero stays read-only until M1 is confirmed.

**Paperless-ngx (Phase 2):** API export of documents, tags, correspondents, document types, custom fields, ASN + originals → Office facet.

**Others:** BibTeX/BibLaTeX (with `file` fields), RIS, EndNote XML, CSL-JSON, JabRef (BibTeX + groups), Mendeley (via export), CSV with mapping. Exports mirror importers (P10).

---

## 7. Roadmap

Format: phases, each a shippable `0.x` release, with exit criteria instead of dates (solo, incremental). Effort is relative (S/M/L/XL). Phases 1–3 are the critical path because they retire the current stack.

| Phase | Theme | Effort | Milestone |
|---|---|---|---|
| 0 | Spec and scaffold | M | — |
| 1 | Core library + Zotero migration | L | **M1 Zotero replaced** |
| 2 | Ingestion + storage backends | M | **M2 Paperless replaced** |
| 3 | Enrichment, checks, dedup | L | **M3 Plugins retired** |
| 4 | Reading, search, desktop shell | M | — |
| 5 | Graph, bibliometrics, R/Python | L | **M4 Bibliometrics in R** |
| 6 | Curated networks | M–L | — |
| 7 | Systematic review | XL | **M5 First SR end-to-end** |
| 8 | Mobile + own connector | M | — |
| 9 | Community and 1.0 | M, ongoing | **M6 1.0** |

### Phase 0 — Spec and scaffold

- ADRs 001–012 written; ADR-013/014/016/019 decided (§10).
- Data model v1: ERD, migrations, fixture library.
- OpenAPI v1 skeleton; plugin manifest schema; hook catalogue.
- Monorepo scaffold (§8), CI, Docker build, docs site, LICENSE, CITATION.cff, CONTRIBUTING, global no-trace hygiene applied to the repo template.
- **Exit:** `recueil serve` returns health with an empty library; the spec has been checked against Metadata Mender, Attaclone-dedup and Argus One, and the answer to "can each be expressed as a plugin?" is documented.

### Phase 1 — Core library + Zotero migration → M1

- Items, documents, attachments, collections, tags, notes, custom fields; content-hash local storage; SQLite.
- REST v1 for all of the above; CLI; Docker image; backup/restore.
- Web UI: library view, item pane, basic PDF viewing (no annotation yet).
- Zotero importer with verification report; BibTeX/CSL-JSON/RIS export with stable citation keys; `.bib` endpoint for Overleaf/Quarto.
- Connector endpoint (Zotero Connector works unchanged); translation-server integration for URL/DOI/PMID/ISBN import.
- **Exit:** own library imported at 100% item count with attachment-hash coverage report; daily capture via connector; Overleaf builds from the exported `.bib`; 30 days without launching Zotero.

### Phase 2 — Ingestion + storage backends → M2

- Pipeline stages (§5.3); watched folders; WebDAV feed; IMAP; scanner path; rule engine; review queue UI.
- OCRmyPDF worker; Office/Private facets; Paperless-ngx importer.
- WebDAV and S3 storage backends; PWA upload as interim mobile capture.
- **Exit:** scanner → searchable item with zero manual steps; mail → library; Paperless decommissioned after verified import.

### Phase 3 — Enrichment, checks, dedup → M3

- Resolver framework with all sources in §5.4; field provenance and merge policy; metrics time series.
- Checks engine, report export, bibliography audit mode.
- File and record dedup with rules UI and dry-run reports.
- Plugin SDK v1 with these shipped as first-party plugins; compatibility test suite.
- **Exit:** parity tests against the three Zotero plugins on the fixture library pass; plugins archived; one real manuscript review delivered with the reference audit report.

### Phase 4 — Reading, search, desktop shell

- Annotations as records; PDF.js annotation layer; export to embedded PDF annotations.
- FTS5 and Meilisearch; saved searches / smart collections.
- GROBID sidecar for metadata, reference lists and citation contexts (feeds Phase 5).
- Tauri desktop v1: watched folders, tray, URI scheme, open-in-external-app; WebKitGTK PDF.js performance test on Linux.
- **Exit:** annotate → note → cite works entirely inside the app, in browser and desktop shell.

### Phase 5 — Graph, bibliometrics, R/Python → M4

- Graph schema live (from Phase 0), edge providers, shadow works, local citation network, derived networks, deep dive with budgets.
- Vocabulary layer, MeSH tree import, thesaurus maps.
- Analytics Parquet export; DuckDB attach; in-app Sigma.js maps with coverage statistics.
- R package v0.1 (client, analytics, `rc_bibliometrix()`, tidygraph, VOSviewer/Gephi exports); Python package v0.1.
- **Exit:** `rc_bibliometrix()` output runs in biblioshiny unmodified; a VOSviewer map renders from the export; local citation network of the own library rendered in-app.

### Phase 6 — Curated networks

- CuratedNetwork document model, Cytoscape.js editor, annotations, versions, freeze.
- Exports: SVG/PDF/PNG, GraphML/GEXF/JSON, TikZ, tidygraph.
- **Exit:** one publication figure produced end-to-end, in-app or via ggraph, per ADR-013.

### Phase 7 — Systematic review → M5

In the designed order: sources + import + dedup with source tracking → title/abstract screening → PRISMA counter → full-text retrieval and screening → export (`meta`, `metafor`, PRISMA2020, `robvis`) → extraction forms → RoB templates → snowballing via deep dive → Quarto report template. Gets its own spec before work starts.

- **Exit:** a real review run start to finish; PRISMA flow exported from live counts; extraction data loads in R without manual reshaping.

### Phase 8 — Mobile + own connector

- Tauri mobile (Capacitor fallback): camera scan, barcode, share sheet, cached reading, queued writes.
- Own WebExtension superseding the Zotero Connector; published to Chrome Web Store, AMO, Safari.
- **Exit:** phone capture to library in under 30 seconds; extension listed in the Chrome Web Store.

### Phase 9 — Community and 1.0 → M6

- Plugin registry, `create-recueil-plugin`, docs site complete, demo library.
- Release hygiene: README citation blocks (BibTeX/APA), CITATION.cff, Zenodo DOI, multi-arch images, upgrade guarantees, security review.
- Governance: public roadmap, DCO, issue templates; multi-user groundwork.
- **Exit:** 1.0 tag; plugin API v1 frozen; at least one plugin not written by the maintainer.

### Sequencing rules

- Never start Phase 6 or 7 before Phase 5's graph schema is in production.
- Phases 4 and 5 may interleave; Phase 8 is cheap once the API is stable.
- Any scope addition to a phase removes something from it or moves to the parking lot.

### Parking lot (post-1.0)

Word/LibreOffice/Docs integration via Zotero's integration protocol · multi-reviewer screening with conflict resolution · embeddings-based similarity plugin · citation-intent UI · Wikidata/Wikicite sync · OpenAlex topic clustering · altmetrics · HTML snapshot annotation · Quarto extension · LLM-assisted screening with per-decision disclosure · Overleaf git bridge for `.bib` sync.

### Risks

| Risk | Mitigation |
|---|---|
| Scope creep | Non-goals in §2; one spec per phase; parking lot; additions are zero-sum |
| Dependency on Zotero translators / translation-server | Pin versions; id-based fallback import via Crossref/OpenAlex; own connector in Phase 8 |
| API policy changes (OpenAlex, S2) | Resolver abstraction, caching, key support, multiple sources per fact |
| Tauri mobile maturity | PWA first; Capacitor fallback |
| WebKitGTK PDF.js performance on Linux | Test in Phase 4; browser UI is always available |
| Citation coverage gaps produce misleading maps | Provenance and coverage statistics on every map (P4) |
| Solo sustainability | Small releases, boring technology, docs from day one, every phase independently useful |
| Data loss in migration | Idempotent importers, verification reports, Zotero read-only until M1 confirmed |
| Licence compatibility | Component audit in Phase 0 (§5.16) |

---

## 8. Repository layout

All repositories live in the `etabli` GitHub organisation from the first commit (org slug to confirm).

```
etabli/recueil               monorepo, AGPL-3.0
  apps/server/               Fastify app, job runner, plugin host
  apps/web/                  React SPA
  apps/desktop/              Tauri 2 (server as sidecar)
  apps/mobile/               Tauri 2 mobile / Capacitor
  apps/connector/            WebExtension (Phase 8)
  apps/cli/
  apps/mcp/                  MCP server over the API
  packages/core/             data model, migrations, services
  packages/schemas/          Zod → OpenAPI, shared types
  packages/plugin-sdk/       @recueil/plugin-sdk
  packages/client-ts/        generated TypeScript client
  plugins/                   first-party plugins (§5.13)
  spec/                      openapi.yaml, plugin-manifest.schema.json, ADRs, ERD
  docs/                      Quarto site
  deploy/                    docker-compose with sidecar profiles
  fixtures/                  test libraries (Zotero, Paperless, BibTeX, RIS)
etabli/recueil-r             R package, separate repo (CRAN)
etabli/recueil-py            Python package, separate repo (PyPI)
etabli/recueil-registry      plugin index JSON
etabli/recueil-plugin-*      community plugins may use this prefix in any org; first-party ones live in the monorepo
```

**Naming scopes:** the org carries the suite identity, the packages carry the product identity. GitHub: `etabli/recueil*`. npm: `@recueil/*` (plugin authors think in product terms, and the SDK name should not change if the suite grows). CRAN/PyPI: `recueil`. Docker: `ghcr.io/etabli/recueil`. Docs: `etabli.github.io/recueil` until a custom domain exists. Repo hygiene follows the established suite pattern: README with BibTeX/APA citation blocks, CITATION.cff, Quarto docs → GitHub Pages, Zenodo DOI at first release.

---

## 9. Naming

**Recommended: Recueil.** French for a compiled collection of texts in one volume; the root *cueillir* (to gather) describes the ingestion model. No software collision found; accent-free; works as `recueil` on CRAN, PyPI and npm (`@recueil/*`), as a CLI and as a URI scheme.

| Alternative | Meaning | Note |
|---|---|---|
| Pupitre | desk / lectern | Furniture register closest to *établi*; neutral on documents |
| Fiche | index card, card catalogue | Strongest library meaning; collides with the `fiche` pastebin server behind termbin |
| Signet | bookmark; seal of authenticity | Verification connotation; search noise from Bitcoin signet |
| Lutrin | lectern | Rejected: collides with Lutris |

Module names stay functional English (server, web, connector, sdk). No second vocabulary before 1.0.

---

## 10. Open decisions (ADR backlog)

| ADR | Question | Blocks | Recommendation |
|---|---|---|---|
| 013 | Publication figures rendered in-app (real editor) or via ggraph from a curated tidygraph export (in-app is a curation canvas)? | Phase 6 scope | Curation canvas + ggraph; revisit after first figure |
| 014 | Tool-for-you first, or community project from day one? | Phase 0 depth, docs effort | Tool-for-you through M3, open the repo at M4 |
| 015 | SQLite-only until multi-user? | — | Yes |
| 016 | Citation-key formula: Better BibTeX default-compatible or own? | Phase 1 export | BBT-compatible default (`auth.lower + shorttitle(3,3) + year`), formula configurable |
| 017 | Annotation storage format | Phase 4 | W3C Web Annotation JSON |
| 018 | Sandboxing tier for third-party plugins | Phase 9 | In-process until multi-user |
| 019 | Name | Phase 0 | Recueil |
| 020 | SR automation disclosure: per-review setting recording which decisions were tool-assisted | Phase 7 | Per-review setting, off by default, exported with the audit trail when on |

---

## 11. Success metrics

**Leading:** migration report at 100% (M1) · days since last Zotero launch · ingestion auto-accept rate > 90% for scans and mail (M2) · check false-positive rate < 5% on the fixture set (M3) · scan-to-searchable under 2 minutes · phone capture under 30 seconds (Phase 8).

**Lagging:** three Zotero plugins archived · one SR completed in the tool · R package on CRAN · one external plugin · Paperless container removed from the homelab stack.
