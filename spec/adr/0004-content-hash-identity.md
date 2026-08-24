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

**A filename is a claim, not evidence.** "The hash already exists" is a statement about the bytes on
disk, and the only thing a path proves is that something was written there once. Rot, a truncated
write on a full disk and a restore from a damaged archive all leave a file whose name asserts a
digest its contents do not have. A store that read the filename as proof would, on a second arrival
of the correct bytes, discard them and keep the corrupt copy — silent data loss, of exactly the kind
this ADR exists to prevent. So a `put` **verifies the stored object before declaring a hit** — its
length always, its digest when the backend is configured for it — and on a mismatch writes the bytes
it holds, which were hashed on the way in, reporting the repair rather than performing it quietly.

## Consequences

Binding principle P2. Exact deduplication is free and total. Near-duplicates (re-scans, different
PDF renderings) are a separate, flag-only problem (§5.6). The store is readable without the
application, satisfying P10.
