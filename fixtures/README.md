# fixtures

Test libraries for Recueil's importers and exporters: a synthetic Zotero library, its storage
directory, a Better BibTeX citation-key store, and hand-written BibTeX, RIS and CSL-JSON files.

Phase 1's exit criterion is the author's own Zotero library imported at 100 % item count
(`CONCEPT.md` §7). That library is not in this repository and never will be, so the importer has to
be provable against something else. This directory is that something else: a library built from
Zotero's own schema, deliberately awkward in the ways a fifteen-year-old library is awkward, with
every count stated in advance so a test can assert against a number rather than against whatever the
importer happens to produce.

```
fixtures/
  expected-counts.json      every count in this document, machine-readable
  lib/text-fixtures.mjs     counts and checks the BibTeX / RIS / CSL-JSON files
  zotero/
    make-fixture.mjs        the generator
    lib/                    the generator's modules, including the library definition
    schema/                 vendored upstream schema + SOURCES.md (provenance)
    zotero.sqlite           generated — a real Zotero database
    better-bibtex.sqlite    generated — Better BibTeX's citation-key store
    storage/<KEY>/…         generated — the files the stored attachments point at
    linked-attachments/…    generated — the one linked file that resolves
  bibtex/                   6 hand-written files
  ris/                      3 hand-written files
  csl-json/                 3 hand-written files
```

---

## 1. Regenerating

```sh
node fixtures/zotero/make-fixture.mjs
```

No arguments, no install step, run from anywhere. It rewrites `zotero.sqlite`,
`better-bibtex.sqlite`, `storage/`, `linked-attachments/` and `expected-counts.json`.

The generator needs a SQLite driver and finds one of two: `better-sqlite3`, resolved out of
`packages/core/node_modules` after a `pnpm install` at the repository root, or `node:sqlite`, which
needs no install but is only unflagged from Node 23. `better-sqlite3` is preferred so that a plain
`node` invocation works on the Node 22 LTS the project targets.

It is **deterministic**. Object keys are derived from a hash of each record's slug rather than
generated randomly, timestamps are literals, and the generated PDFs contain no clock. Running it
twice on the same machine produces byte-identical files, so a diff in `expected-counts.json` always
means something real moved — and if what moved was the vendored Zotero schema, that is exactly the
signal the importer needs.

Byte-identity holds per SQLite build, not across them: `better-sqlite3` 12.x (SQLite 3.53.2) and
this machine's `node:sqlite` (3.53.3) lay the pages out slightly differently. The *contents* are
identical — every row of every table hashes the same — so the fixture is the same fixture either
way, but do not diff the file across driver versions and expect nothing. Set
`RECUEIL_FIXTURE_SQLITE=node:sqlite` to force the fallback driver and check that for yourself.

Options:

| Option | Effect |
|---|---|
| `--out=DIR` | write somewhere other than `fixtures/zotero/` (then `expected-counts.json` is left alone) |
| `--id-layout=legacy` \| `fresh` | which numeric identifier layout to build; see §3 |
| `--no-counts` | build but do not touch `expected-counts.json` |
| `--check` | write nothing; rebuild into a temporary directory and report whether what is committed still matches. Exits 1 if it does not |
| `--quiet` | print nothing on success |

`--check` is the drift guard, and it is worth a CI step:

```sh
node fixtures/zotero/make-fixture.mjs --check
```

It compares by content, not by bytes — every row of every table, the manifest, and the SHA-256 of
every generated file — so a different SQLite build is not a failure and an edited record is. It
touches nothing under `fixtures/`.

The generator refuses to finish if anything is off. It builds with foreign keys on and Zotero's own
triggers armed; it rejects a field or creator type that Zotero's global schema does not allow on the
item type; it reopens both databases from a fresh connection and runs `PRAGMA integrity_check` and
`PRAGMA foreign_key_check`; and it compares every count against the numbers hard-coded in
`zotero/lib/counts.mjs` and `lib/text-fixtures.mjs`, throwing on the first mismatch. Those hand-written
numbers are the promise; `expected-counts.json` is the receipt.

