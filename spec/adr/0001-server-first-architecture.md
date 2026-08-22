# 0001 — Server-first architecture

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

Every capability in the concept — ingestion from mail and scanners, scheduled enrichment against
external APIs, a shared graph, systematic-review state, an MCP endpoint — needs a process that runs
without a user interface attached. A desktop-first design with sync bolted on is exactly the model
Recueil exists to replace (CONCEPT.md §1).

## Decision

The server is the product. Every client — web UI, desktop shell, mobile, CLI, MCP, R and Python
packages — is a client of the same REST API. The desktop application bundles the same server binary
as a localhost sidecar; Docker and local mode run identical code.

## Consequences

No per-device sync engine and no CRDT work (P1). Offline capability is a cache plus a write queue,
not a merge algorithm. A user who wants a purely local single-file application is not served; that
is accepted, because the analysis and ingestion features are the reason the project exists.
