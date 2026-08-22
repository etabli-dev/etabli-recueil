# `@recueil/core`

The data model, the migrations, the content-addressed store and the library services.

Everything above this package is a client of it. The REST API, the CLI, the MCP server and the
plugin host all reach the library through the services `createRecueil` returns, and none of them
writes SQL — which is what makes P6 ("nothing is UI-only") enforceable rather than aspirational:
there is one implementation of "create an item", and every surface calls it.

Scope is Phase 1 of [`spec/data-model.md`](../../spec/data-model.md) §11: the library core,
organisation and content, people, and operations. The graph, curated-network and systematic-review
tables arrive with the phases that serve them.

## Layout

| Path | What lives there |
|---|---|
| `src/db/schema.ts` | The Drizzle schema — `spec/data-model.md` expressed in code |
| `src/db/migrations/` | The generated, committed, forward-only SQL series |
| `src/db/migrate.ts` | `migrate()`, idempotent, run on every boot |
| `src/db/client.ts` | `openDatabase()` and the pragmas §1.1 requires |
| `src/storage/` | The content-addressed store of ADR-0004 |
| `src/services/` | One service per entity, plus provenance, search and the trash (below) |
| `src/markdown.ts` | The narrow HTML-to-Markdown conversion invariant N1 needs |
| `src/index.ts` | `createRecueil({ databaseUrl, storagePath })` |

### The services

| Service | Owns |
|---|---|
| `LibraryService` | Items and both facets, the provenance gate on every facet write, listing and filtering |
| `DocumentService` | Ingestion, the content-addressed store, attachments, detach and document trash (AT2, D4) |
| `CollectionService` | The hierarchy, saved searches, membership (C1–C4) |
| `TagService` | Tags, assignments and their provenance, rename and merge (TG1, TG2) |
| `NoteService` | Notes, including the HTML import path (N1) |
| `CustomFieldService` | Field definitions and typed values (CF1, CF2, FV1, FV3) |
| `CreatorService` | Creators, appearances on items, merge (IC1–IC3, CR1, CR2) |
| `ProvenanceService` | Per-field source, confidence and the manual lock (P4) |
| `SearchService` | The FTS5 index and Recueil's own query language (ADR-0011) |
| `TrashService` | The bin across every entity, restore by dispatch, purge (P5, TR2) |
| `AuditService` | The append-only record every service writes to (§6.5) |

## Using it

```ts
import { createRecueil } from '@recueil/core';

const recueil = createRecueil({
  databaseUrl: '/var/lib/recueil/library.sqlite', // or ':memory:', or file:…
  storagePath: '/var/lib/recueil/store',
});

const { item } = recueil.library.createItem(
  { itemType: 'article', bibliographic: { title: 'A paper', doi: '10.1136/bmj.n71' } },
  recueil.actor,
);

await recueil.documents.ingestBuffer(bytes, {
  sourceKind: 'upload',
  originalFilename: 'paper.pdf',
  actor: recueil.actor,
  attachTo: { itemId: item.id },
});

recueil.close();
```

Migrations run on the way in, and the single local account (§1.4) is created if the database is
empty. Both are idempotent, so an empty directory and a five-year-old library are equally valid
starting states.

## The rules this package enforces

- **Content hash is identity** (P2, ADR-0004). `ingestBuffer` hashes, checks
  `ux_documents_sha256`, stores, and records. The same bytes are one `documents` row however often
  they arrive, and the store never rewrites a blob it already holds.
- **Never delete** (P5). `trashItem` sets `trashed_at` and opens a `trash` row in the same
  transaction, because invariant T1 says one without the other is a corrupt library. The cascade to
  attachments, notes and annotations is logical and shares a `group_id`, so a restore puts back
  exactly what was taken.
- **Every mutation is audited** (P5, §6.5). The `audit_log` row is written in the same transaction
  as the write it describes; the database refuses updates and deletes to that table by trigger
  (AL1). The single exception is `item.conflict`, which is written *outside* the transaction it
  describes, because that transaction rolls back by definition.
- **Conflicts are logged, not merged** (P1, §1.7). A conditional write with a stale `version` is
  refused with a `VersionConflictError` and recorded.
