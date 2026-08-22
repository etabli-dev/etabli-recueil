# 0016 — Better BibTeX-compatible citation keys

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0 (governs Phase 1)

## Context

Citation keys are the one identifier that leaves the library and lands in a manuscript. Every
`\cite{}` in every `.tex` file the author has written was produced by Zotero with Better BibTeX, and
M1 requires that Overleaf builds from a Recueil-exported `.bib` (§7, Phase 1 exit). A key scheme that
differs from Better BibTeX's would silently break those manuscripts at migration.

Inventing a cleaner formula is tempting and worthless: the value of a key is that it is the same one
as last year.

## Decision

The default formula is Better BibTeX's default pattern, `auth.lower + shorttitle(3,3) + year`,
concatenated with no separator. Recueil implements it as follows.

**Segment `auth`.** The family name of the first creator, chosen in the order author → editor → any
other creator role → the literal `anon` if the item has no creators. For a two-field name the family
field is used; for a single-field ("literal") name the whole string is used. A name particle stored
in its own field (`von`, `van`, `de`) is dropped; a particle embedded in the family string is kept,
which matches Better BibTeX. The result is transliterated (below), stripped of everything outside
`[A-Za-z0-9]`, and lower-cased by the `.lower` modifier. An empty result becomes `anon`.

**Segment `shorttitle(3,3)`.** The title is split on whitespace and punctuation. Words matching the
skip-word list are dropped; the list ships as editable data, seeded from Better BibTeX's default
list. The first three surviving words are taken in order, each truncated to its first three
characters, each capitalised on its first character, and concatenated. Subtitles after a colon
participate normally. Digits are kept. Fewer than three surviving words yields a shorter segment; an
empty title yields an empty segment.

**Segment `year`.** The four-digit year of the item's issued date. If there is no date the segment is
empty and disambiguation carries the load.

So Ravaud, P. (2019), *The Effect of Preprints on Systematic Review Timeliness* becomes
`ravaudEffPreSys2019`.

**Transliteration.** Applied to every segment before the character filter, in this order:

1. Unicode NFKD normalisation, then removal of all combining marks (category `Mn`), so é → e,
   ü → u, ā → a, ć → c, ş → s.
2. An explicit map for characters that do not decompose: ß → ss, ẞ → SS, æ → ae, œ → oe, ø → o,
   đ → d, ð → d, þ → th, ł → l, ħ → h, ı → i, ŋ → ng, ƒ → f.
3. Non-Latin scripts through a per-script romanisation table — Greek by ISO 843, Cyrillic by
   ISO 9:1995. If the record carries a Latin-script variant of the name (a Zotero alternate name
   form, an OpenAlex or ORCID display name), that variant is preferred over transliteration.
4. Everything still outside `[A-Za-z0-9]` is dropped.

A per-library option `germanExpansion` (default off) expands ä → ae, ö → oe, ü → ue, ß → ss before
step 1. It is off by default because Better BibTeX's default folds rather than expands, and matching
Better BibTeX is the point of the default.

**Disambiguation.** Colliding keys are ordered by the item's creation timestamp, then by item id, so
the order does not depend on enumeration. The first item keeps the bare key; the second and later get
a lower-case suffix `a`, `b`, `c`, …, `z`, `aa`, `ab`, … (bijective base-26). Suffixes are assigned
once. They are never renumbered when an earlier item is trashed or its metadata changes, and a
retired key is recorded in a key ledger and never reissued, because a key that has been in a
manuscript must not come back attached to a different work.

**Pinning.** Any key can be pinned per item, using the same field-level manual lock as every other
bibliographic field (§5.2). A pinned key is never regenerated. Keys arriving from migration — Zotero
8 native keys, Better BibTeX keys from `better-bibtex.sqlite` or from an `Extra` line — are imported
pinned, so migration cannot rewrite a key that is already in a manuscript (§6).

**Configurability.** The formula is a per-library setting written in a documented subset of Better
BibTeX's pattern language: functions `auth`, `authors(n)`, `authEtal`, `authorLast`, `shorttitle(n,m)`,
`title(n,m)`, `veryshorttitle`, `year`, `shortyear`, `journal`, `doi`; modifiers `.lower`, `.upper`,
`.capitalize`, `.abbr`, `.condense(s)`, `.replace(x,y)`, `.select(n,m)`. A pattern using anything
outside the subset is rejected when it is saved, with the offending token named — never accepted and
silently ignored. Changing the formula does not rewrite existing keys; it changes what new keys and
explicit regenerations produce.

**Drift and collisions** are reported by the `citation_key` check (§5.5), which offers a regenerate
action per item. Nothing rewrites a key without being asked.

## Consequences

Existing `.bib` files and manuscripts keep working across the migration for the overwhelming majority
of items, which is what M1 needs. Parity is a fixture test — keys exported from a real Better BibTeX
library, regenerated by Recueil, compared row by row — not an assertion in this document. Divergences
found by that test are recorded as known differences rather than quietly patched over, because some
of Better BibTeX's behaviour is emergent rather than specified.

The cost is a key ledger table, a small pattern-language parser and a romanisation table, all of
which have to exist in Phase 1 rather than later, because keys are written into exports from the
first day of use.

Romanisation is lossy: two distinct names can fold to the same `auth` segment, and a Cyrillic name
transliterated by ISO 9 will not match the spelling the author uses in English-language papers unless
a Latin variant is on the record. The suffix mechanism handles the collision; the spelling mismatch
is a metadata-quality problem to be fixed on the creator record, not in the key generator.

Never renumbering means the ledger accumulates and the suffix sequence can look untidy — `smith2019`
absent while `smith2019b` exists. Stability beats tidiness here without argument.
