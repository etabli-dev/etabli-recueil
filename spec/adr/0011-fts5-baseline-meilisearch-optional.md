# 0011 — FTS5 baseline, Meilisearch optional

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

Full-text search over metadata, notes, annotations and extracted text is required. Most libraries
are small enough that a search sidecar is overhead.

## Decision

SQLite FTS5 as the always-available index. Meilisearch as an optional sidecar for larger libraries,
behind one search interface so the backend is swappable.

## Consequences

No sidecar for the common case. Typo tolerance and faceted ranking are better with Meilisearch;
users who need them opt in. The interface must not expose backend-specific query syntax.