> **Note on `.gitignore`.** The repository root ignores `*.sqlite`. `fixtures/.gitignore` re-includes
> it, because here the SQLite files are committed artefacts rather than working data. The root
> pattern would be better written `/data/*.sqlite`; that file belongs to another part of the tree.

---

## 2. What the Zotero fixture is built from

Nothing is invented. `zotero/schema/` holds Zotero's and Better BibTeX's own files, copied verbatim,
with provenance and SHA-256 sums in [`zotero/schema/SOURCES.md`](zotero/schema/SOURCES.md).

| Piece | Source | Version |
|---|---|---|
| Table layout | `zotero/zotero` `resource/schema/userdata.sql`, tag `10.0.0` | userdata **129** |
| System tables and seeds | `resource/schema/system.sql`, same tag | system **32** |
| Triggers | `resource/schema/triggers.sql`, same tag | triggers **18** |
| Legacy identifier seed | `resource/schema/system-107.sql`, same tag | — |
| Item types, fields, creator types | `zotero/zotero-schema` `schema.json`, commit `b86c79b…` | globalSchema **45** |
| Citation-key store | `retorquere/zotero-better-bibtex` `content/db/citation-key.sql`, tag `v7.0.0` | — |

The database is assembled the way Zotero assembles one on a fresh profile
(`Zotero.Schema._initializeSchema`): `PRAGMA page_size = 4096`, then `system.sql`, `userdata.sql`,
`triggers.sql`, then a replay of `_updateGlobalSchema()` over the global schema, then
`_updateCustomTables()` to fill the `*Combined` tables — `itemData.fieldID` is a foreign key into
`fieldsCombined`, not into `fields`, so a fixture that skipped them would not be loadable.

`zotero.sqlite` is about 780 kB. Most of that is not data: Zotero's schema is 59 tables and 94
indexes and triggers, and at a 4 kB page size the root pages alone account for the bulk. Shrinking
the page size would shrink the file and stop it being what Zotero writes, so it stays.

Two things a real `zotero.sqlite` has that this one does not, both deliberate and both harmless:

- The `settings` row `('globalSchema', 'data')` — the zlib-deflated global schema — is written from
  a copy with the `locales` key removed, because the vendored `global-schema.json` drops it
  (254 kB of translated UI labels, none of which reaches a table). Everything Zotero actually reads
  out of that row at import time is present.
- Image annotations have no cached `annotation-<key>.png` under `storage/`. That cache is
  regenerable from the PDF and is not library data.

---

## 3. Two identifier layouts, and why it matters

`itemTypeID`, `fieldID` and `creatorTypeID` are **local** numbers. They never sync, and two Zotero
installations holding the same library can and do disagree about them, because Zotero allocates a
new one as `MAX(id) + 1` at the moment a type first appears (`Zotero.ID._getNext`). An importer that
hard-codes `itemTypeID = 4` for `journalArticle` is right on some libraries and wrong on others.

The generator can build both:

**`legacy` (the default, and what is committed).** Seeded from `system-107.sql` — the last revision
of Zotero's seed that carried the numeric rows — and then replayed forward through the four dates on
which item types entered the global schema, taken from the commit history of `zotero/zotero-schema`:

| Stage | Date | Adds | Resulting ids |
|---|---|---|---|
| seed | ≤ Zotero 4 | 36 types | `note` 1 … `dictionaryEntry` 36 |
| 1 | 2021-03-03 | `annotation` | 37 |
| 2 | 2022-03-03 | `preprint` | 38 |
| 3 | 2023-03-23 | `dataset`, `standard` | 39, 40 |

This is what a library carried forward from Zotero 4 holds today: `journalArticle` 4, `book` 2,
`bookSection` 3, `thesis` 7, `webpage` 13, `attachment` 14, `report` 15, `conferencePaper` 33.

