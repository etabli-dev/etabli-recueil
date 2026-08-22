# 0008 — Parquet and DuckDB analytics layer

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

Bibliometric work means whole-corpus table scans and joins. Serving that through paginated JSON is
slow to transfer and awkward to reassemble in R or Python.

## Decision

`GET /analytics/export` emits a Parquet bundle (works, creators, works_creators, terms,
works_terms, edges, metrics, and the systematic-review tables). In local mode DuckDB may attach the
SQLite file directly.

## Consequences

R and Python clients read columnar data with Arrow at native speed. The REST API stays the contract
for records; analytics is a separate, bulk-shaped surface. Export freshness is explicit, not implied.
