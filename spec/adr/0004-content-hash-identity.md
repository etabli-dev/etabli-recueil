# 0004 — Content-hash identity

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

File paths, names and modification times are unstable and are routinely wrong after a sync, a
re-scan or a migration. Deduplication that trusts them produces both false merges and misses.

## Decision

A Document is identified by the SHA-256 of its bytes. Storage is content-addressed:
`<store>/<aa>/<bb>/<full-hash>`. Ingesting a file whose hash already exists links to the existing
Document rather than storing a second copy.

## Consequences

Binding principle P2. Exact deduplication is free and total. Near-duplicates (re-scans, different
PDF renderings) are a separate, flag-only problem (§5.6). The store is readable without the
application, satisfying P10.