Item-type identifiers are reproduced exactly. Field and creator-type identifiers are allocated by
the same algorithm but not against the same history — the fixture applies the *current* field
definitions at every stage, whereas a real library met each new field on the day it appeared. The
numbers are therefore plausible rather than provably identical to any one real library. That is the
point: an importer must resolve all three by name.

**`fresh`.** What Zotero writes on a brand-new profile: empty tables, one pass over the global
schema in its own (alphabetical) order, so `annotation` is 1, `artwork` 2, `book` 7,
`journalArticle` 22, and nothing lines up with the legacy layout at all.

```sh
node fixtures/zotero/make-fixture.mjs --id-layout=fresh --out=/tmp/zotero-fresh
```

A test that runs the importer against both and asserts the same result has proved the importer
resolves by name. The `fresh` build is not committed — it is one command and a few hundred
milliseconds — but the counts are identical to the committed build in every respect except
`zotero.itemTypeIds`.

---

## 4. The Zotero library, item by item

Item keys are eight characters from Zotero's own alphabet (`23456789ABCDEFGHIJKLMNPQRSTUVWXYZ`) and
are derived as `sha256("recueil-fixture:item:<slug>")` folded into that alphabet, so they are stable
across regenerations and a test may hard-code one. The slug is not in the database; it is the handle
used in `zotero/lib/library.mjs` and in this document.

### 4.1 Counts

`items` holds **103** rows of every kind:

| Kind | Rows |
|---|---|
| Regular items (not note, attachment or annotation) | 67 |
| Notes | 11 |
| Attachments | 17 |
| Annotations | 8 |

Of the 67 regular items, **64 are live** and 3 are in the trash. Per Zotero item type:

| Zotero type | Live | With trash | Recueil type (`CORE_ITEM_TYPES`) |
|---|---:|---:|---|
| `journalArticle` | 20 | 21 | `article` |
| `book` | 8 | 9 | `book` |
| `bookSection` | 7 | 7 | `chapter` |
| `thesis` | 5 | 5 | `thesis` |
| `report` | 6 | 6 | `report` |
| `preprint` | 6 | 6 | `preprint` |
| `webpage` | 6 | 7 | `webpage` |
| `dataset` | 4 | 4 | `dataset` |
| `conferencePaper` | 2 | 2 | `conference_paper` |
| **total** | **64** | **67** | |

**64 is the number an importer must reproduce.** Anything reporting 67 has resurrected the trash;
anything reporting 103 has counted notes, attachments and annotations as items; anything reporting
63 has merged the two different works that share the title *Interoperability*; anything reporting 62
has also merged the two editions of *Lehrbuch der Hydrologie*.

The rest:

| | Count | Notes |
|---|---:|---|
| Notes | 11 | 9 child, 2 standalone; 1 trashed in its own right, 1 whose parent is trashed |
| Attachments | 17 | 10 `imported_file`, 2 `imported_url`, 2 `linked_file`, 3 `linked_url`; 1 trashed; 1 standalone |
| Files on disk | 12 | 11 under `storage/`, 1 under `linked-attachments/` |
| Files declared but absent | 2 | see §4.4 |
| Annotations | 8 | 2 highlight, 2 note, 1 image, 1 ink, 1 underline, 1 text; 1 external |
| Collections | 9 | 8 live, 1 trashed; three levels deep; 1 live collection empty; 68 memberships |
| Tags | 23 | 12 used manually, 11 attached automatically, 65 assignments, 3 coloured |
| Creators | 52 | 9 single-field (institutional); 106 assignments across 6 creator types |
| Relations | 13 | 11 `dc:relation`, 1 `owl:sameAs`, 1 `dc:replaces`; 3 point outside the library |

### 4.2 The awkward cases

