# 0003 — SQLite by default, Postgres optional

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

The primary deployment is one person on one machine or one small container. Requiring Postgres for
that is a barrier; forbidding it would block the multi-user future the data model is designed for.

## Decision

Drizzle ORM against SQLite by default, with Postgres as a supported alternative behind the same
schema definitions. The database URL selects the driver.

## Consequences

Migrations must be written against the intersection of both dialects. SQLite gets FTS5 for free
(ADR-0011). Postgres deployments unlock the optional Redis/BullMQ queue (ADR-0010).