- **`items.title` mirrors `item_bibliographic.title`** (I3), so a list view never joins a facet
  table to render a row. The service owns the mirror; trigger syntax is not portable.
- **Manual edits are locked per field and never overwritten** (P4, §3.6, CONCEPT §5.4). Every write
  to a bibliographic or office field goes through `ProvenanceService`, which records where the value
  came from, when and with what confidence. A hand-typed value is locked by the act of typing it
  (P4-1); a resolver's write to a locked field is refused, and the refusal is *returned to the
  caller* as well as audited (P4-2, P4-4), because a bulk enrichment run that overwrites nothing and
  says nothing is a bug. Unlocking is an explicit, audited action (P4-3), and the previous value
  stays on the provenance row even after the field is cleared.
- **The full-text index is derived data, kept in step by the services** (ADR-0011, §9). Every write
  that changes what an item's indexed document is built from re-indexes it inside the same
  transaction, so the index commits or rolls back with the write. `search.rebuild()` reconstructs
  the whole thing from the tables, which is why a bug in a sync call is an inconvenience rather than
  a corruption. Callers pass Recueil's own query syntax, never FTS5's — the interface has to survive
  the Meilisearch backend ADR-0011 also allows.

## The search query language

Recueil's own, not FTS5's. ADR-0011 keeps Meilisearch as an optional backend behind the same
interface and says in as many words that the interface must not expose backend-specific syntax, so
user input is tokenised, parsed into a small tree, and rendered into a `MATCH` expression that is
well-formed by construction. Everything the backend treats as an operator — quotes, `^`, `NEAR`, an
unbalanced bracket — arrives here as data.

| Form | Meaning |
|---|---|
| `machine learning` | both words, anywhere (terms are ANDed) |
| `"machine learning"` | the exact phrase |
| `learn*` | prefix: `learn`, `learning`, `learned` |
| `-draft` | excludes documents containing `draft` |
| `sepsis OR septicaemia` | either |
| `(sepsis OR septicaemia) mortality` | grouping |
| `title:sepsis` | restricted to one field |
| `creator:"van Dijk"` | a phrase, restricted to one field |

Fields: `title`, `creator`, `container`, `id`, `tag`, `note`, `text`. An unknown field name is a
`ValidationError` rather than a silent search for the literal string `foo:bar`. Facet filtering —
item type, collection, tag — is a SQL predicate alongside the `MATCH`, not part of the query string,
and is reached through `library.listItems({ collectionId, tagId, itemType, text })`.

```ts
recueil.search.search('title:sepsis -editorial');
recueil.search.itemIdsMatching('hyperlactataemia'); // note and document hits, rolled up to items
recueil.library.listItems({ text: 'sepsis', collectionId, limit: 25 });
```

`search.available` is `false` where there is no FTS5 index — a Postgres deployment builds its own
from its own migration series (§9). Writes become no-ops and `search()` throws a `ConflictError`
that says so; `listItems({ text })` falls back to a substring match over the title, deliberately
narrower rather than silently pretending to be full-text.

## Regenerating migrations

```
pnpm --filter @recueil/core db:generate
```

Read the diff before committing it. The series is forward-only: a generated migration that drops a
column is a data-loss bug, not a formatting change. `0000_core.sql` also carries a hand-written
tail — the two triggers that make `audit_log` append-only — because drizzle-kit does not manage
triggers, and `0002_search.sql` is hand-written in full because drizzle-kit has no notion of an FTS5
virtual table.

The series so far:

| Migration | What it adds |
|---|---|
| `0000_core` | Everything Phase 1's tables need, plus the append-only triggers on `audit_log` |
| `0001_provenance` | `field_provenance` — per-field source, confidence and the manual lock (§3.6) |
| `0002_search` | The FTS5 index and its rowid map. Hand-written and SQLite-only (§9, ADR-0011) |
| `0003_trash_merge_scope` | Scopes `ck_trash_merge` to item merges, so tag and creator merges can use `reason = 'merge'` |

## Choices worth knowing about

**better-sqlite3, not `node:sqlite`.** The built-in driver needs `--experimental-sqlite` on Node 22
LTS and prints a warning, which is not a thing to ask of someone self-hosting; drizzle-kit and the
drizzle migrator also treat better-sqlite3 as the first-class SQLite driver. The dependency is
confined to `db/client.ts` and `db/migrate.ts`, so swapping it later is a two-file change.

