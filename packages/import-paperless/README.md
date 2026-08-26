# `@recueil/import-paperless`

The Paperless-ngx migrator.

CONCEPT.md [§6](../../CONCEPT.md) makes Paperless-ngx the second first-class migration, and §7 makes
it the M2 exit criterion: *"Paperless decommissioned after verified import"*. This package exports
documents, tags, correspondents, document types, custom fields, notes, the archive serial number and
the originals from the Paperless-ngx REST API, and maps them onto the Recueil **Office facet**
(`spec/data-model.md` §3.7). The report it produces is the artefact that decommissioning decision is
made on.

```ts
import { createRecueil } from '@recueil/core';
import { importPaperless } from '@recueil/import-paperless';

const recueil = createRecueil({ databaseUrl: 'library.sqlite', storagePath: 'store' });
const { report } = await importPaperless(recueil, {
  baseUrl: 'https://paperless.example',
  token: process.env.PAPERLESS_TOKEN,
  reportDirectory: './paperless-import',
});
if (!report.pass) process.exitCode = 1;
```

---

## What is unproven

**This package has never spoken to a real Paperless-ngx server.** Nothing in this repository has.

Every type, route, envelope and status code was transcribed from the published source of
**Paperless-ngx 3.0.5** (tag `v3.0.5`, released 2026-08-01), and the tests run against an in-process
fake of it. The specific files read, and what was taken from each:

| Upstream file at `v3.0.5` | What was transcribed |
|---|---|
| `src/documents/serialisers.py` | The field list of every serialiser: `DocumentSerializer`, `CorrespondentSerializer`, `DocumentTypeSerializer`, `TagSerializer`, `CustomFieldSerializer`, `CustomFieldInstanceSerializer`, `NotesSerializer`, `StoragePathSerializer` |
| `src/documents/models.py` | `CustomField.FieldDataType` (the ten data types) and the monetary storage format |
| `src/documents/views.py` | The `metadata`, `download`, `preview` and `notes` actions, and `ordering_fields` |
| `src/documents/filters.py` | `ID_KWARGS = ["in", "exact"]` — which is why there is no keyset pagination |
| `src/paperless/views.py` | `StandardPagination`: `page_size = 25`, `page_size_query_param`, the `count`/`next`/`previous`/`all`/`results` envelope and the `all` cutoff at API v10 |
| `src/paperless/settings/__init__.py` | `REST_FRAMEWORK`: `AcceptHeaderVersioning`, `DEFAULT_VERSION = "10"`, `ALLOWED_VERSIONS = ["9", "10"]`, `TokenAuthentication` |
| `src/paperless/middleware.py` | `ApiVersionMiddleware`, which sets `X-Api-Version` and `X-Version` on authenticated responses only |

That is enough to prove the mapping, the pagination, the resumption, the ASN rules, the hostile-input
handling and every number in the report. **It is not a compatibility claim.** A fake built from a
server's own source cannot discover that the server behaves differently from its source, that a
deployment sends a field this package does not know about, or that a reverse proxy in front of it
changes something on the way past.

There is a second corpus, and it is worth being precise about what it adds.
`test/fixture-corpus.test.ts` runs the importer against `fixtures/paperless/` — the API dump, route
table and eleven originals the repository committed as its Paperless reference — loaded through
`paperlessFixtureCorpus()` and served by the same fake. That corpus's counts were written by hand in
`fixtures/lib/paperless.mjs` *before* its generator ran, and are published in
`fixtures/expected-counts.json`, so the parity assertions compare the importer against a figure it
had no part in choosing rather than against a library written by the same hand. It also carries
awkward material `src/testing/fixtures.ts` does not: a Greek original filename that cannot go in a
`Content-Disposition` header unencoded, a filename with `:`, `*`, `?` and a trailing dot, a 303-character
title, and a document whose download answers 500.

What it does **not** add is a compatibility claim. The dump was written from the documented API, not
captured from a running server — and it declares Paperless-ngx 2.14.7 / API 6, which is older than
this client speaks. Stood up behind those headers, the importer refuses with
`PaperlessApiVersionError` rather than guessing at the older envelope; there is a test for that. The
parity run therefore serves the corpus's *data* through the fake's modelled 3.0.5 envelope, and
`source.versionMatchesModel` in that report is a property of the fake.

What would make it a claim, in order of value:

1. **A captured fixture.** Run against a real instance — or simply `curl` the six list endpoints plus
   one `metadata` response with a real token — and commit the responses, scrubbed, beside the
   generated ones in `fixtures/paperless/`, with the release they came from recorded. Then assert the
   fake's output against them field by field. The loader already turns that directory into a
   `FakeLibrary`, so a captured dump would drop straight into the existing test. Until one exists,
   `source.versionMatchesModel` in the report is the only signal a reader gets, and it compares
   version strings, not behaviour.
2. **One real migration, verified.** The M2 exit criterion is not "the importer runs"; it is
   "Paperless decommissioned after verified import". That means a real run, a report that says PASS,
   and a person who has read the review queue.

The report says the same thing in its own words: `source.modelledAgainstVersion` records 3.0.5,
`source.serverVersion` records what the server actually said, and the non-blocking
`server_version_modelled` check compares them.

---

## The mapping

### Document → Item + Office facet

| Paperless | Recueil | Notes |
|---|---|---|
| `id` | `items.source_id` (with `source_system = 'paperless'`) | The identity that makes a re-run idempotent |
| `title` | `items.title` | A document with an empty title gets `Paperless document <id>` |
| `document_type` | `items.item_type` **and** `item_office.office_document_type` | See below |
| `correspondent` | `item_office.correspondent` | The column is `NOT NULL`; see below |
| `created` | `item_office.document_date` | The **printed** date, so the local calendar day is kept, not the UTC one |
| `archive_serial_number` | `item_office.asn` | Preserved and unique; see below |
| `added` | `items.date_added` | |
| `modified` | `items.date_modified` | Written in the `finalise` stage, because the services set it to now |
| `tags[]` | `tags` + `item_tags` | Scheme `imported`, colour carried |
| `notes[]` | `notes` | Keyed by item and text, so a re-run does not double them |
| `custom_fields[]` | `custom_fields` + `field_values` | Types preserved one-for-one; see below |
| `storage_path` | custom field `paperless_storage_path` | A filename template has no meaning in a content-addressed store |
| the original file | `documents` + `attachments` (role `scan`) | Hashed into the store (ADR-0004) |

### Document types: item type *or* a custom field, and in fact both

CONCEPT §6 says "document types → item type or a custom field, whichever the data supports". The
answer here is three columns, each doing one job:

- `items.item_type` gets a **core Recueil type** when the Paperless name is recognisably one —
  `invoice`, `letter`, `contract`, `receipt`, `certificate`, `photo` — and `document` otherwise. The
  item type is what a list view groups by and what a rule matches on, so it wants the small shared
  vocabulary.
- `item_office.office_document_type` gets the **slug of the Paperless name, always**. §3.7 makes that
  column an open vocabulary precisely so the importer can carry user-defined types across, and it is
  what keeps `kfz_versicherung` distinguishable from `hausratversicherung` when both are `contract`.
- the custom field `paperless_document_type` gets the **name verbatim**, because slugging is lossy
  and P10 says exports mirror importers.

The recognition table (`src/map/document-types.ts`) is English and German, matched on the **whole**
slugged name and never on a prefix: `Rechnungsprüfung` is not an invoice.

### Custom fields

| Paperless `data_type` | Recueil `dataType` | |
|---|---|---|
| `string` | `text` | |
| `longtext` | `long_text` | |
| `url` | `url` | A value that is not an `http(s)` URL is skipped with a reason |
| `date` | `date` | |
| `boolean` | `boolean` | |
| `integer` | `integer` | |
| `float` | `number` | |
| `monetary` | `monetary` | Parsed from digits, never through a float; see below |
| `select` | `choice` | The **label** is stored, not Paperless's random option id; the ids go in `config.paperlessOptionIds` so it is reversible |
| `documentlink` | `item_reference`, repeatable | One value per link; a target outside the import is a review entry, never a dangling id |

A data type this importer has never heard of — a future Paperless release will add one — is **not**
defined and its values are **not** written. Putting them in a `text` column would be data that means
something else.

### Money

Paperless stores a monetary value as a string, in the current form (`GBP123.45`, `EUR-89.90`) or the
legacy one (a bare `123.45`). Recueil stores minor units as an integer with the currency beside it,
and `ck_item_office_amount` requires both or neither.

- Minor units come from the **digits**, never from arithmetic: `Math.round(89.9 * 100)` is 8990 by
  luck and `Math.round(1.005 * 100)` is 100 by binary rounding.