| What | Where | Why it is here |
|---|---|---|
| No creator at all | `ja-editorial-nocreator`, `ja-title-only`, `bk-duden`, `rp-jahresbericht`, `wp-nationale-wasserstrategie`, `wp-no-creator`, `wp-wikipedia-el`, `wp-long-url`, `wp-dead-link` | Anything that assumes a first author, or builds a citation key from one, breaks |
| Particle surname | `van der Berg, Willem J.` — author on `ja-donau-niederschlag` and `ja-many-authors`, editor on `bs-particle-editor` | Must not become `Berg, Willem J. van der`, and must sort under V or B consistently |
| Single-field creator | 9 creators with `fieldMode = 1`: `UNESCO`, `OCDE`, `Ελληνική Στατιστική Αρχή`, `Институт водных проблем РАН`, `Intergovernmental Panel on Climate Change`, `Landesanstalt für Umwelt Baden-Württemberg`, `European Environment Agency`, `U.S. Geological Survey`, `Copernicus Climate Change Service` | `firstName` is `''`, not `NULL`; the name must not be split on a space |
| Two people, one surname | `ja-same-lastname` (`Nakamura, Hiroshi` and `Nakamura, Haruki`) | Author disambiguation and citation-key collision |
| Non-ASCII, German | `ja-donau-niederschlag`, `ja-accents-mixed`, `bk-hydrologie-3`, `bk-hydrologie-4`, `th-diss-ulm`, `pp-eartharxiv-de` | Umlauts and `ß` in titles, authors, publishers and filenames |
| Non-ASCII, French | `ja-paca-fr`, `bk-translated`, `bs-encyclopedia-like`, `rp-oecd-fr`, `wp-blog-fr`, `th-master-fr` | Accented capitals (`É`, `Ô`), a cedilla, and a curly apostrophe (U+2019 in `bs-encyclopedia-like`) beside straight ones everywhere else |
| Non-ASCII, Greek | `ja-athens-el`, `bs-greek-history`, `pp-zenodo`, `wp-wikipedia-el` | Whole records in Greek, including a Greek collection name (`Θεωρία`) and tag (`Δεδομένα`) |
| Non-ASCII, Cyrillic | `ja-volga-ru`, `bs-translator-chain`, `th-phd-msu` | Whole records in Russian, including a Cyrillic institutional creator |
| Duplicate titles, different works | `ja-interop-jis` (Okonkwo 2021) and `ja-interop-dap` (Szűcs & Nováková 2018), both titled *Interoperability* | A deduplicator keyed on the title alone merges two unrelated papers |
| A real duplicate, already binned | `ja-trashed-duplicate`, a third *Interoperability* in the trash | An importer that ignores `deletedItems` resurrects it |
| Two versions of one work | `pp-dedup-preprint` ↔ `ja-dedup-published`; `bk-hydrologie-3` ↔ `bk-hydrologie-4` | Same title, same authors, different identifiers: related, not duplicate |
| Nested collections | `Dissertation` → `Kapitel 2 — Methoden` → `Instrumente` | Three levels; `ja-donau-niederschlag` is in three collections at once |
| Empty collection | `Zu sortieren` | Must survive the import with zero members |
| Trashed collection | `Archiv (aufgelöst)` | A row in `deletedCollections`, not a deleted row |
| Child notes | 9, HTML bodies with entities, a blockquote, a list, superscript, a link, and one in Greek | `itemNotes.note` is HTML; `itemNotes.title` is denormalised |
| Item relations | 13 rows, §4.5 | Bidirectional pairs, one dangling, one from a group library |
| Attachments | 17, §4.4 | All four link modes, one missing file, one unresolvable absolute path |
| Annotations | 8, all six types | Including one `isExternal` annotation authored by someone else |
| Base-field mapping | `bookTitle` (`bs-*`), `university` and `thesisType` (`th-*`), `institution`, `reportType` and `reportNumber` (`rp-*`), `repository`, `archiveID` and `genre` (`pp-*`), `websiteTitle` and `websiteType` (`wp-*`), `repository`, `repositoryLocation` and `identifier` (`ds-*`), `proceedingsTitle` (`cp-*`) | `itemData` stores the type-specific field; the CSL/BibTeX mapping needs the base field |
| Zotero multipart dates | every `date` value | Stored `YYYY-MM-DD <what the user typed>`; only the suffix is the datum. Includes a year-only date, a month-year date, a French `8 juin 2021`, a range `2019–2021` and an `n.d.` (`pp-osf-nodoi`) |
| Multi-paragraph abstract | `ja-date-range` | Newlines inside an `itemDataValues` row |
| Very long title | `ja-long-title` (346 characters) with a separate `shortTitle` | |
| En dashes | `ja-endash-pages` page range, and several titles | Not hyphens; must survive a round trip |
| Percent-encoded URL | `wp-long-url` | Query string, `&`, `%E2%80%93` |
| Retracted item | `ja-retracted` | A row in `retractedItems`, which Zotero keeps outside the item |
| Coloured tags | `wichtig`, `to-read`, `Hydrologie` | Stored in `syncedSettings` under `tagColors`, not in `tags`; ignoring that table drops every colour |

