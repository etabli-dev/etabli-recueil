# `@recueil/web`

The Recueil web client: a keyboard-first three-pane library, an item pane composed of registered
sections, and a PDF.js reader. React 18, TypeScript, Vite, TanStack Query and TanStack Router
(CONCEPT.md §5.14, §5.16). Licence AGPL-3.0-or-later.

This is a client of the REST contract and nothing else. There is no privileged back channel between
the interface and the server: everything on screen came through `/api/v1`, exactly as the CLI, the
MCP server and the R package see it (P6).

## Scope

Phase 1 of the roadmap: **library view, item pane, basic PDF viewing** (CONCEPT.md §7).

Deliberately absent, with the phase that brings each:

| Not here | Phase |
|---|---|
| The PDF annotation layer, and annotations at all | 4 — annotations are records in the W3C Web Annotation model (ADR-0009), which is a data model and an export path, not a highlight button |
| Saved-search editing | 4, with the search backends (ADR-0011). A saved search that already exists is shown and can be selected |
| Graph and bibliometric views | 5 |
| The systematic-review workspace | 7 |
| A markdown renderer for notes | 4. Note bodies are shown as their markdown source, which is lossless and honest |
| Creator editing | 5, with identity resolution. The author list is read-only |

## Running it

```sh
pnpm --filter @recueil/web dev        # http://localhost:5173
pnpm --filter @recueil/web build      # typecheck, then a static bundle in dist/
pnpm --filter @recueil/web test       # the unit suite
pnpm --filter @recueil/web test:e2e   # the browser suite; needs `build` to have run
```

The development server proxies `/api` and `/health` to `http://127.0.0.1:3000` — where `recueil
serve` listens — so the client always uses relative paths and has no origin to configure. Point it
elsewhere with `RECUEIL_SERVER_ORIGIN`. In production the bundle is served by the Fastify app
itself, where the two are same-origin anyway.

## Layout

```
src/
  api/          the typed client, the query hooks, and problem documents
  components/   the pane shell and the loading, empty and error states
  item-pane/    the section registry, the field editor, and the core sections
  keyboard/     the shortcut map, the focus manager, the command palette
  library/      the collection tree, the item list, the three-pane view
  reader/       PDF.js: page navigation, zoom, text selection, text search
  routes/       the route components and their URL state
test/           the unit suite, against a fake at the fetch boundary
e2e/            the browser suite, against a really running server
  harness/      the server, the static origin, the seed and the PDF fixture
```

### The API client

`src/api/client.ts` is the only module in the application that calls `fetch`. Its types come from
`@recueil/schemas` — the same Zod schemas the server validates with and the OpenAPI document is
generated from — imported as **types**, so the contract is enforced at compile time and nothing is
shipped to the browser to enforce it again at run time.

Two constants are restated rather than imported: the API base path and the problem-type table. The
module they live in builds Zod schemas at load time, and importing two strings from it would drag a
quarter of a megabyte of schema machinery into the bundle. `test/contract.test.ts` imports the real
ones and asserts equality, so the copies cannot drift silently.

Errors are RFC 9457 problem documents. Everything that can fail — a 4xx, a proxy's HTML 502, a
dropped connection — becomes an `ApiError` carrying a `ProblemDetails`, so the error state has one
shape to render and always shows the `detail`, the stable `type` URI and the `traceId`.

### The item pane is a registry

CONCEPT.md §5.13 lists item-pane sections as the first UI extension surface. The six core sections —
bibliographic, attachments, tags, collections, notes, custom fields — register through exactly the
call a plugin will use (`itemPaneSections.register`). There is no core-only path, which is the only
way to know the extension point works before anything extends it. Orders leave gaps of ten so a
contributed section can sit between two core ones.

### Provenance and locks

Every bibliographic field shows where its value came from — source, confidence, when it was applied
— and whether it is locked (P4). The wording of the lock is deliberate: `locked` means *no resolver
may overwrite this field*, not *nobody may edit it*. A locked field stays editable, is badged, and
carries the button that releases the lock — a `DELETE` of the lock itself, which answers `204`, so
the pane refetches the item to see the result. Provenance is read-only on the wire and is never
posted back (P4-3).

An edit sends a patch containing **only** the field that changed. A manual write locks every field
it touches (P4-1), so echoing the whole facet back would lock all seventy of its fields against
every resolver as a side effect of correcting a typo.

## Keyboard map

The table in `src/keyboard/shortcuts.ts` is the source of truth: the help overlay (`?`) and the
command palette both render from it, and `test/shortcuts.test.ts` fails if two shortcuts in one
scope claim the same chord. `Mod` is Command on macOS and Control everywhere else.

### Everywhere

| Key | Action |
|---|---|
| `Mod`+`K` | Open the command palette (works while typing) |
| `?` | Show the shortcut list |
| `Esc` | Close the overlay, or leave the field being edited |

### The library

| Key | Action |
|---|---|
| `1` `2` `3` | Focus the collections pane, the item list, the item pane |
| `/` | Focus the search box |
| `J` / `K` | Select the next / previous item |
| `G` / `Shift`+`G` | Select the first / last loaded item |
| `M` | Load the next page of items |
| `Enter` | Open the selected item's first attachment in the reader |
| `R` | Reverse the order: oldest first, or newest first |

### The reader

| Key | Action |
|---|---|
| `N` / `P` | Next / previous page |
| `+` / `-` / `0` | Zoom in, out, back to 100% |
| `F` | Search the document text |
| `Q` | Return to the library |

