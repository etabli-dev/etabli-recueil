# `@recueil/import-zotero`

The Zotero migrator.

CONCEPT.md [§6](../../CONCEPT.md) makes Zotero migration first-class, and §7 makes it the M1 exit
criterion: *"own library imported at 100% item count with attachment-hash coverage report"*. This
package is that importer, and the report it produces is the artefact that criterion is judged on.

```ts
import { createRecueil } from '@recueil/core';
import { importZoteroLibrary } from '@recueil/import-zotero';

const recueil = createRecueil({ databaseUrl: 'library.sqlite', storagePath: 'store' });
const { report } = await importZoteroLibrary(recueil, {
  databasePath: '/home/me/Zotero/zotero.sqlite',
  reportDirectory: './zotero-import',
});
if (!report.pass) process.exitCode = 1;
```

## The source library is never written to

The user's `zotero.sqlite` is their only copy of a decade of work. "Read-only" here is four
independent mechanisms, applied together because any one of them could be got wrong:

1. the file — and its `-wal`/`-shm` companions, if a running Zotero left them — is **copied** into a
   temporary directory, and the copy is what gets opened. In this mode, which is the default, the
   original is touched by exactly one call, `fs.copyFile`, which opens it `O_RDONLY`;
2. SQLite opens it with `readonly: true`;
3. `PRAGMA query_only = 1` is set and then **asserted**, not assumed;
4. `ReadOnlyDatabase` exposes no method that can run anything but a `SELECT` or a read-only
   `PRAGMA`, and checks better-sqlite3's own `statement.readonly` flag on every prepare.

The SHA-256 of the source file is taken before and after the run, and the report states both. If
they differ, the `source_unchanged` check fails and the report says `FAIL`.

Copying also removes the one real hazard of reading in place: a hot journal makes SQLite want to
recover on open, recovery is a write, and a read-only handle then either fails or — worse — an
in-place one succeeds. `copySourceBeforeReading: false` opens the file directly, still read-only,
for a caller who has already taken their own copy.

**"Exactly one call" is a claim about the default and does not hold in that mode.** Opening a WAL
database in place makes SQLite create or rewrite `zotero.sqlite-shm` in the Zotero data directory,
read-only handle or not — so `copySourceBeforeReading: false` now **refuses** a database with a
live `-wal` beside it rather than writing next to the user's library. On a cleanly closed database
there is no log and nothing to rewrite.

## Layout

| Path | What lives there |
|---|---|
| `src/reader/readonly-db.ts` | The four mechanisms above, and the source fingerprint |
| `src/reader/zotero-library.ts` | Every query against `zotero.sqlite`, memoised; the Better BibTeX store |
| `src/reader/types.ts` | Zotero's row shapes, in Zotero's own names |
| `src/map/item-types.ts` | Zotero item type → Recueil item type, and the CSL type |
| `src/map/fields.ts` | Zotero fields → the bibliographic facet, via Zotero's base-field table |
| `src/map/creators.ts` | Names and roles |
| `src/map/dates.ts` | Zotero's multipart date → EDTF |
| `src/map/extra.ts` | Reading the `Extra` conventions, never rewriting them |
| `src/map/citation-keys.ts` | Which of three disagreeing keys an item keeps (ADR-0016) |
| `src/map/annotations.ts` | Zotero annotations → W3C selectors (ADR-0009, ADR-0017) |
| `src/attachments.ts` | Finding the bytes: `storage/`, a linked path, or a WebDAV zip |
| `src/zip.ts` | Just enough ZIP to read a WebDAV attachment, with the CRC checked |
| `src/job.ts` | The `jobs` row: the idempotency key and the cursor (P9, IK1–IK4) |
| `src/import.ts` | The ten stages |
| `src/report/` | The verification report: types, builder, Markdown, `_REVIEW/` |

## The stages, and why they run in that order

1. **collections**, **tags**, **creators** — items refer to all three.
2. **items**, every one of them *live*, including the ones Zotero has in its trash.
   `NoteService.create` refuses a trashed parent, and Zotero keeps notes and attachments on trashed
   items; creating everything live and trashing at the end reproduces Zotero's state without a
   special case for every child of a trashed parent.
