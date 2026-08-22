# Contributing to Recueil

Thank you for looking. Please read the next section before you write any code — it will save you
time.

## Status: honest expectations first

Recueil is written by one person to replace a stack they use daily. ADR-0014 sets when that changes:
the repository is public and AGPL from the first commit, but the project is developed as a tool for
its author through **M3** (end of Phase 3), and opens properly at **M4** (end of Phase 5). Until
then:

- there is no support commitment and no roadmap promise
- issues and pull requests may sit for a long time, or be closed with a short reason
- the plugin API may break between minor versions, and the data model may change under a migration
- a large unsolicited pull request is likely to be declined, however good it is, because reviewing
  and then maintaining it costs more than the feature is worth at this stage

This file exists early anyway, so that the shape of contributing is knowable rather than guessed at,
and so the conventions are in force from the first commit. None of the above is meant to keep you
out. Bug reports, reproductions, corrections to the spec and small focused patches are genuinely
welcome now. If you are considering something larger, open an issue or a discussion first and ask
whether it fits — a five-minute answer is better than a week of your work being declined.

Everyone taking part is covered by the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems do
not go through the issue tracker; see [SECURITY.md](SECURITY.md).

## Repository layout

One pnpm workspace, one language (ADR-0002). Full rationale in CONCEPT.md §8.

| Path | Contents |
|---|---|
| `apps/server/` | Fastify app, job runner, plugin host |
| `apps/web/` | React SPA |
| `apps/desktop/` | Tauri 2 shell, server as a sidecar |
| `apps/mobile/` | Tauri 2 mobile / Capacitor |
| `apps/connector/` | WebExtension (Phase 8) |
| `apps/cli/` | `recueil` command line |
| `apps/mcp/` | MCP server over the API |
| `packages/core/` | data model, migrations, services |
| `packages/schemas/` | Zod schemas → OpenAPI, shared types |
| `packages/plugin-sdk/` | `@recueil/plugin-sdk` |
| `packages/client-ts/` | generated TypeScript client |
| `plugins/` | first-party plugins |
| `spec/` | OpenAPI, plugin manifest schema, hook catalogue, data model, ERD, ADRs |
| `docs/` | Quarto documentation site |
| `deploy/` | docker-compose with sidecar profiles |
| `fixtures/` | test libraries (Zotero, Paperless, BibTeX, RIS) |

The R and Python clients live in separate repositories (`recueil-r`, `recueil-py`), as does the
plugin registry index.

## Prerequisites

| Tool | Version | Note |
|---|---|---|
| Node.js | 22 LTS or newer | 22 is what CI targets and what the Docker image runs; newer versions should work but are not the reference |
| pnpm | 9.x | `corepack enable && corepack prepare pnpm@9 --activate`, or install it however you prefer |
| Git | any recent version | commits must be signed off, see below |
| Docker | optional | only needed for the sidecar profiles in `deploy/` (GROBID, OCRmyPDF, Meilisearch, translation-server) and for building the image |

No database server is needed: v1 is SQLite only (ADR-0015), and the file is created on first run.

## Install, build, test, run

```sh
pnpm install          # install the workspace
pnpm build            # build every package and app
pnpm test             # unit and integration tests (Vitest)
pnpm lint             # lint and format check
pnpm dev              # server and web UI in watch mode
```

Scoped to one workspace member:

```sh
pnpm --filter @recueil/server test
pnpm --filter @recueil/server dev
```

**Phase 0 caveat, true as of this commit:** the repository is the specification plus a scaffold.
There are no scripts in the root `package.json` yet and nothing runs — `pnpm install` succeeds and
that is all. The commands above are the contract those scripts will implement in Phase 1; if you
find they do not exist, the code has not landed yet rather than your setup being wrong. Phase 0's
exit criterion is `recueil serve` answering a health check on an empty library (CONCEPT.md §7).

## Where the specification lives

Recueil is specified before it is written, and the specification is part of the repository rather
than a wiki:

| File | What it settles |
|---|---|
| [`CONCEPT.md`](CONCEPT.md) | the whole thing: goals, non-goals, principles, architecture, roadmap. Start here |
| [`spec/data-model.md`](spec/data-model.md), [`spec/erd.mmd`](spec/erd.mmd) | entities, fields, relations |
| `spec/openapi.yaml` | the API contract (P6: nothing is UI-only) |
| [`spec/hooks.md`](spec/hooks.md) | the v1 hook catalogue and its guarantees |
| [`spec/plugin-manifest.schema.json`](spec/plugin-manifest.schema.json) | `recueil.plugin.json`, validated at install and at every activation |
| [`spec/adr/`](spec/adr/) | every architectural decision, numbered and dated |
| `docs/` | the Quarto site: user and operator documentation |

If a change contradicts something in `spec/`, the change is wrong or the spec needs an ADR. Say
which in the pull request.

## Architecture decision records

ADRs are how the project keeps its reasoning readable in order. The full process is in
[`spec/adr/README.md`](spec/adr/README.md); the short version:

**When a change needs one.** Write an ADR if the change:

- adds, replaces or removes a dependency that would be painful to swap later (a database, a queue, a
  search engine, a UI framework)
- changes a public contract: the REST API's shape, the plugin API, the manifest schema, the storage
  layout, an export format
- changes a stored data format or requires a migration that cannot be reversed
- trades away one of the binding principles in CONCEPT.md §3, or narrows a goal in §2
- resolves an open question already listed in CONCEPT.md §10

You do not need one for a bug fix, a refactor with no external effect, a new first-party plugin that
only uses catalogued hooks, or documentation.

**Numbering and filenames.** Take the next free number, four digits, and name the file
`NNNN-kebab-case-title.md`. Numbers are never reused, even if an ADR is withdrawn.

