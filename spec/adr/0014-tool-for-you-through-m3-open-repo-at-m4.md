# 0014 — Tool-for-you through M3, open the repo at M4

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

Recueil is a solo project replacing a stack its author uses daily. Running it as a community project
from day one costs documentation, issue triage, support expectations, contribution infrastructure and
API stability promises — all before the data model has met a real library. Running it as a private
project costs nothing up front and everything later, because retrofitting a plugin contract, an
OpenAPI spec and docs onto a codebase that never expected outsiders is the failure mode of every
self-hosted tool that stayed personal too long.

The two costs are separable. The repository is public and AGPL from the first commit (ADR-0005, §8):
that is a licensing and hygiene decision, not a community commitment. What is being decided here is
when the project starts owing anything to anyone else.

## Decision

Through M3 (end of Phase 3) Recueil is developed as a tool for its author. The repository is public,
the licence is AGPL-3.0-or-later, releases are tagged and the docs site exists, but:

- no roadmap promises and no support commitment; the README carries an explicit status banner
- issues and pull requests may be closed unanswered
- the plugin API may break between minor versions, and the data model may change under a migration
- no CONTRIBUTING, no issue templates, no DCO, no governance

At M4 (end of Phase 5, bibliometrics in R) the project opens: CONTRIBUTING, DCO, issue templates, a
public roadmap, the two-minor-version plugin API deprecation window (§5.13), and an announcement.
Phase 9 then builds the registry and the rest of the community surface.

The engineering discipline that makes a project usable by others — the OpenAPI contract, the plugin
manifest and hook catalogue, ADRs, the fixture library, CI — is Phase 0 work regardless, because it
is leverage for the author first. Only the social apparatus waits.

## Consequences

Phase 0 depth is set by what the author needs to move fast, not by what a contributor would need to
onboard. Documentation through M3 is reference material and ADRs, not tutorials.

M4 is the right hinge because it is the first milestone that produces something an outsider wants:
`rc_bibliometrix()` output that runs in biblioshiny unmodified. Before that, the honest pitch is "a
Zotero replacement that only works for one person's workflow".

Someone may find the public repository early and depend on it. The status banner is the mitigation
and it will not fully work. Accepted: the alternative is a private repository, which would make the
first public release a code dump with no history.

If the author's own use has not survived M3 — the three plugins not retired, the parity tests not
passing — the project does not open at M4. Opening is conditional on the milestone, not on the date.
