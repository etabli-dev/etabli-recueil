# 0018 — Sandboxing tier: in-process until multi-user

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0 (governs Phase 9)

## Context

ADR-0012 settled v1: plugins load in-process and are trusted, because in a single-user install the
plugin author and the operator are the same person. §10 asks the harder version of the question for
Phase 9, when a plugin registry exists and plugins can be installed from a URL written by a stranger.

That change is smaller than it looks. Installing a third-party plugin is a deliberate act by the
operator, with the same trust profile as `npm install` or adding a Docker sidecar, and on a
single-user machine the plugin gains nothing the operator's own shell does not already have. What
actually changes the threat model is a second party: an identity in the install that did not choose
the plugin, or an operator who is not the person the data belongs to.

Sandboxing is also not one decision but a ladder — `worker_threads` with structured-clone messaging,
a `vm` context, WASM under the component model — each rung costing more and constraining plugin
authors more. Picking a rung now, before any third-party plugin exists, would be guessing.

## Decision

Plugins stay in-process and trusted through 1.0, including after the registry ships in Phase 9. The
manifest's permission declarations are recorded, shown to the operator at install time, and checked
against the hooks the plugin actually uses by the compatibility test suite (§5.13) — but they are not
enforced by isolation, and the docs say so in plain words: installing a plugin gives it the rights of
the server process.

**Trigger.** Sandboxing work starts at the first of these, whichever comes first:

1. multi-user support ships — more than one identity in a single install, so someone who did not
   install the plugin is exposed to it
2. a hosted or managed deployment exists where the operator and the person whose library it is are
   different people
3. plugins update automatically, or are installed other than by a deliberate operator action

**Migration path.** The point of writing it down now is that the plugin contract is designed so the
eventual change is a change of host, not of contract:

1. Plugin entry points are async and communicate through the typed request/response façade in
   `@recueil/plugin-sdk`. Plugins never import server internals and never touch the database or the
   filesystem directly; the SDK is the only permitted import, enforced by an import lint in the
   compatibility suite.
2. Host services — database, storage, HTTP, jobs, logging, events — reach the plugin through a
   capability object passed at activation, never through module globals or singletons. Every
   capability call takes and returns structured-cloneable values.
3. Given 1 and 2, the host can be swapped for one `worker_threads` worker per plugin with message
   passing, and later for a WASM host for plugins that need no Node APIs, without changing plugin
   source.
4. Permissions become enforcement points on the capability object rather than a new mechanism: a
   plugin without `storage:write` is handed a capability object whose write method rejects.

## Consequences

Phase 9 ships a registry with no sandbox. That must be stated on the registry page and in the install
flow, not buried in a security document, and it is a legitimate reason for a cautious operator not to
install community plugins.

The discipline in the migration path has a cost that lands in Phase 3, long before any benefit: no
first-party plugin may reach into Drizzle or the services directly, so every capability a plugin needs
has to become an explicit SDK surface, deliberately designed. That slows the first-party plugin work
that dogfoods the contract. It is the price of not having to rewrite every plugin later.

Every call being structured-cloneable rules out passing class instances, streams and callbacks across
the SDK boundary, which makes some hooks — a streaming ingest stage, for instance — more awkward than
they would be in a naive in-process design.

If the trigger never fires, none of this is wasted: a plugin API that does not leak internals is the
right design for a versioned contract regardless of where the code runs.