### 4.3 Citation keys — three sources, one conflict

`CONCEPT.md` §6 says the importer reads "Zotero 8 native citation keys or Better BibTeX keys from
`better-bibtex.sqlite` / Extra". The fixture has all three, disagreeing.

| Source | Count | Items |
|---|---:|---|
| Native `citationKey` field (Zotero 8+) | 3 | `ja-dedup-published` → `bianchi2023graph`, `ja-native-citekey` → `bianchi2024networks`, `ja-conflicting-keys` → `vasquez2020trace` |
| A `Citation Key:` line in `extra` | 2 | `ja-extra-citekey` → `schmidt2017soil`, `ja-conflicting-keys` → `vasquez2020traceelements` |
| `better-bibtex.sqlite` | 28 rows | 26 naming live items, 12 of them pinned |

`ja-conflicting-keys` carries all three, and all three differ (`vasquez2020trace`,
`vasquez2020traceelements`, `vasquez2020` — the last one pinned). The importer must pick one and the
verification report must say which and why. `ja-extra-citekey`'s Extra also carries a `PMID:` line
and a `tex.keywords:` line, so an Extra parser cannot simply take the first line.

Two Better BibTeX rows are **stale**: they name `itemID`s that are not in this library, which is
what Better BibTeX's own migration filters out (`content/key-manager/migrate.ts`). An importer that
does not filter them invents two items.

