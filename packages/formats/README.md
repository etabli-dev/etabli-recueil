# `@recueil/formats`

Citation keys and bibliographic serialisation: BibTeX, BibLaTeX, RIS and CSL-JSON, in both
directions.

Pure functions over `@recueil/schemas`. There is deliberately **no** dependency on
`@recueil/core`: a citation key and a `.bib` entry are functions of the contract, not of the
database, so the REST API, the CLI, the MCP server and the Zotero importer all call the same code
without one of them having to open a library first. It also means every behaviour in here is
testable against a literal fixture string.

## Layout

| Path | What lives there |
|---|---|
| `src/record.ts` | `FormatRecord` — the flattened projection of `Item` every function here works over — and `recordFromItem` |
| `src/loss.ts` | `LossEntry`, `LossReport`, `ExportResult`, `ImportResult` |
| `src/limitations.ts` | `FORMAT_LIMITATIONS`: what each format cannot represent, as data |
| `src/dates.ts` | EDTF ↔ `date-parts` ↔ `year`/`month` ↔ RIS `DA` |
| `src/identifiers.ts` | Normalisation to invariant B1 on import, with a reason when a value is refused |
| `src/names.ts` | The BibTeX name grammar, RIS `Family, Given, Suffix`, CSL name objects |
| `src/text/transliterate.ts` | ADR-0016's romanisation: NFKD, the explicit map, ISO 843 and ISO 9 |
| `src/text/latex.ts` | Escaping, accent folding, brace protection, and the inverse of all three |
| `src/keys/` | The skip-word list, the pattern-language parser, `generateKey` and `disambiguate` |
| `src/mapping/types.ts` | Item type ↔ entry type / `TY` / CSL type, in both directions |
| `src/bibtex/` | The `.bib` parser, the field order, the `file` field, both dialects |
| `src/ris/` | RIS export and import |
| `src/csl/` | CSL-JSON export and import |

## Citation keys (ADR-0016)

The default formula is Better BibTeX's, `auth.lower + shorttitle(3,3) + year`, because the value of
a key is that it is the same one as last year:

```ts
generateKey(ravaud); // 'ravaudEffPreSys2019'
```

`disambiguate(records, { ledger })` assigns keys to a batch. Colliding keys are ordered by creation
timestamp and then by id — never by the caller's array order — the first keeps the bare key and the
rest get a bijective base-26 suffix (`a`, `b`, … `z`, `aa`). A key in the ledger is never reissued,
because a key that has been in a manuscript must not come back attached to a different work.

**Pinned keys are never recomputed.** `citationKeyLocked` on the facet is respected by both
`generateKey` and `disambiguate`, and every importer here sets it, so a migration cannot rename a
key that a `.tex` file already points at.

The formula is configurable in a documented subset of Better BibTeX's pattern language — functions
`auth`, `authors(n)`, `authEtal`, `authorLast`, `shorttitle(n,m)`, `title(n,m)`, `veryshorttitle`,
`year`, `shortyear`, `journal`, `doi`; modifiers `.lower`, `.upper`, `.capitalize`, `.abbr`,
`.condense(s)`, `.replace(x,y)`, `.select(n,m)`. Anything outside it is rejected by `parsePattern`
with a `PatternError` naming the offending token; nothing is ever silently ignored.

One implementation detail differs from the reading order of ADR-0016 and is worth knowing: the Greek
and Cyrillic romanisation tables run **before** NFKD as well as after it. `й` is precomposed, so
NFKD-then-strip-marks would fold it to `и` and ISO 9's answer (`j`) would never be reached.

## Serialisation

```ts
const { text, losses } = exportBiblatex(records);
const { records, losses } = importBibtex(text);
```

Every exporter returns `{ text, losses }`; every importer returns `{ records, losses }`. Field order
is fixed (`BIBTEX_FIELD_ORDER`, `RIS_TAG_ORDER`, `CSL_VARIABLE_ORDER`) so that a `.bib` file in a Git
repository next to a manuscript produces an empty diff when nothing has changed.

Exports mirror importers (P10), and that is asserted rather than asserted-to: `test/roundtrip.test.ts`
exports a record, imports it and exports again, and requires the two files to be byte-identical.

### Dialect differences

| | `bibtex` | `biblatex` |
|---|---|---|
| Non-ASCII | folded to `\'{e}`, `{\ss}` | UTF-8, verbatim |
| Date | `year` + `month` macro | `date`, ISO-8601/EDTF |
| Journal | `journal` | `journaltitle` |
| Place | `address` | `location` |
| Subtitle | appended to `title` after a colon | its own `subtitle` field |
| Language | `language` | `langid` |
| arXiv | `eprint` + `archiveprefix` | `eprint` + `eprinttype` |
| Entry types | fourteen | thirty-odd, so fewer collapse to `@misc` |

