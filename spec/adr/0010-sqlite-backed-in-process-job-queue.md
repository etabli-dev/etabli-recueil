# 0010 — SQLite-backed in-process job queue

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

Ingestion, enrichment, dedup and graph expansion are long-running and must survive restarts. A
mandatory Redis container for a single-user install is disproportionate.

## Decision

A persistent job queue in the primary database, run in-process, with idempotency keys and resumable
state (P9). Redis/BullMQ is an optional backend, sensible when the deployment already uses Postgres.

## Consequences

Single-container deployment stays single-container. Throughput is bounded by one process until the
optional backend is enabled. Jobs are inspectable with plain SQL.
