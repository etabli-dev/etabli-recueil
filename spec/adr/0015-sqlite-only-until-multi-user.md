# 0015 — SQLite only until multi-user

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

ADR-0003 chose SQLite as the default with Postgres as an option, on Drizzle. That decision names the
target; it does not say when the Postgres path gets built. Building both from the start means every
migration, every query and the job queue are written and tested twice, and the dialect differences
that matter here are not cosmetic: FTS5 against `tsvector`, SQLite's `json_extract` against
Postgres's JSONB operators, upsert semantics, and a job queue (ADR-0010) whose whole design is a
polling table under a single writer. A second dialect leaks into the core precisely where the core
is most interesting.

Against that, v1 is explicitly single-user (§2 non-goals, §5.15). There is no deployment in scope
that SQLite in WAL mode cannot serve.

## Decision

v1 ships SQLite only. There is no Postgres build, no Postgres service in the Docker image, no
Postgres CI matrix and no support offer.

ADR-0003 stands as the direction of travel, and the schema is written so the port stays a port:

- the Drizzle schema uses a portable column and constraint subset by default
- SQLite-specific machinery — FTS5 tables and triggers, the job queue's polling loop, any
  `WITHOUT ROWID` or `json_*` usage — lives behind named adapter modules rather than being sprinkled
  through the services
- application code never assumes single-writer semantics for correctness; it relies on transactions

The trigger for building the Postgres path is the first of: multi-user support entering the roadmap
(more than one identity in an install), or a real deployment whose write concurrency SQLite in WAL
mode cannot absorb. Neither is speculated about before it happens.

## Consequences

One dialect to test, one backup story: `recueil backup` copies a database file plus a storage
manifest and config (§5.15), and restore is a file operation that CI can exercise end to end. The
Docker image has no database container next to it, which is most of why self-hosting Recueil is meant
to be easy.

Anyone who wants Postgres today is unsupported, including people whose infrastructure policy demands
it. That is a real user turned away.

The deferred cost is known and bounded: the port must replace FTS5 with `tsvector` or make
Meilisearch (ADR-0011) mandatory, and replace the in-process queue with BullMQ or an equivalent
(ADR-0010 already names this). Both were anticipated when those ADRs were written. Keeping the
adapters named from v1 is what keeps the bill at that size.
