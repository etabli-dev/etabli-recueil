# 0012 — In-process trusted plugin host in v1

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

Sandboxing plugins (workers, WASM, capability brokering) is a large project. In a single-user
install the plugin author and the operator are the same person, so the threat model is thin.

## Decision

Plugins load in-process and are trusted in v1. The manifest declares permissions and they are
recorded and displayed, but not enforced by isolation. Enforcement is revisited when multi-user
exists (ADR-0018).

## Consequences

Plugin authoring is simple and fast, which matters for the first-party plugins that dogfood the
contract (§5.13). A malicious plugin has full server rights — stated plainly in the docs. The
manifest permission field exists from v1 so enforcement can be added without a schema break.
