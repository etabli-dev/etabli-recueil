# plugins

First-party plugins (CONCEPT.md §5.13). Each is an ordinary plugin: it imports nothing but
`@recueil/plugin-sdk`, declares its hooks and permissions in `recueil.plugin.json`, and is installed
disabled — `recueil plugin enable --builtin` turns all three on.

| Plugin | Hooks | Replaces |
|---|---|---|
| `resolvers-core` | 11 `resolver`: PubMed, OpenAlex, Crossref, DataCite, Semantic Scholar, arXiv, OpenAIRE, Unpaywall, CORE, CRAN, Open Library | Metadata Mender |
| `checks-core` | 13 `check`: the CONCEPT §5.5 list | — |
| `dedup-core` | 2 `dedupRule`: identifier, fuzzy | Argus One (Attaclone's case cannot arise: see `spec/parity-zotero-plugins.md`) |

CONCEPT §5.13 lists one plugin per source (`resolver-openalex`, `resolver-crossref`, …). They are
one package here because they share their helpers and are enabled together in practice; each is
still its own hook with its own id, priority and rate limit, and splitting them later changes no
contract.