Shortcuts do not fire while a text field has focus, except the three marked as doing so — otherwise
`j` would move the selection instead of typing a letter.

## The endpoints this client uses

Every path below is one `apps/server` serves, and every parameter one the route's schema accepts.
That is not a matter of tidiness: the list endpoints parse their query with `z.strictObject`, so an
invented parameter is a `422` rather than something the server politely ignores. The browser suite
(`e2e/`) drives the built bundle against a running server, which is what keeps the table true.

| Method and path | Request | Response |
|---|---|---|
| `GET /health` | — | `HealthResponse` |
| `GET /api/v1/items` | `cursor`, `limit`, `order`, `itemType`, `collectionId`, `tagId`, `q`, `includeTrashed` | `ItemSummaryPage` |
| `GET /api/v1/items/{id}` | — | `Item`, fully expanded |
| `PATCH /api/v1/items/{id}` | `ItemUpdate`, `If-Match: "<version>"` | the written `Item` |
| `DELETE /api/v1/items/{id}/locks/{fieldPath}` | `facet` | `204` |
| `GET /api/v1/items/{id}/attachments` | — | `AttachmentPage` |
| `GET /api/v1/items/{id}/field-values` | — | `FieldValuePage` |
| `PUT /api/v1/items/{id}/field-values/{fieldKey}` | `FieldValueWrite` | `FieldValue` |
| `DELETE /api/v1/items/{id}/field-values/{fieldKey}` | `groupKey`, `ordinal` | `204` |
| `GET /api/v1/collections` | — | `CollectionPage`, each row with its item count |
| `GET /api/v1/tags` | `limit` | `TagPage` |
| `GET /api/v1/attachments/{id}` | — | `Attachment` |
| `GET /api/v1/documents/{id}/content` | — | the bytes, for PDF.js |
| `GET /api/v1/notes` | `itemId` | `NotePage` |
| `GET /api/v1/fields` | `scope=library` | `CustomFieldPage` |

Four of those differ from what this package was first written against, because it was written
against the schemas while the REST surface was still being built. The differences are worth stating,
because each is a decision on the server's side rather than an accident:

- **There is no sort field.** `GET /api/v1/items` is ordered by `(dateModified, id)` and takes
  `order` alone. The pair is what makes the ordering total, and a cursor over a non-total order
  silently skips or repeats rows. So the list toolbar offers a direction and nothing else, `?sort=`
  is gone from the URL, and the `S` shortcut with it — a control for a capability the API does not
  have is a control that lies.
- **The full-text filter is `q`, not `text`.** It is a *filter*, folded into the SQL so that it
  composes with `collectionId` and `tagId` and stays pageable. `GET /api/v1/search` is the ranked
  search, which is a different operation and not one a paged list can offer.
- **A lock is deleted, not un-posted.** `DELETE /items/{id}/locks/{fieldPath}` releases one lock and
  answers `204`, so the pane refetches the item to see the result. Provenance stays read-only on the
  wire (P4-3).
- **The bytes hang off the document.** The same PDF reachable from two items is stored once and
  served once (AT1, ADR-0004), so the content endpoint is `/documents/{id}/content` and an
  attachment names the document it points at. A `linked_url` attachment names none, and the reader
  says so rather than fetching nothing.

Conventions that hold across all of them: cursor pagination with `{ data, page }` and
`page.nextCursor === null` as the end condition; `application/problem+json` on every error; the item
version as a quoted `If-Match` for conditional writes; and session cookies
(`credentials: same-origin`) for the browser, with a bearer token available for other callers.

## Tests

Two suites, and they answer different questions.

**`test/` — unit, with Vitest and Testing Library**, against a hand-written fake at the `fetch`
boundary (`test/fake-server.ts`) rather than a stubbed client: half of what the client does *is*
building the request, and a fake that replaced it would test none of that. Fixtures are typed as the
schema types they stand for, so a contract change breaks them at compile time. This suite says the
client builds the request it means to.

**`e2e/` — the browser, with Playwright**, against a really running server. Each run starts
`apps/server`'s built entry point on an ephemeral port over a temporary SQLite database, seeds a
library *through the API* — a collection, three items with creators and tags, a note, an uploaded
two-page PDF attached to one of them — serves `dist/` and proxies `/api` and `/health` to the server
on one origin, and then drives Chromium through it. It asserts that the list shows the seeded items,
that selecting one fills the item pane, that an edited bibliographic field is still there after a
reload *and in the API*, that the collection narrows the list, that a search on a word which appears
only in a note finds the item the note hangs off, and that the reader opens the attachment and draws
page one — text layer and ink on the canvas both.

This suite says the request is one the server answers, which is the only question a fake cannot be
asked. Nothing in it touches SQLite directly: the seed is a sequence of requests a CLI could make
(P6).

```sh
pnpm --filter @recueil/web build       # e2e drives the production bundle, so build it first
npx playwright install chromium        # once per machine
pnpm --filter @recueil/web test:e2e
```

`test:e2e` is deliberately not part of `pnpm test`: it needs a browser binary and a built bundle,
and a suite that fails for the want of either on a fresh checkout teaches people to ignore it.

**Rebuild before every e2e run.** The harness serves `dist/`, so an edit to `src/` that has not been
rebuilt is invisible to the suite — it would report on the previous build, which is worse than
failing, because a fix under test appears not to work. The harness therefore compares the newest
mtime under `src/` against the bundle's and refuses to start when the bundle is older, naming the
command that fixes it.