**Shape.** Copy any existing record: a title line, then status, date and phase, then **Context**,
**Decision** and **Consequences**. The consequences section must state what the decision costs, not
only what it buys.

**Statuses.** `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, `Deprecated`.

**Immutability.** An accepted ADR is never edited. It is superseded by a later one and both stay in
the repository. Setting an earlier record's status to `Superseded by ADR-NNNN` is the only edit ever
made to an accepted ADR. Add a row to the index table in `spec/adr/README.md` for every new record.

Propose an ADR as a pull request containing just the ADR, with status `Proposed`. That way the
discussion happens on the decision rather than on the diff that implements it.

## Commits

- **Subject:** imperative mood, under 72 characters, capitalised, no trailing full stop. "Add ISBN
  resolver", not "Added ISBN resolver" or "adds isbn resolver".
- **Body:** wrapped at 72 characters, separated from the subject by a blank line. The body explains
  **why**, not what — the diff already says what. Note alternatives rejected and consequences the
  reviewer would otherwise have to reconstruct.
- **Scope:** one logical change per commit. Move-only and rename-only changes go in their own commit
  so the substantive diff stays readable.
- **References:** put `Refs #123`, `Closes #123` or `Implements ADR-0016` in the body, not the
  subject.
- **Prose:** British English, matching CONCEPT.md and the ADRs. This applies to comments,
  documentation and user-visible strings. (Code identifiers follow their ecosystem: npm's
  `package.json` keeps `license`, while the plugin manifest's own key is `licence`.)

**No AI attribution, anywhere.** No `Co-Authored-By` trailer for a tool, no "Generated with", no
assistant signature in a commit message, a comment, a file header or a pull request description.
Tools are tools; the person who submits the change is its author and is accountable for it. This is
a hard rule and pull requests carrying such lines will be asked to rewrite the history.

## Developer Certificate of Origin

Recueil uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) rather
than a contributor licence agreement. There is nothing to sign and no copyright is assigned: you
keep yours, and your contribution is licensed under AGPL-3.0-or-later like the rest of the
repository.

Certify each commit by signing it off:

```sh
git commit -s -m "Add ISBN resolver"
```

which appends

```
Signed-off-by: Jane Hacker <jane@example.org>
```

using your real name (a pseudonym you are known by is acceptable; an anonymous handle is not) and an
address that reaches you. By adding that line you state that you have the right to submit the work
under the project's licence, as set out in the DCO text.

To sign off a series of commits you have already made: `git rebase --signoff <base>`, then
force-push your branch.

## Pull requests

1. Open an issue first for anything that is not small and obvious, and wait for a reply before
   building it.
2. Branch from `main`. One topic per pull request.
3. Fill in the template: what and why, the linked issue, the roadmap phase, and the checklist.
4. Keep the diff focused. Unrelated formatting churn makes review slower and is usually the reason a
   patch stalls.
5. Tests come with the change: a regression test for a bug fix, coverage for new behaviour. Anything
   touching a public contract updates `spec/` in the same pull request.
6. Documentation comes with the change too, when there is user-visible behaviour to describe.
7. Expect review comments on British English, on ADR compliance, and on whether the change belongs
   to the phase it claims.

## Proposing a plugin

Most extensions should not be plugins at all. In order of preference (CONCEPT.md §5.13):

1. **A script against the API or MCP.** Everything the UI can do, the API can do (P6). A script
   needs no review, no release and no compatibility window, and it cannot break the server. Try this
   first.
2. **A server plugin** — an npm package with a `recueil.plugin.json` manifest, implementing hooks
   from [`spec/hooks.md`](spec/hooks.md). Use one when you need to take part in a decision the
   server is in the middle of making: a resolver, a check, a dedup rule, an ingest source or stage,
   a storage backend, an importer or exporter, a graph edge provider, an analytics export, an SR
   template.
3. **A UI plugin** for item-pane sections, sidebar panels, context actions, network renderers or
   screening panels.
4. **A translator**, which is Zotero's format and belongs upstream in Zotero's translator repository
   (ADR-0006).

If it is a plugin, then:

- Read [`spec/hooks.md`](spec/hooks.md) first. If what you need is not a hook in the v1 catalogue,
  the proposal is really a request for a new hook — open an issue describing the workflow you want
  to take part in, not the API you would like to call. New hooks are contract changes and need an
  ADR.
- Validate your manifest against
  [`spec/plugin-manifest.schema.json`](spec/plugin-manifest.schema.json), and declare permissions
  honestly. They are recorded and shown to the operator at install time even though v1 does not
  enforce them by isolation (ADR-0012, ADR-0018).
- Import `@recueil/plugin-sdk` and nothing else from the project. No Drizzle, no service classes, no
  database handle, no direct access to the content store. This is what keeps a future move to a
  sandboxed host a change of host rather than a rewrite of every plugin (ADR-0018), and an import
  lint in the compatibility suite enforces it.
- A plugin that links the server in-process is a derivative work of an AGPL-3.0-or-later program.
  `AGPL-3.0-or-later` is the expected licence for a plugin's own source.
- Name it `recueil-plugin-<something>` on npm so it is findable. The `@recueil/` scope is reserved
  for first-party plugins in this repository.
- **Where it lives:** community plugins live in their author's own repository, at their own release
  pace. The registry that indexes them is Phase 9 work; until it exists, link your plugin from a
  discussion thread. A plugin only moves into `plugins/` in this monorepo if it is first-party —
  that is, if the maintainer is taking on maintaining it forever.
- A plugin that duplicates a first-party one is fine. Competition between a plugin and the built-in
  behaviour is a sign the hook is doing its job.
