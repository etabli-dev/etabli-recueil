# 0026 — Proprietary licence, all rights reserved

- **Status:** Accepted
- **Date:** 2026-11-22
- **Phase:** Step Z of the transition plan (before Phase 3)
- **Supersedes:** ADR-0005

## Context

Recueil, like every Établi project, is intended to be used commercially. ADR-0005 chose
AGPL-3.0-or-later on the assumption that Recueil reuses Zotero's translators and translation-server.
In the tree as built, translation-server runs as a separate container that Recueil calls over HTTP
(ADR-0006, `deploy/docker-compose.sidecars.yml`); no Zotero server or translator code is part of
Recueil's own source. The only Zotero material in the repository is test fixtures under `fixtures/`,
which are verbatim upstream excerpts and keep Zotero's licence. All first-party code has a single
author, so the copyright holder can change the licence of future versions.

## Decision

From 22 November 2026, Recueil's first-party code, documentation and assets are proprietary, all
rights reserved (`LICENSE`, SPDX `LicenseRef-Proprietary`). The API reports
`LicenseRef-Proprietary` in `info.license` and in `/system`. First-party plugins carry the same
licence. Third-party components, sidecars and fixtures keep their own licences.

## Consequences

Versions published before 22 November 2026 remain available under AGPL-3.0-or-later; that cannot be
withdrawn. Outside contributions now need a written agreement with the copyright holder; the DCO
sign-off alone no longer covers them. Adopting AGPL or GPL components that would be linked into
Recueil is no longer possible; components are audited for compatibility with proprietary
distribution instead (§5.16). Running translation-server stays a separate process, and must stay one.
A hosted fork is prevented by the licence itself rather than by copyleft.