`better-bibtex.sqlite` is Better BibTeX's real schema: one table `citationkey(itemID, itemKey,
libraryID, citationKey, pinned)` with three indexes, built from upstream's own DDL with only the
`betterbibtex.` attach-name prefix removed.

### 4.4 Attachments and the verification report

| Slug | Link mode | Parent | On disk |
|---|---|---|---|
| `at-donau-pdf` | `imported_file` | `ja-donau-niederschlag` | yes, with 6 annotations |
| `at-dedup-pdf` | `imported_file` | `ja-dedup-published` | yes, with 2 annotations |
| `at-thesis-pdf` | `imported_file` | `th-diss-ulm` | yes |
| `at-ipcc-pdf` | `imported_file` | `rp-ipcc-ar6` | yes |
| `at-interop-jis-pdf` | `imported_file` | `ja-interop-jis` | yes |
| `at-interop-dap-pdf` | `imported_file` | `ja-interop-dap` | yes — same filename as the row above, different bytes |
| `at-hydro-book-scan` | `imported_file` | `bk-hydrologie-3` | yes |
| `at-preprint-pdf` | `imported_file` | `pp-dedup-preprint` | yes |
| `at-standalone-pdf` | `imported_file` | none, filed in `Datasets & code` | yes |
| **`at-missing-file`** | `imported_file` | `ja-accents-mixed` | **no — key `KRYTCSG5`, no directory, no bytes** |
| `at-snapshot-bmuv` | `imported_url` | `wp-nationale-wasserstrategie` | yes, an HTML snapshot |
| `at-snapshot-github` | `imported_url` | `wp-github` | yes, an HTML snapshot |
| `at-linked-present` | `linked_file` | `ja-endash-pages` | yes, under `linked-attachments/sonderdrucke/` |
| **`at-linked-absolute-missing`** | `linked_file` | `bk-usgs-methods` | **no — an absolute path from another machine, key `E34RN45R`** |
| `at-link-doi` | `linked_url` | `ja-paca-fr` | n/a |
| `at-link-dataset` | `linked_url` | `ds-era5` | n/a |
| `at-link-trashed` | `linked_url` | `wp-dead-link` | n/a, and in the trash |

The two bold rows are what the verification report exists for (`CONCEPT.md` §6: "missing files routed
to `_REVIEW/` with reasons"). They fail for different reasons and the report must distinguish them:
one is a stored file that should be in `storage/<KEY>/` and is not; the other is a link to a path
that only ever existed on someone else's disk.

`itemAttachments.storageHash` is Zotero's **MD5**. Recueil hashes documents with SHA-256 (P2), so
that column is a foreign checksum to verify against, never the document identity. Both hashes for
every file are in `expected-counts.json` under `zotero.storage.contents`, which is what an
attachment-hash coverage report can be asserted against.

The generated files are valid: each PDF is a complete one-page document with a correct
cross-reference table (`pdftotext` extracts the title from all ten), and each snapshot is UTF-8 HTML
with a declared charset. None of them contains anything but generated text — no copyrighted material
is redistributed here.

### 4.5 Relations

Stored in `itemRelations` as URIs, not keys, because the library has never synced: the object of a
row is `http://zotero.org/users/local/v3aG8nQf/items/<KEY>`, where `v3aG8nQf` is the `localUserKey`
in `settings`.

- **`dc:relation`, 11 rows.** Zotero writes both directions, and the fixture keeps that symmetry:
  the preprint/article/dataset triangle (`pp-dedup-preprint`, `ja-dedup-published`,
  `ds-replication`) is six rows, the two textbook editions are two, the chapter and its book are
  two. The eleventh is one-sided on purpose — `ja-athens-el` points at key `QZ4V8MTR`, whose item
  was deleted years ago and whose row Zotero left behind.
- **`owl:sameAs`, 1 row.** `rp-ipcc-ar6` points into a group library
  (`http://zotero.org/groups/2417362/items/QK9WTP2N`) the user has since left.
- **`dc:replaces`, 1 row.** `ja-interop-jis` is the survivor of a merge and points at the key the
  merged-away item had.

`relationPredicates` ids are allocated on first use, so they must be resolved by string.

---

## 5. BibTeX fixtures

Six hand-written files in `bibtex/`. Every one is small enough to read in full; the counts below are
checked on every generator run.

| File | Blocks | For |
|---|---|---|
| `awkward.bib` | 12 entries, 9 `@string`, 1 `@preamble`, 1 `@comment` | the main file, below |
| `crossref.bib` | 6 blocks: 2 containers, 1 `@xdata`, 3 children | inheritance |
| `files.bib` | 5 entries | the `file` field in four mutually incompatible dialects |
| `macros.bib` | 0 entries, 6 `@string` | a macro file with no entries at all |
| `uses-macros.bib` | 4 entries | entries whose `journal` is a macro defined in `macros.bib` |
| `malformed.bib` | 5 blocks | the error path |

**`awkward.bib`** covers, in order of appearance:

- Nine `@string` macros, four of them unused, and one (`jan`) that shadows a BibTeX built-in month
  macro — while `month = aug` and `month = jul` elsewhere use the built-ins that are *not* defined
  in the file.
- An `@preamble` with two `\newcommand`s and string concatenation inside it.
- An `@comment` block, which is not an entry. A parser that counts `@` finds thirteen entries here;
  there are twelve.
