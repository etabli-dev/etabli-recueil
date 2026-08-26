# Architecture decision records

Every architectural decision in Recueil is recorded here as a numbered, dated, immutable document.
An ADR is never edited once accepted: it is superseded by a later one, and both stay in the
repository so the reasoning is readable in order.

Each record uses the same shape — status, date and phase, then **Context**, **Decision** and
**Consequences**. The consequences section states what the decision costs, not only what it buys; an
ADR with no cost in it has not been thought through.

**Status** is one of Proposed, Accepted, Superseded (by ADR-NNNN) or Deprecated.

**Phase** is the phase in which the decision was taken, following the roadmap in CONCEPT.md §7. Where
that differs from the phase the decision governs, both are given.

ADRs 0001–0012 are the technology decisions catalogued in CONCEPT.md §5.16. ADRs 0013–0020 resolve
the open-decision backlog in CONCEPT.md §10.

## Index

| # | Title | Status | Phase |
|---|---|---|---|
| [0001](0001-server-first-architecture.md) | Server-first architecture | Accepted | Phase 0 |
| [0002](0002-typescript-monorepo.md) | TypeScript monorepo | Accepted | Phase 0 |
| [0003](0003-sqlite-by-default-postgres-optional.md) | SQLite by default, Postgres optional | Accepted | Phase 0 |
| [0004](0004-content-hash-identity.md) | Content-hash identity | Accepted | Phase 0 |
| [0005](0005-agpl-30-or-later.md) | AGPL-3.0-or-later | Accepted | Phase 0 |
| [0006](0006-zotero-connector-protocol-compatibility.md) | Zotero connector protocol compatibility | Accepted | Phase 0 |
| [0007](0007-tauri-2-for-desktop-and-mobile-shells.md) | Tauri 2 for desktop and mobile shells | Accepted | Phase 0 |
| [0008](0008-parquet-and-duckdb-analytics-layer.md) | Parquet and DuckDB analytics layer | Accepted | Phase 0 |
| [0009](0009-annotations-as-records-w3c-web-annotation-model.md) | Annotations as records, W3C Web Annotation model | Accepted | Phase 0 |
| [0010](0010-sqlite-backed-in-process-job-queue.md) | SQLite-backed in-process job queue | Accepted | Phase 0 |
| [0011](0011-fts5-baseline-meilisearch-optional.md) | FTS5 baseline, Meilisearch optional | Accepted | Phase 0 |
| [0012](0012-in-process-trusted-plugin-host-in-v1.md) | In-process trusted plugin host in v1 | Accepted | Phase 0 |
| [0013](0013-curation-canvas-in-app-ggraph-for-publication-figures.md) | Curation canvas in-app, ggraph for publication figures | Accepted | Phase 0 (governs Phase 6) |
| [0014](0014-tool-for-you-through-m3-open-repo-at-m4.md) | Tool-for-you through M3, open the repo at M4 | Accepted | Phase 0 |
| [0015](0015-sqlite-only-until-multi-user.md) | SQLite only until multi-user | Accepted | Phase 0 |
| [0016](0016-better-bibtex-compatible-citation-keys.md) | Better BibTeX-compatible citation keys | Accepted | Phase 0 (governs Phase 1) |
| [0017](0017-w3c-web-annotation-json-as-annotation-storage-format.md) | W3C Web Annotation JSON as the annotation storage format | Accepted | Phase 0 (governs Phase 4) |
| [0018](0018-sandboxing-tier-in-process-until-multi-user.md) | Sandboxing tier: in-process until multi-user | Accepted | Phase 0 (governs Phase 9) |
| [0019](0019-name-recueil.md) | Name: Recueil | Accepted | Phase 0 |
| [0020](0020-systematic-review-automation-disclosure.md) | Systematic-review automation disclosure | Accepted | Phase 0 (governs Phase 7) |
| [0021](0021-a-verification-check-queries-both-sides.md) | A verification check queries both sides | Accepted | Phase 0 (governs every phase) |
| [0022](0022-resource-budgets-on-untrusted-input.md) | Resource budgets on untrusted input | Accepted | Phase 0 (governs every phase) |

## Adding a record

Take the next free number, use the filename pattern `NNNN-kebab-case-title.md`, copy the section
structure of any existing record, and add a row to the table above. If the new record replaces an
earlier one, set the earlier record's status to `Superseded by ADR-NNNN` — that is the only edit ever
made to an accepted ADR.
