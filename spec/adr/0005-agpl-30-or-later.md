# 0005 — AGPL-3.0-or-later

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

Recueil reuses Zotero's translation-server and translator collection, both AGPL-3.0. A permissive
licence cannot host that code. Separately, the project should not be capturable as a closed SaaS.

## Decision

AGPL-3.0-or-later for the server and all first-party code in this repository. Client libraries that
merely call the HTTP API (R, Python, generated TypeScript client) may be licensed more permissively
if a later ADR argues for it; they are not derived works of the server.

## Consequences

Anyone offering Recueil over a network must publish their modifications. Component licences must be
audited for AGPL compatibility before adoption (§5.16). This repository was briefly created under
MIT on 2026-08-22 and relicensed in the first substantive commit, before any third-party
contribution existed.
