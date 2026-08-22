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
| `src/services/` | `LibraryService`, `DocumentService`, `AuditService`, the actor and the cursor |
| `src/index.ts` | `createRecueil({ databaseUrl, storagePath })` |

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

## Regenerating migrations

```
pnpm --filter @recueil/core db:generate
```

Read the diff before committing it. The series is forward-only: a generated migration that drops a
column is a data-loss bug, not a formatting change. `0000_core.sql` also carries a hand-written
tail — the two triggers that make `audit_log` append-only — because drizzle-kit does not manage
triggers.

## Choices worth knowing about

**better-sqlite3, not `node:sqlite`.** The built-in driver needs `--experimental-sqlite` on Node 22
LTS and prints a warning, which is not a thing to ask of someone self-hosting; drizzle-kit and the
drizzle migrator also treat better-sqlite3 as the first-class SQLite driver. The dependency is
confined to `db/client.ts` and `db/migrate.ts`, so swapping it later is a two-file change.

**ULIDs, not UUIDs or nanoids.** `spec/data-model.md` §1.3 requires a 26-character Crockford base32
ULID, so that `ORDER BY id` is creation order and the audit log has a total order for free. Public
ids are eight Crockford characters, deliberately Zotero-key-shaped.

## Where this departs from `spec/data-model.md`

Three departures, each deliberate:

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
