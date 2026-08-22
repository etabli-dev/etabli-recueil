# `@recueil/schemas`

The shared contract: every Zod schema in Recueil, and the OpenAPI 3.1 document generated from
them.

Nothing else in the monorepo declares its own request or response types. The server validates with
these schemas, `spec/openapi.yaml` is generated from them, and the TypeScript client, the MCP tool
definitions and the Python models are generated from that document. That is what makes P6 — "the
OpenAPI spec is the contract" — true rather than aspirational: the document and the implementation
are the same source, so they cannot drift.

## Layout

| Path | What lives there |
|---|---|
| `src/primitives.ts` | ULIDs, public ids, SHA-256, timestamps, EDTF dates, colours, JSON, check digits |
| `src/vocabularies.ts` | Closed enums and the open, plugin-extensible vocabularies |
| `src/provenance.ts` | Per-field source, confidence and the manual lock (P4) |
| `src/entities/` | Document, Item and its two facets, Attachment, Collection, Tag, CustomField/FieldValue, Note, Annotation, Creator |
| `src/envelopes/` | Cursor pagination, RFC 9457 problem documents, bulk operations with idempotency keys, the health response |
| `src/openapi/` | The component registry, the path items and the document builder |
| `src/bin/write-openapi.ts` | Writes this package's document to a named file (not the committed contract — see below) |

## Scripts

```sh
pnpm --filter @recueil/schemas run build      # tsc → dist/, with declarations
pnpm --filter @recueil/schemas run typecheck  # tsc --noEmit, sources and tests
pnpm --filter @recueil/schemas run test       # vitest
pnpm --filter @recueil/schemas run openapi -- /tmp/schemas.yaml   # this package's document alone
```

**The committed contract is written elsewhere.** `spec/openapi.yaml` is produced by
`pnpm --filter @recueil/server run openapi`, because only the server knows which operations it
answers: that writer builds the document below and merges the path items declared beside the
handlers in `apps/server/src/routes` over it. This package's writer therefore takes a mandatory
destination, so that running it cannot quietly replace the contract with one that has no routes.

`spec/openapi.yaml` is a generated file and must never be hand-edited. `apps/server` asserts that
the committed copy is byte-for-byte what the server renders, and a test here asserts that every
component in it is the component these schemas generate, so an edit fails the build rather than
quietly surviving.

## Conventions

**Naming.** The database is `lower_snake_case` (`spec/data-model.md` §1.2); this contract is
`camelCase`. The mapping is mechanical and belongs to `packages/core`. Nothing here encodes a
column name.

**Read, Create, Update.** Where the three differ, there are three schemas. `Create` omits
everything the server issues — ids, public ids, timestamps, version counters, denormalised counts —
and `Update` is `Create` made partial, less the fields that are immutable by design: a custom
field's `dataType` (CF1), an attachment's `itemId`, an annotation's target document.

**Strict objects.** Every object rejects properties it does not know. A silently ignored field in a
write is exactly the kind of guessing P3 forbids, and it is also what makes a typo in a client an
error rather than a missing value. It has a second, incidental benefit: input and output render
identically, so the generated document has one component per schema rather than two.

**Nullable columns are `nullish` on the wire.** A server may omit the field or send `null`, and
both mean "no value".

**Open versus closed vocabularies.** `spec/data-model.md` §1.1 draws the line and this package
keeps it. A closed vocabulary is a `CHECK` constraint in the database and a `z.enum` here. An open
one — item types, office document types, provenance sources — carries no database constraint,
because the plugin host contributes to it at runtime, so it is validated as a slug and the built-in
members are exported separately (`CORE_ITEM_TYPES`, `isCoreItemType`).

**Invariants travel with the schema.** Where the data model states a `CHECK` constraint that a
client could violate, the schema reproduces it as a refinement and names the constraint in the
message: `ck_attachments_link_mode`, `ck_item_office_amount`, `ck_field_values_one_value`. The
error a client gets and the constraint the database enforces are then the same rule, described the
same way.

**British English**, matching `CONCEPT.md`. The one deliberate exception is an external
identifier's own spelling: our field is `licence`, the CSL-JSON key it maps to is `license`.

## Scope

Phase 1's core of the data model, plus the envelopes every endpoint shares. The graph, analytics,
systematic-review, job and audit entities are specified in `spec/data-model.md` and arrive with the
phases that serve them; `src/openapi/paths.ts` carries the marked extension point where their
routes will be registered.

## Provenance of the design

- `CONCEPT.md` §5.2 (entities), §5.12 (API surface), §5.15 (`/health`)
- `spec/data-model.md` §1 (conventions), §3–§4 (the tables these schemas mirror)
- ADR-0004 (content-hash identity), ADR-0009 (annotations as W3C Web Annotation records),
  ADR-0016 (citation keys)
- `docs/api.qmd` (cursor pagination, RFC 9457 errors, idempotent bulk endpoints)