- The minor-unit exponent comes from a table, so `JPY1200.00` is 1200 minor units and not 120 000.
- A value with no currency and no `extra_data.default_currency` and no `defaultCurrency` option does
  **not** reach the facet. Guessing a currency changes what a number means. The value is still on its
  own custom field, and the report says how many did that.
- Recueil records a monetary currency once per *field*; Paperless records it per *value*. Where all
  the values in a field agree, the currency is carried on the field. Where they disagree, the amounts
  are carried, the codes are not, and the report lists the field under "what is not carried".

### The archive serial number

CONCEPT §6 asks for the ASN to be "preserved and unique", and `ux_item_office_asn` is unique among
live items, so both are satisfiable only by asking the database who holds a number before writing it.
Three outcomes:

- **free** (or held by this very document on a re-run) — kept;
- **held by another Paperless document**, which means Paperless itself has a duplicate — the lower
  document id keeps it. The owner is computed from the whole document list, not accumulated as the
  run goes, so an interrupted run reaches the same answer as an uninterrupted one;
- **held by an item that is not from this import** — the ASN is left off, and a review entry names
  both claimants.

In every refusal the number goes to the `paperless_asn` custom field, so nothing is lost, and the
report's `asn_unique` check re-queries the whole library afterwards.

### A document with no correspondent

`item_office.correspondent` is `NOT NULL`, because the facet exists to answer "who is this from".
A Paperless document with `correspondent: null` gets `missingCorrespondentLabel` (default
`Unknown correspondent`) and is **counted** in the report rather than given its own review entry —
on a real install the number runs to hundreds, and a review queue with four hundred identical entries
in it is a review queue nobody reads.

---

## Everything that arrives from the server is hostile

A Paperless install is trusted in the sense that its owner runs it. Its *contents* are not: a
filename, a title and a tag name are strings a person typed, and a pagination link is a URL a reverse
proxy composed.

- **Pagination links are never followed.** `next` and `previous` are built by DRF from the request it
  saw, which is to say from `Host` and any `X-Forwarded-*` header that reached it. The client walks
  pages by number against a URL it constructed from `baseUrl`. An off-origin `next` raises
  `PaperlessUntrustedUrlError` rather than being quietly ignored, because it means something a person
  should know about.
- **Redirects are followed only within the configured origin**, with `redirect: 'manual'` and an
  explicit check. A 302 to another host is the same credential leak as an off-origin link.
- **Filenames are reduced to a basename** before they reach `documents.original_filename`, with path
  separators, `..` and control characters removed. The raw string is kept in the provenance JSON,
  where it is data and never a path. The store is content-addressed, so no filename ever becomes a
  path anyway — but P10 says exports mirror importers, and the day something writes a file by that
  name it must not be able to leave its directory.
- **The credential appears in one place**, the `Authorization` header. It is refused in the URL
  (`https://user:pass@host` throws), it never reaches an error message, a job row, a log line or the
  report, and `redactUrl` scrubs anything credential-shaped out of a URL before it is quoted back.
- **A name that is not a slug is made into one** rather than rejected: German is folded
  (`Bürgeramt` → `buergeramt`), a name that begins with a digit gets an `x_`, and a collision the
  fold creates is numbered and reported.

`test/hostile-input.test.ts` walks the store and the review directory after an import of a fixture
full of `../../../etc/passwd` and asserts that every path written is inside its root.

---

## The verification report

The same shape as the Zotero importer's, and built on the same rule:

> **Every side of every count is a query.** The Paperless side comes from what the API returned; the
> Recueil side comes from the target's own tables. Neither side is ever counted from `job_logs`, from
> the importer's plans, or from anything else that is a narration of the run.

`job_logs` *is* read — for the reasons: why an original could not be fetched, why a value could not be
represented, what a review entry suggests doing. Never for a number a check compares. That distinction
is what the Phase 1 review paid for, and the Phase 2 review found it broken again in three blocking
checks, so it is now enforced three ways (ADR-0021):

- **`pass` is derived from the two numbers the table prints**, through one `check()` helper. The
  Phase 2 review quoted `PASS asn_preserved expected=6 actual=0`; a verdict that disagrees with its
  own numbers is no longer expressible.
- **Every exclusion is a named finding.** A tag id the documents carry that `/api/tags/` never
  defined, a custom field id `/api/custom_fields/` never defined, a value the source's own field
  definition gives no meaning to, an item a person has put in the trash: each has its own listed
  entry, and the first two have their own blocking check. The alternative — subtracting the loss
  from both sides and calling the remainder parity — is how a report comes to say PASS over a
  library that lost every one of its tags.