3. **attachments** — resolve, hash, ingest as a Document (ADR-0004), link.
4. **notes**, then **annotations** (which need their attachment's document), then **relations**
   (which need every item to exist before a target can be resolved).
5. **trash** — `deletedItems` and `deletedCollections`, cascading to children as
   `LibraryService.trashItem` does.
6. **finalise** — the values that had to wait for the trash, and `date_modified`.

## The mapping

**Item types.** Where Recueil ships a type that means the same thing, the Zotero type maps onto it
(`journalArticle` → `article`, `bookSection` → `chapter`). Where it does not, the Zotero type is
carried across as a slug of its own (`blog_post`, `audio_recording`) rather than flattened into the
nearest core type — the item-type vocabulary is open (`spec/data-model.md` §3.4) precisely so that
a migration does not have to lose the distinction. Either way the CSL type is recorded on
`item_bibliographic.csl_type`, read from the library's own global schema where it has one.

**Fields** are resolved through Zotero's `baseFieldMappingsCombined`, so a thesis's `university`, a
report's `institution` and a dataset's `repository` all reach the `publisher` column without three
table entries. A field with no facet column goes to a `zotero_<field>` custom field under its
*recorded* name (`zotero_report_number`, not `zotero_number`), and an identifier the contract
refuses — an ISBN whose check digit is wrong — is carried the same way, with the reason. Nothing is
dropped, and the report counts every carried field.

**Names.** A particle in the family string (`van der Berg`, `de Beauvoir`) is *not* split into
`name_prefix`: Zotero did not split it, the author does not, and ADR-0016 keeps an embedded particle
in the citation key because that is what Better BibTeX does. Zotero's field mode 1 becomes an
organisation with a `literal_name`, unsplit.

**Citation keys** come from four places, in this order of deliberateness: Zotero 8's native
`citationKey` field, a `Citation Key:` line in `Extra`, a pinned `better-bibtex.sqlite` row, an
unpinned one. All four are imported **pinned** — ADR-0016: "keys arriving from migration … are
imported pinned, so migration cannot rewrite a key that is already in a manuscript" — which means
both `citation_key_locked` and a `field_provenance` lock, so a later resolver run is refused rather
than merely discouraged. Every disagreement between the sources is a review entry naming all the
candidates.

**Annotations** become W3C selector sets (ADR-0017), always including one selector that resolves
without the text layer — a `RectangleSelector`, an `InkSelector` or at minimum the page — because
invariant AN4 requires it. Zotero's `sortIndex` is carried across as `position_sort_key`, re-padded
to a fixed width.

## Idempotence and resumability (P9)

Every write is keyed by something the source library owns:

| Entity | Key |
|---|---|
| Item | `(source_system, source_id) = ('zotero', <item key>)` |
| Document | the SHA-256 of its bytes (ADR-0004, D1) |
| Attachment | its item plus its document, URL or path |
| Collection | its parent and its name |
| Tag | its name |
| Creator | its exact name parts |
| Note | its parent and its verbatim source HTML (`content_original`) |
| Annotation | `external_ref = zotero:<annotation key>` |
| Custom-field value | its `(field, item)` slot |

So importing the same library twice produces the same library, and there is no bookkeeping table to
keep in step. The run is a `jobs` row with the key IK1 prescribes,
`import.zotero:<library_hash>:<run_label>`, and a cursor written after every record; a resumed run
skips the stages that finished, rebuilding from the database the identifier maps those stages would
have produced, and repeats the interrupted one from its start.

Observations — an attachment's outcome, a skipped record, a review entry — are written to
`job_logs` as they happen rather than accumulated in memory (§6.4), which is why the report of a run
that was interrupted three times says exactly what the report of an uninterrupted one says.

## The verification report

Three artefacts under `reportDirectory`:

- **`report.json`** — the report. Machine-readable, versioned, and what a test asserts against.
- **`report.md`** — the same numbers for a person, rendered *from* the JSON so the two cannot drift.
- **`_REVIEW/`** — one file per thing that needs a decision, plus `index.json` and a README.

The report is built by comparing the two databases, not by narrating the run: every Zotero count is
a query against `zotero.sqlite`, every Recueil count a query against the library that was just
written, and the delta is the difference. It carries counts per item type with a per-type delta,
attachment-hash coverage (resolved / missing / unreadable, with the SHA-256 of each file and whether
it still matches the MD5 Zotero recorded), collections, tags, notes, annotations, relations,
creators and citation keys reconciled, the trash reconciled, every skipped record with its reason,
and a top-level `pass` decided by named blocking checks — of which exact item-count parity is the
one §7 asks for.

**A missing file does not fail the run.** CONCEPT §6 asks for missing files to be *reported*, and P3
says flag rather than guess: the attachment record survives, pointing at where the file should be, a
review entry carries the reason, and `attachment_hash_coverage` is an informational check.

**Every blocking check asserts equality, and every one has a test that watched it fail** (ADR-0021
§3, §4). Four of them — `trash_parity`, `collection_parity`, `tag_parity` and `creator_parity` —
were written as `>=` in the Phase 1 round: an inequality open in the direction that permits
duplication, so a run that trashed everything, or wrote every collection twice, satisfied them, and
none of the four had a test that ever watched one fail. Each now scopes its target side to what this
import created — Zotero-deleted rows matched by key, collections and tags matched by name one for
one, creator appearances counted on the imported items — and compares for equality.
`test/report-checks.test.ts` breaks each of the eleven blocking checks in turn, including in the
over-writing direction the old inequalities could not see.

## Known limitations

- **Zotero item keys are not carried into `public_id`.** `spec/data-model.md` §1.3 says the
  eight-character public key is "Zotero-key-shaped so an imported Zotero item key can be carried
  across unchanged", and `PublicIdSchema` enforces Crockford base32 — which excludes `I`, `L`, `O`
  and `U`. Zotero's own alphabet includes all four and excludes `0` and `1`, so a majority of real
  Zotero keys are not valid Recueil public ids (58% of the fixture library's). The importer
  therefore mints fresh public ids and keeps every Zotero key in `items.source_id`, which is what
  the idempotency rule needs anyway. Reconciling the two shapes is a contract decision for
  `@recueil/schemas`, not something an importer should decide by writing invalid ids.
- **A tag on a Zotero note, and a note filed in a collection, cannot be represented.** Recueil tags
  items and annotations (§4.4, §4.5) and files items in collections (§4.2); a note is neither. Both
  are reported as skipped rather than reassigned to the note's parent, which would put a tag on a
  paper because somebody tagged a note about it.
- **Relations are carried in a custom field, not as graph edges.** `graph_edges` arrives with the
  graph phase (`spec/data-model.md` §11). Until then each item's `itemRelations` are written to a
  `zotero_relations` JSON field, resolved to Recueil ids where the target is in this library and
  kept as the raw Zotero URI where it is not. That field is the graph migration's input, rather than
  a second pass over the user's Zotero library.
- **Citation keys are imported, never invented.** An item Zotero has no key for gets none here; the
  report counts them. Generating the rest belongs to the library's own key service, which needs the
  whole library — not just the Zotero part of it — to disambiguate correctly (ADR-0016).
- **The source library is read into memory.** One query per relation rather than one per item, which
  is the right trade at the scale of a personal library and would need revisiting for one an order
  of magnitude larger.
- **A standalone Zotero attachment gets a host item.** `attachments.item_id` is not nullable, so a
  parentless file becomes an `attachment_only` item. Those are counted separately from item-count
  parity, because counting them in would flatter it.

## Tests

Against the synthetic library in [`fixtures/zotero/`](../../fixtures/zotero), asserted against the
counts stated in `fixtures/expected-counts.json` — which were written by hand from the library's
design before the generator ever ran, so a fixture that drifts cannot quietly take the assertions
with it.

```
pnpm --filter @recueil/import-zotero test
```