- LaTeX accent escapes — `{\"u}`, `{\'e}`, ``{\`e}``, `{\c c}`, `{\^o}`, `{\ss}` — *and* literal
  UTF-8 Greek and Cyrillic in the same file.
- Brace protection that must survive a title-casing style: `{DNA}`, `{SPARC}`, `{COAR}`,
  `{CO$_2$}`, `{Open Access}`, `{LaTeX}`, and single-letter protection like `{D}onau`, `{E}urope`.
- A multi-line `abstract` — five physical lines, one logical value, with the continuation indented.
- Value concatenation with `#`: `camb # ma` and `shortjournal = hessa`.
- `and others`, at the end of a fourteen-author list.
- Three name shapes in one `author` field (`king1963letter`): a suffix (`King, Jr., Martin Luther`),
  a braced corporate name (`{Weltgesundheitsorganisation}`), and a literal UTF-8 surname with a
  `\noopsort` sort-key command in front of it.
- An unbraced numeric value (`year = 1963`).
- A URL with percent-encoding, an ampersand and an underscore, unescaped.
- An entry with no `author` at all (`anon2021editorial`), and a `@misc` and an `@online` alongside
  the `@article`s and `@book`s.

**`crossref.bib`** has a forward reference on purpose: `bs-alpine` names `bk-hydrologie-3` before
that entry appears, so a single-pass resolver inherits nothing. It also mixes BibTeX's `crossref`
(field-by-field inheritance, and the container must carry `booktitle` for it to work) with
biblatex's `xdata` (whose block is not a citable entry).

**`files.bib`** carries the JabRef/Better BibTeX triple (`description:path:type`), a multi-file
value with a semicolon separator and an escaped colon inside a filename, Zotero's own bare absolute
path, Mendeley's brace-and-`$\backslash$:` form, and one entry whose `file` points at something that
is not there — alongside a `pdf` field, which some tools write instead.

**`malformed.bib`** is broken on purpose and is not expected to parse cleanly. Its five faults — an
unclosed brace, two missing commas, a duplicate entry key, an unbraced value containing `@`, and
trailing prose — are listed in a comment at the top of the file. The test question is not "does it
parse" but "does it recover, and does it name precisely what it could not read".

---

## 6. RIS fixtures

| File | Records | Encoding |
|---|---:|---|
| `awkward.ris` | 10 | UTF-8, **CRLF** |
| `endnote.ris` | 3 | UTF-8 **with BOM**, LF |
| `malformed.ris` | 3 `TY`, 3 `ER` | UTF-8, LF |

`awkward.ris` uses CRLF because that is what nearly every publisher's RIS export uses, and covers:
`JOUR`, `BOOK`, `CHAP`, `THES`, `RPRT`, `DATA` and `ELEC` types; a five-line continued `AB` field
with hanging indentation; repeated `KW` and `AU`; `T2` for both a journal and a book title; `A2` for
a book author; `DA` in Zotero's `YYYY/MM//` form next to `PY`; a `Y2` access date with a time; `L1`
for an internal PDF path; an institutional author on one line; a record with no author; a record
with a date range in `DA`; two consecutive `AB` lines that a parser must join rather than overwrite;
and one unknown tag (`XX`) that no specification defines.

`endnote.ris` is EndNote's dialect, which is different enough to break a parser written against
Zotero's: `A1`/`A2`/`A3`/`A4` instead of `AU`, `T1` instead of `TI`, `JF`/`JO` instead of `T2`, `N2`
instead of `AB`, `Y1` instead of `PY`, and continuation lines with *no* indentation at all. It also
starts with a UTF-8 BOM.

`malformed.ris` has four records: one with no `ER`, one whose tag column is a character short
(`AU - ` rather than `AU  - `), one that never declared a `TY`, and one that is well-formed and
comes last — so a parser that gives up on the first fault loses a record it could have had.

---

## 7. CSL-JSON fixtures

| File | Entries | For |
|---|---:|---|
| `awkward.json` | 8 | the general case |
| `dates.json` | 12 | every date shape CSL allows |
| `names.json` | 12 | every name shape CSL allows |

`awkward.json` has a multi-paragraph `abstract`, rich text in a title (`<i>`, `<sub>`,
`<span class="nocase">`), a `literal` institutional author, `non-dropping-particle` and
`dropping-particle` on separate authors, a `suffix` with `comma-suffix: false`, a `note` field
carrying a `Citation Key:` line in Zotero's convention, `container-author` and `editor` on one
chapter, `citation-key` as a first-class key, and Zotero's `custom.zotero` block.

`dates.json` covers a bare year; a year and month; a full date; a two-endpoint range; an open-ended
range (`[[1994], [null]]`); a `season`; `circa`; a `literal` date that could not be parsed at all; a
`raw` string in French; an `edtf` value with an uncertainty qualifier; a BCE date (`-44`); and an
entry with no date at all.

`names.json` covers a plain name; the same person written once with `non-dropping-particle` and once
with the particle folded into `family` (a deduplicator has to see they are one person); a
`dropping-particle`; two suffix conventions; a `literal`; `static-ordering` on a CJK name; initials
as `given`; two people sharing a surname; no creator array at all; and one item carrying six
different creator roles.

---

## 8. `expected-counts.json`

Written by the generator, asserted against the hand-written numbers in `zotero/lib/counts.mjs` and
`lib/text-fixtures.mjs` before it is written at all. Top-level keys:

| Key | Contents |
|---|---|
| `upstream` | the repository, tag and commit of every vendored schema file, read out of `SOURCES.md` so the two cannot contradict each other |
| `verification` | driver, SQLite version, `integrity_check`, foreign-key violation count, userdata and global-schema versions, table count |
| `zotero.identifierLayout` | `legacy` or `fresh` |
| `zotero.itemTypeIds` | every `typeName` → `itemTypeID` in the built database |
| `zotero.items`, `.liveByType`, `.allByType` | §4.1 |
| `zotero.notes`, `.attachments`, `.annotations` | §4.1, §4.4 — including `attachments.missing`, with a key and a reason for each |
| `zotero.collections`, `.tags`, `.creators`, `.relations` | §4.1 |
| `zotero.citationKeys` | §4.3 |
| `zotero.storage.contents` | every generated file with its path, size, MIME type, MD5 and SHA-256 |
| `formats` | per-file counts for `bibtex/`, `ris/` and `csl-json/` |

An importer test should read this file rather than copy numbers out of this document.

---

## 9. Using this from a test

```js
import { readFileSync } from 'node:fs';

const counts = JSON.parse(readFileSync('fixtures/expected-counts.json', 'utf8'));

// The Phase 1 exit criterion, in one assertion.
expect(report.items.imported).toBe(counts.zotero.items.regularLive);          // 64
expect(report.itemsByType.article).toBe(counts.zotero.liveByType.journalArticle); // 20

// The verification report has to name both broken attachments, and say why they differ.
expect(report.review.map((r) => r.itemKey).sort())
  .toEqual(counts.zotero.attachments.missing.map((m) => m.itemKey).sort());

// Attachment-hash coverage: Recueil's SHA-256 for every file the importer did find.
for (const file of counts.zotero.storage.contents) {
  expect(documents.get(file.sha256)).toBeDefined();
}
```

To prove the importer resolves item types by name rather than by number, build the other
identifier layout into a temporary directory in the test's setup and run the same assertions
against it — every count is identical, and not one numeric identifier is:

```sh
node fixtures/zotero/make-fixture.mjs --id-layout=fresh --out="$TMPDIR/zotero-fresh"
```

---

## 10. Still to come

`CONCEPT.md` §8 lists Paperless as a fixture too. Its importer is Phase 2 (§7), and there is no
Paperless fixture here yet — adding one before the importer exists would be guessing at the shape of
its API export. It belongs in `fixtures/paperless/` when Phase 2 starts.