- **Every blocking check has a falsification test.** `test/report-checks.test.ts` breaks the target
  (or the source) in the way each check exists to detect and asserts the check FAILS, and its first
  test asserts that the set of checks with a falsification is exactly the set of blocking checks the
  report emits — so a check added without one turns the suite red naming it. It also stuffs the job
  log with fabricated `skipped` records over a damaged target and asserts the report stays red.

Three artefacts, when `reportDirectory` is given:

- `report.json` — the report. Machine-readable, and what a test asserts against.
- `report.md` — the same numbers for a person, rendered from the JSON so the two cannot drift.
- `_REVIEW/` — one file per thing that needs a decision, plus an index.

The fifteen blocking checks are `document_count_parity`, `document_list_complete`,
`item_type_fidelity`, `attachment_records_carried`, `originals_accounted_for`, `asn_preserved`,
`asn_carried_to_facet`, `asn_unique`, `tags_carried`, `tag_references_resolvable`,
`tag_assignments_carried`, `custom_fields_defined`, `custom_field_references_resolvable`,
`custom_field_values_carried` and `notes_carried`. Every one of them asserts **equality**; a
blocking check with an inequality is refused by a test. A missing *file* is **not** blocking —
CONCEPT §6 asks for a document whose original cannot be fetched to go to the review queue with a
reason, not for the run to fail — while a missing *record* is.

Two of them are worth stating plainly, because they decide whether a migration can be signed off:

- **`asn_carried_to_facet`** fails when an archive serial number did not reach `item_office.asn`.
  The one allowance is an ASN Paperless itself put on two documents — where the source contradicts
  §6's own premise and no importer can satisfy it. An ASN that lost to an item already in the
  library is **not** an allowance: that conflict is resolvable, and it has to be resolved before
  the physical filing index means anything. `asn_preserved` beside it asserts that no number was
  destroyed on the way, by querying `paperless_asn` rather than by counting review entries.
- **`tag_references_resolvable`** and **`custom_field_references_resolvable`** fail when a document
  names a tag or a field the vocabulary endpoints did not return. That is the case the Phase 2
  review used to produce a green report over a library that lost all four of its tags and all
  nineteen of its custom-field values.

---

## Idempotent and resumable (P9)

Every write is keyed by something Paperless owns: an item by `(source_system, source_id)`, a document
by the SHA-256 of its bytes, a tag by its name, a custom field by its key, a value by its
`(field, item, group, ordinal)` slot, a note by its item and its text. Running the import twice
produces the same library, not a doubled one.

A re-run over an item a person has since put in the trash **completes and reports it**. It is not
written to and it is not restored — emptying or keeping the trash is a decision for a person (P5) —
and the document is excluded from both sides of every count with `documents.trashedInRecueil` and
the `items_not_in_trash` check saying so. Before this, `NoteService.create` refused the trashed item
with a `ConflictError` that left `importPaperless` entirely: a failed job, no report at all, and a
cursor that never moved, so every later attempt failed identically at the same document.
`test/trashed-reimport.test.ts` runs the import four times over two binned items and asserts the
report is clean each time.

A second run also **compares before writing**. `items.version` is the REST ETag, so a re-run that
rewrote every unchanged row would invalidate every client's conditional-write token while changing
nothing; `test/idempotency.test.ts` asserts that a second run leaves every version untouched, and
that a document changed in Paperless bumps that one item's version and no other's.

The `jobs` row carries `{stage, index, lastDocumentId}`, written after every document, under the key
IK1 prescribes: `import.paperless:<server_hash>:<run_label>`. A resumed run:

- **re-reads the whole document list** — the JSON is cheap, and a report built from the tail of a
  resumed run would compare the tail against everything and call the difference a loss;
- **skips the documents at or below the checkpoint**, so the originals — which are the entire cost of
  this import — are not fetched twice. `test/resume.test.ts` counts the requests the server saw to
  prove it;
- **keeps the previous attempt's `job_logs`**, because they are the record of what it is skipping.
  That is what makes the report of a run interrupted twice say the same thing as the report of one
  that was not.

Paperless document ids are monotonic and the walk is `ordering=id`, so a document filed between two
runs sorts after everything the first attempt saw and the resumed run still finds it. Paperless
exposes `id` for `exact` and `in` lookups only (`ID_KWARGS` in `filters.py`), so there is no
server-side keyset cursor to use instead.

