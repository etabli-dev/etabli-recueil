# 0019 — Name: Recueil

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

The name is load-bearing in identifiers from the first commit: an npm scope, a CRAN and PyPI package
name, a CLI binary, a Docker image path, a URI scheme for deep links from Overleaf and Quarto
(§5.14), and a documentation domain. Changing it after publication breaks all of them, so it has to
be settled in Phase 0.

The constraints were: no collision with existing software; usable unchanged and unqualified across
npm, CRAN, PyPI, a command name and a URI scheme; accent-free, so it survives ASCII contexts and
keyboards without a French layout; in the French workshop register the `etabli` suite already uses;
and meaning something about what the tool does rather than being an arbitrary word. §9 records the
candidates.

## Decision

**Recueil.** French for a compiled collection of texts gathered into a single volume — which is what
a library of documents with a bibliographic facet is. The root verb *cueillir*, to gather, names the
ingestion model (§5.3) and supplies the first word of the tagline, *Gather. Verify. Map.*

Lower-case `recueil` wherever it is an identifier — `@recueil/*` on npm, `recueil` on CRAN and PyPI,
the CLI binary, `recueil://item/<id>`, `ghcr.io/etabli/recueil`. Capital R in prose. The organisation
carries the suite identity and the packages carry the product identity (§8), so `etabli/recueil*` on
GitHub with `@recueil/*` on npm is deliberate and not an inconsistency.

Module and component names stay functional English — server, web, connector, cli, mcp, sdk — and no
second vocabulary is introduced before 1.0.

**Rejected alternatives** (§9):

- **Pupitre** (desk, lectern). The closest match to *établi* in the furniture register, and the most
  obviously part of a suite. Rejected because it says nothing about documents, collections or
  gathering; it names where you work, not what the tool holds.
- **Fiche** (index card, card catalogue). The strongest library meaning of the four and the best fit
  for the item model. Rejected on collision: `fiche` is the pastebin server behind termbin, so the
  command name and the package names are contested.
- **Signet** (bookmark; also a seal of authenticity). The double meaning is attractive given the
  verification engine (§5.5). Rejected because search results are dominated by Bitcoin's signet test
  network, which is a permanent discoverability tax on a project whose users will search for it.
- **Lutrin** (lectern). Rejected on collision with the Lutris game launcher — too close in both
  spelling and audience.

## Consequences

The name is French and English speakers will mispronounce it. Accepted: *établi* already has that
property, and the suite is more coherent with it than without.

Every identifier listed above is claimed at the first commit and becomes a compatibility surface from
the first public release. This ADR is the point at which renaming stops being free.

Only a software-collision search has been done, on package registries and general search (§9). No
trademark search has been carried out, and none is planned before 1.0; if one turns up a conflict the
name is revisited, and this ADR would be superseded rather than amended.

Keeping module names in functional English means nobody has to learn a private glossary to read the
codebase or the API, which is the tax that the one French word is buying out.
