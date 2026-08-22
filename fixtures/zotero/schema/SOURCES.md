# Vendored upstream schema

Everything in this directory is copied verbatim from upstream and is **not** hand-written. It is
vendored rather than downloaded at generation time so that `make-fixture.mjs` is reproducible
offline and so that the exact layout the fixture claims to match is recorded in the repository.

Both upstreams are AGPL-3.0-or-later, as is Recueil, so the copies are redistributed under the same
licence. The copyright headers are left intact.

## Zotero

Repository `https://github.com/zotero/zotero`, tag **`10.0.0`**
(tag object `d3f1ccf3380fde351854d849977c55467f4609a6`,
commit `22f08d1ceddc8bad5718b3bc6eee9d3ae5dccc2c`, dated 2026-08-17).

| File | Upstream path | userdata/system/trigger version | SHA-256 |
|---|---|---|---|
| `userdata.sql` | `resource/schema/userdata.sql` | 129 | `874d645337688d05232bc3cee54aa025c0e4aa3d4271d59664683f1774d635e7` |
| `system.sql` | `resource/schema/system.sql` | 32 | `9213939a362c9ad8549109e6f3c9c11a74f6eea6925f1d4ebf30dd99622e9aeb` |
| `triggers.sql` | `resource/schema/triggers.sql` | 18 | `84e1c680ba411d08d33af16dbe7dc2e72ad003fa0b81b19012ff909b06417ce6` |
| `system-107.sql` | `resource/schema/system-107.sql` | — | `6b3cc1026302cbcefa6ed8a6ff9a1ed8db469a9d6228dc70d0a3a71de26d28ea` |

`system-107.sql` is the last revision of Zotero's system seed that still carried the numeric
`itemTypes`, `fields`, `creatorTypes`, `itemTypeFields`, `baseFieldMappings` and
`itemTypeCreatorTypes` rows. Every library created before Zotero 5.0.something still carries those
identifiers, because later additions are allocated `MAX(id) + 1` rather than renumbered. It is the
seed for the `legacy` identifier layout (see `../../README.md`).

The first line of each Zotero `.sql` file is a comment carrying its version number; the generator
reads it rather than hard-coding it.

## Zotero global schema

Repository `https://github.com/zotero/zotero-schema`, branch `master`, commit
**`b86c79b56479cadac3288e1f122cf34ef04e8809`** (2026-08-19), schema `version` **45**.

`global-schema.json` is that repository's `schema.json` with two changes, both loss-free for our
purpose:

- it is minified (upstream ships it pretty-printed);
- the `locales` key is dropped. `locales` is 254 kB of translated UI labels for item types and
  fields. Nothing in it reaches any table of `zotero.sqlite`; only `version`, `itemTypes`, `meta`
  and `csl` do. Dropping it keeps the vendored file at 29 kB instead of 283 kB.

The consequence is documented where it shows: the `settings` row
`('globalSchema', 'data')` — which real Zotero fills with the zlib-deflated schema minus
`itemTypes` — is written here from the reduced object, so it too lacks `locales`.

## Better BibTeX

Repository `https://github.com/retorquere/zotero-better-bibtex`, tag **`v7.0.0`**
(tag object `ed44de0ed0ad3c7881932171494cfcb012ff9ac4`,
commit `7b6e6c8f31809d96526708f4fcdc4ccf03a3beb9`, dated 2025-01-03).

| File | Upstream path | SHA-256 |
|---|---|---|
| `better-bibtex-citation-key.sql` | `content/db/citation-key.sql` | `42175bf85695386381883631dd34d50e8379bbf2bbb14b3d307d51af4a689e63` |

Better BibTeX `ATTACH`es `better-bibtex.sqlite` under the schema name `betterbibtex` and then runs
that file, which is why every statement in it is prefixed `betterbibtex.`. Opened on its own — which
is how an importer will open it — the objects are simply `citationkey` and its three indexes. The
generator strips the prefix for that reason and for no other; the statements are otherwise unchanged.

## Refreshing these copies

There is no automatic update. When a new Zotero changes the layout:

1. Download the four Zotero files at the new tag and `schema.json` at the matching
   `zotero-schema` commit (Zotero vendors it as a git submodule under `resource/schema/global`).
2. Reduce `schema.json` exactly as described above:
   `node -e "const s=require('./schema.json');process.stdout.write(JSON.stringify({version:s.version,itemTypes:s.itemTypes,meta:s.meta,csl:s.csl}))"`.
3. Update the tables above, including the SHA-256 sums (`sha256sum *`).
4. Re-run `node fixtures/zotero/make-fixture.mjs` and review the diff in
   `fixtures/expected-counts.json`. A change there that is not explained by a change you made to
   `lib/library.mjs` means the new Zotero layout moved something, and the importer needs to know.
