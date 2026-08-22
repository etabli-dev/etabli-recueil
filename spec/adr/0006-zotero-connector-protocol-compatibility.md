# 0006 — Zotero connector protocol compatibility

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

Web capture is the single hardest part of a reference manager to rebuild, and Zotero's translator
collection represents years of per-site maintenance. Rebuilding it is not a viable use of a solo
budget.

## Decision

Implement the endpoints the Zotero Connector expects (`/connector/ping`, `/connector/saveItems`,
`/connector/saveSnapshot`, and the collection/session calls) so the unmodified extension can target
Recueil. Run `zotero/translation-server` as a sidecar for URL, DOI, PMID, ISBN and arXiv imports.

## Consequences

Capture works on day one across every site Zotero supports. The protocol is undocumented and may
change; versions are pinned and an identifier-based fallback path (Crossref/OpenAlex) exists. A
first-party extension in Phase 8 supersedes the dependency without replacing the protocol.