**ULIDs, not UUIDs or nanoids.** `spec/data-model.md` §1.3 requires a 26-character Crockford base32
ULID, so that `ORDER BY id` is creation order and the audit log has a total order for free. Public
ids are eight Crockford characters, deliberately Zotero-key-shaped.

## Where this departs from `spec/data-model.md`

Five departures, each deliberate:

1. **`document_provenance` is a new table.** The spec does not have one, and it needs one. D1 says
   bytes already known never insert a second `documents` row; P4 says every derived fact carries
   its source and timestamp. The second arrival of the same PDF — downloaded last month, mailed by
   a colleague today — is a fact with a different source, and with only the columns on `documents`
   it would either overwrite the first or be dropped. `documents` keeps the provenance of the
   arrival that created it; `document_provenance` keeps every arrival, with `is_first` marking the
   origin and a partial unique index enforcing that there is exactly one. It is also what makes the
   `ingest.file:<sha256>:<source_kind>:<source_ref>` idempotency key of §6.3 IK1 meaningful.

2. **Columns whose foreign-key target belongs to a later phase are not here yet.** `tags.term_id`,
   `custom_fields.plugin_id`, `items.promoted_from_shadow_work_id`, `jobs.plugin_id` and the
   `field_values` review columns all point at tables that arrive in `0003`, `0005` and `0007`
   (§11). They are added by the migration that brings their target. `audit_log.actor_plugin_id` is
   the one exception — the column exists with no foreign key, because AL2 wants an actor column for
   every `actor_type` and `plugin` is one of them.

   Worth flagging for whoever writes those migrations: SQLite cannot add a foreign key to an
   existing table. Each of those columns costs a table rebuild (`create`, `insert … select`,
   `drop`, `rename`) in the SQLite series, which is routine but must be written by hand rather than
   generated.

3. **`item_office`, `annotations` and `annotation_tags` are in `0000_core`.** §11 places them in
   `0002_ingestion` and `0004_reading`. They are here because the Phase 1 brief asks for them, and
   because they cost nothing unused. The migration group is therefore a superset of the spec's
   `0001_core`, not a different shape.

4. **`field_provenance` arrives in Phase 1, not Phase 3.** §11 puts it in `0003_enrichment`. It is
   here because P4 is not an enrichment feature: "manual edits locked per field and never
   overwritten" has to be true of the very first hand-typed value, or the first resolver run to
   arrive in Phase 3 has nothing to respect. The table is exactly as §3.6 specifies it; only its
   migration group has moved. Its `entity_type` vocabulary follows `@recueil/schemas`
   (`item_bibliographic`, `item_office`, `creator`, `item_creator`) rather than §3.6's prose, which
   names two of the four in the plural.

5. **`ck_trash_merge` is scoped to item merges** (`0003_trash_merge_scope`). The spec writes it as
   `reason <> 'merge' OR merge_target_item_id IS NOT NULL` (§6.6), which assumes every merge is an
   item merge. TG2 says a tag merge "is a merge like any other and leaves a reversible record in
   `trash`", and CR1 says a creator merge puts the previous ids in the merge record — neither winner
   is an item, so neither can populate a foreign key to `items`. The check now reads `reason <>
   'merge' OR merge_target_item_id IS NOT NULL OR entity_type <> 'item'`: an item merge must still
   name its winning item, and a tag or creator merge records its winner in `merge_record`.

One inconsistency between the spec and `@recueil/schemas`, resolved in the spec's favour and
asserted by `test/contract.test.ts`: the spec gives `collection_items.source` and `item_tags.source`
different closed vocabularies (§4.2, §4.4), while the contract exposes a single `AssignmentSource`
union covering both. The database keeps the two narrower lists; the test asserts each is a subset of
the contract union rather than equal to it.

## Tests

```
pnpm --filter @recueil/core test
```

Every test runs against a real SQLite file and a real store in a temp directory. The things worth
testing here — a partial unique index, a foreign key, an append-only trigger, an atomic rename —
exist only in the real thing, and a fake would assert that the fake works.
