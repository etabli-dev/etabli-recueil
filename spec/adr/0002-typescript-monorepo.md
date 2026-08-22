# 0002 — TypeScript monorepo

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

The server, the web UI, the browser extension and Zotero's ~600 translators are all JavaScript.
Splitting the stack across languages would mean a second runtime purely to host translators.

## Decision

One pnpm/Turborepo monorepo, TypeScript throughout, Node 22 LTS as the runtime floor. Shared
schemas live in `packages/schemas` and are consumed by server, clients and generated SDKs.

## Consequences

Type definitions cross package boundaries without codegen. Rust appears only inside the Tauri
shells. A single dependency graph means a single upgrade cadence, managed by Renovate.