### Known limitations of a re-run

A second run brings the target **into line with** Paperless; it does not mirror deletions inside a
document. Concretely:

- a tag removed from a document in Paperless keeps its `item_tags` row;
- a custom-field value cleared in Paperless keeps its `field_values` row;
- a note deleted in Paperless keeps its Recueil note.

This is deliberate. P5 says nothing is deleted without an audited action, and an importer that
removed a person's tag because a row vanished from a REST response would be making that decision on
their behalf — including in the case where the response was short because a token lost a permission.
A document deleted from Paperless entirely is surfaced the same way: `orphanedInRecueil` in the
report, a non-blocking `no_orphaned_items` check, and the item left where it is.

---

## What is not carried, and why

Named in the report as well as here, because a migration report that lists only what moved cannot be
read as evidence that nothing was lost.

| Paperless | Why not |
|---|---|
| `documents.content` | The extracted/OCR text. `documents` has `text_char_count` and `ocr_status` but no column for the text itself in this phase (§3.3). The ingestion pipeline's extract stage regenerates it from the stored original (CONCEPT §5.3) |
| `documents.archived_file_name` | The OCR-ed PDF Paperless generated beside the original. Derived data: ADR-0004 makes the original the identity, and Recueil regenerates its own |
| `documents.owner`, permissions | Recueil is single-user in v1 (CONCEPT §5.15). The schema is ready for multi-user, so this becomes carryable later |
| `tags.parent` | Paperless-ngx 3.0 tags form a tree; Recueil tags are flat (§3.11). Names are unique per owner in Paperless, so flattening cannot collide, but the tree is not carried |
| `storage_paths.path` | A filename template for Paperless's own media directory. Recueil stores by digest, so the template has no meaning here — the storage path *name* is carried on each item |
| `/api/trash/` | Paperless's trash is excluded from `/api/documents/`. This importer reads the live library only; anything in the Paperless trash stays there |
| Saved views, workflows, mail rules | Configuration of Paperless, not the library it holds |

---

## Layout

| Path | What lives there |
|---|---|
| `src/client/types.ts` | The Paperless-ngx wire shapes, in Paperless's own names, with the version they came from |
| `src/client/client.ts` | Token auth, pagination by page number, bounded retries, and the rule about links |
| `src/client/errors.ts` | The errors, and `redactUrl` |
| `src/map/slug.ts` | Names a person typed → slugs a column will accept, diacritics folded |
| `src/map/document-types.ts` | Document type → item type and `office_document_type` |
| `src/map/dates.ts` | The printed calendar day, and the two stored date forms |
| `src/map/money.ts` | Monetary strings → minor units, from digits |
| `src/map/custom-fields.ts` | Data types and values, both directions of the `select` mapping |
| `src/map/office.ts` | The Office facet, and which custom field feeds which column |
| `src/job.ts` | The `jobs` row: the key, the cursor, the checkpoints, the log |
| `src/reconcile.ts` | Rediscovering, **by query**, which Recueil row a Paperless record became |
| `src/import.ts` | The five stages |
| `src/report/` | The report: types, the build (all queries), the Markdown view, the writer |
| `src/testing/` | The fake server and the fixture library, published as `@recueil/import-paperless/testing` |

## Testing

```
pnpm --filter @recueil/import-paperless test
```

142 assertions across seven files, against a real HTTP server on the loopback interface and a real
Recueil library in a temporary directory. **No container is involved and none may be**: this machine
has no Docker, and a test that needs a Paperless-ngx instance is a test that never runs.

The fake is exported so that server-side and CLI tests of a Paperless import can use the same one:

```ts
import { FakePaperlessServer, fixtureLibrary } from '@recueil/import-paperless/testing';

const server = await FakePaperlessServer.start(fixtureLibrary(), { token: 'test-token' });
// ... server.url is `http://127.0.0.1:<port>`; `${server.url}/api/` is the API root.
await server.close();
```

The fixture library is ten documents, and every one of them is there because it makes a decision
awkward: a hostile filename, an ASN Paperless already used, an original that 404s, an original whose
bytes no longer match the checksum Paperless recorded, a monetary value with no currency, a `select`
option id that is not in the field, a document link pointing outside the library, a tag id that is
not in `/api/tags/`, a custom-field type from the future, and two documents that are byte-for-byte
the same file.

---

Licence: AGPL-3.0-or-later.