### Item type mapping

| Recueil | BibTeX | BibLaTeX | RIS | CSL |
|---|---|---|---|---|
| `article` | `@article` | `@article` | `JOUR` | `article-journal` |
| `book` | `@book` | `@book` | `BOOK` | `book` |
| `chapter` | `@incollection` | `@incollection` | `CHAP` | `chapter` |
| `report` | `@techreport` | `@report` | `RPRT` | `report` |
| `thesis` | `@phdthesis` | `@thesis` | `THES` | `thesis` |
| `dataset` | `@misc` | `@dataset` | `DATA` | `dataset` |
| `preprint` | `@misc` | `@misc` | `UNPB` | `article` + `genre: preprint` |
| `webpage` | `@misc` | `@online` | `ELEC` | `webpage` |
| `conference_paper` | `@inproceedings` | `@inproceedings` | `CPAPER` | `paper-conference` |
| `software` | `@misc` | `@software` | `COMP` | `software` |
| `standard` | `@misc` | `@report` | `STAND` | `standard` |
| `patent` | `@misc` | `@patent` | `PAT` | `patent` |
| `letter` | `@misc` | `@misc` | `PCOMM` | `personal_communication` |
| `photo` | `@misc` | `@misc` | `ART` | `graphic` |
| `invoice`, `contract`, `receipt`, `certificate`, `note`, `attachment_only` | `@misc` | `@misc` | `GEN` | `document` |

CSL 1.0.2 has no `preprint` type, so a preprint goes out as `article` with `genre: preprint` and
comes back as a preprint. A finer CSL type than the round trip would reproduce — `article-magazine`,
say — is kept on `bibliographic.cslType` and used again on the way out.

## What each format cannot represent

The same table lives in `src/limitations.ts` as `FORMAT_LIMITATIONS`, and
`test/limitations.test.ts` probes every reportable entry with a record that sets exactly that field
and requires the exporter to name it in the loss report. A limitation that stops being reported
fails the build.

**All four formats** drop the OpenAlex work id, the Semantic Scholar paper id, the linking ISSN, a
second (DataCite) DOI and a Handle; they drop the open-access status, the published-version DOI and
the retraction-notice DOI, because those are check results rather than bibliographic data; and they
drop per-field provenance, the manual locks and the key formula, which are library state. The last
three never reach an exporter at all: `recordFromItem` leaves them behind when it projects an `Item`
onto a `FormatRecord`.

**Classic BibTeX** additionally cannot hold: a subtitle (appended to the title after a colon and not
recoverable); a day, a range or an approximation in a date; an online-first date; a series number on
an `@article`, whose `number` is the issue; a version label; a licence; an electronic ISSN when
there is a print one; a CSL type override; a translator or any creator that is not an author or an
editor; a note beyond the one `note` field, which the Extra field takes; and an attachment role — the
`file` field carries a title, a path and a MIME type and nothing else. Nine of the twenty built-in
item types collapse to `@misc`. The `urldate` field is a calendar date, so the time of day on
`accessedAt` goes.

**BibLaTeX** keeps the subtitle, the full date, the version and the translator, and collapses fewer
item types. It still cannot hold an online-first date, a series number on an `@article`, a licence,
a displaced electronic ISSN, a CSL type override, a creator outside author/editor/translator or an
attachment role.

**RIS** cannot hold: a subtitle; a date range or approximation; a PMID, PMCID or arXiv id, none of
which are in the standard tag set; an ISBN when there is also an ISSN, since both share `SN`; a
series number, which `IS` gives to the issue; a page total; a version label; a licence; a CSL type
override; a name particle, which is folded into the family name; a creator outside `AU`/`A2`/`A4`;
notes as distinct from the Extra field, since both are written as `N1`; and an attachment title,
because `L1` is a path and nothing else. A corporate author is written with the trailing comma the
format uses for the purpose, and read back the same way.

**CSL-JSON** cannot hold: a subtitle; an open-ended date interval, which `date-parts` has no spelling
for; an arXiv id; a displaced electronic ISSN; a licence; a creator outside author/editor/translator;
notes as distinct from Extra; and attachments at all — CSL-JSON is the input format of a citation
processor and has no concept of a file on disk.

## Scripts

```sh
pnpm --filter @recueil/formats run build      # tsc → dist/, with declarations
pnpm --filter @recueil/formats run typecheck  # tsc --noEmit, sources and tests
pnpm --filter @recueil/formats run test       # vitest
```

## Licence

AGPL-3.0-or-later.
