# Plugin API

| | |
|---|---|
| Status | Draft v0.1 |
| Date | 2026-08-22 |
| Phase | Phase 0 deliverable (P8: plugin contract before UI) |
| Covers | CONCEPT.md §5.13 |
| Companions | [`plugin-manifest.schema.json`](plugin-manifest.schema.json) · [`hooks.md`](hooks.md) · [ADR-0012](adr/0012-in-process-trusted-plugin-host-in-v1.md) · [ADR-0018](adr/0018-sandboxing-tier-in-process-until-multi-user.md) |

The hook catalogue says what a plugin can implement. This document says how the contract is versioned,
how plugins are loaded and activated, how their settings are stored and surfaced, and what a plugin
is expected to prove about itself in its own CI before anyone installs it.

---

## 1. What "the plugin API" means

The plugin API is exactly four things, and nothing else is covered by the compatibility promise:

1. The **manifest schema**, [`plugin-manifest.schema.json`](plugin-manifest.schema.json).
2. The **hook catalogue** and its TypeScript interfaces, [`hooks.md`](hooks.md).
3. The **lifecycle event** types and payload shapes, [`hooks.md`](hooks.md) §7.
4. The **`@recueil/plugin-sdk` public surface**: the context objects, the capability namespaces, the
   error hierarchy, the byte-handle protocol, and the exported types.

Explicitly **not** part of the plugin API, and free to change in any release:

- the REST API and the OpenAPI document (versioned separately as `/api/v1`);
- the database schema, migrations, table and column names;
- anything in `packages/core` or `apps/server`, including service classes;
- the on-disk layout of anything except the content-addressed store, whose layout is fixed by
  ADR-0004 and P10 rather than by this contract;
- the web UI's internal component library. A UI contribution receives a documented props object and
  a small render context; it does not receive the host's components.

A plugin that reaches past this list has no compatibility promise, and the import lint in the
compatibility test suite (§5) exists to catch it before a release does.

---

## 2. Versioning

### 2.1 Three versions, deliberately separate

| Version | Example | Owned by | Meaning |
|---|---|---|---|
| Application version | Recueil `0.7.2`, later `1.0.0` | The release | What the operator runs. Follows the roadmap phases. |
| Plugin API version | `1.4.0` | This contract | The version of the four things in §1. |
| Plugin version | `@recueil/resolver-openalex@1.2.0` | The plugin author | The plugin's own releases. |

The plugin API is versioned **independently of the application**. An application release may ship
without changing the plugin API at all, which is the usual case, and the plugin API may gain a minor
version in a patch release of the application. A plugin therefore declares `recueilApi`, a semver
range over the *plugin API* version, and never an application-version constraint.

Discovery:

- `GET /api/v1/system` reports `pluginApi: { version, supportedRange, deprecations: [...] }`.
- `recueil plugins info` prints the same.
- `@recueil/plugin-sdk` exports `PLUGIN_API_VERSION` as a compile-time constant, and the SDK package
  version tracks the plugin API version exactly — SDK `1.4.0` implements plugin API `1.4.0`. That is
  the one place where two version numbers are deliberately locked together, because a plugin author
  should never have to work out which SDK gives them which API.

### 2.2 What each bump means

**Patch** (`1.4.0 → 1.4.1`). Clarifications, better types with identical runtime behaviour, bug fixes
in the host that make it match this specification. No plugin action.

**Minor** (`1.4.0 → 1.5.0`). Additive only: new hooks, new optional methods on existing interfaces,
new permissions, new lifecycle events, new manifest properties, new capability namespaces. Existing
plugins keep working without a rebuild. A minor may **deprecate** a surface; it may not remove one.

**Major** (`1.x → 2.0.0`). Removals and changes in meaning. A plugin declaring `^1.0.0` is not loaded
by a host running plugin API 2, and is reported as incompatible in the plugin list with the range it
asked for and the version on offer.

Adding a value to an existing enumeration — a new permission, a new item type, a new edge type — is a
minor for the host and a potential break for a plugin that exhaustively switches over it. Plugins
should treat every host enumeration as open and have a default branch. The SDK's types mark these
with `| (string & {})` so that exhaustiveness checking does not give a false sense of safety.

### 2.3 Deprecation: a two-minor-version window

Nothing in the plugin API is removed without notice. When a surface is deprecated:

1. It is marked `@deprecated` in the SDK typings, with the replacement named in the tag, so the
   plugin author sees it in their editor the moment they upgrade the SDK.
2. It is listed in `GET /api/v1/system` under `pluginApi.deprecations` with the version that
   deprecated it, the replacement, and the earliest version it may be removed in.
3. The host logs a warning once per plugin per boot when the surface is used, naming the plugin and
   the hook, and the plugin list shows a "uses deprecated API" badge with the same detail.
4. `recueil plugins doctor` lists every deprecated surface in use across all installed plugins, which
   is the command the operator runs before a major upgrade.

**The window is two minor releases of the plugin API.** A surface deprecated in `1.4.0` keeps working
through `1.5.x` and `1.6.x` at minimum. Removal then happens at the next **major**, never in a minor:
the window is a floor on notice, not a licence to break a minor. In practice that means a deprecation
landing late in the `1.x` line simply survives until `2.0.0`.

Phase 9 exit freezes plugin API v1 (CONCEPT.md §7). After the freeze, `1.x` receives additive minors
and patches only, and anything deprecated waits for `2.0.0`.

**Support window for majors.** When `2.0.0` ships, the host keeps a `1.x` compatibility shim for two
application minor releases, so a plugin author has a real window rather than a flag day. During the
shim period a `^1` plugin loads with a warning; after it, it is reported as incompatible.

### 2.4 Compatibility checks in practice

`recueilApi` is checked twice: at install, where a mismatch is a refusal with an explanation, and at
every activation, where a mismatch — the operator upgraded Recueil since installing — leaves the
plugin installed but inactive, with the reason on the plugin row and a notice in the UI. The plugin is
never silently skipped, and an incompatible plugin never blocks the server from starting.

The range is validated with `semver.validRange` and evaluated with `semver.satisfies` against the
running plugin API version. Pre-release plugin API versions (`2.0.0-rc.1`) satisfy a range only when
the range names a pre-release explicitly, which is node-semver's default and the behaviour we want:
release candidates should not silently capture `^1` plugins.

---

## 3. Loading and activation

### 3.1 The trust statement, in plain words

**Installing a plugin gives it the rights of the Recueil server process.** Plugins load in-process
and are trusted (ADR-0012). They can read and write the database directly, read the content store,
open sockets, read environment variables and spawn processes, regardless of what their manifest
declares. The `permissions` field is recorded, shown to the operator at install time, and checked
against actual capability use by the compatibility test suite — it is a contract, not a sandbox.

This stays true through 1.0, including after the plugin registry ships in Phase 9 (ADR-0018). It is
stated on the registry page and in the install flow, not buried here, and it is a legitimate reason
for a cautious operator to install nothing they have not read.

What makes this survivable is discipline rather than isolation: plugins only import
`@recueil/plugin-sdk`, all host services arrive through a capability object rather than a global, and
every value crossing the boundary is structured-cloneable. Given those three, swapping the in-process
host for one `worker_threads` worker per plugin is a change of host, not of contract.

### 3.2 Where plugins come from

| Source | `plugins.source` | Available | Notes |
|---|---|---|---|
| Built-in | `builtin` | Phase 3 | The first-party plugins in `plugins/`, shipped in the image, enabled by configuration. |
| npm dependency | `npm` | Phase 3 | Added to the deployment's dependency set and discovered by manifest presence. |
| Local directory | `local` | Phase 3 | A path in `RECUEIL_PLUGIN_PATH`. The development and self-authoring route. |
| URL install | `url` | Phase 9 | A tarball URL from the registry index or anywhere else. Requires an explicit operator action. |

Discovery in all four cases is the same: find `recueil.plugin.json` at the package root. There is no
side-loading by convention and no auto-discovery of anything not on one of these four paths.

### 3.3 Install

Install is a deliberate operator action. It never happens automatically, and there is no auto-update
in v1 — that is one of ADR-0018's sandboxing triggers, so it stays off until the sandbox exists.

1. Fetch or resolve the package; compute and record its content hash.
2. Read `recueil.plugin.json`; validate against the manifest schema. Failure stops here with the
   validation errors shown verbatim.
3. Validate `recueilApi` against the running plugin API version.
4. Validate the `settings` schema against the draft 2020-12 metaschema.
5. Check for id collisions: plugin `name`, hook ids, `storageBackend` schemes, `analyticsExport`
   table names, and check ids against everything already installed. A collision is a refusal.
6. Present the install dialogue: name, version, author, licence, repository, the permission list with
   each `permissionNotes` entry beside it, and the trust statement from §3.1.
7. On confirmation, write the `plugins` row: `install_state = 'installed'`, `enabled = false`, the
   verbatim manifest, the declared permissions, the denormalised hook list the dispatch table is built
   from, `plugin_api_range`, the artefact `checksum`, the `source` and `source_ref`, settings
   initialised to the schema defaults, and an audit-log entry naming the operator.

Enabling is separate from installing, so that a plugin with required settings can be configured
before it ever runs.

### 3.4 Install state and enablement

These are two separate things in the data model and they should stay separate in your head.
`plugins.install_state` says whether the artefact is usable; `plugins.enabled` says whether the
operator wants it to run.

| `install_state` | Meaning | Set by |
|---|---|---|
| `installed` | The artefact is present and its manifest validated. | Install, and every successful activation. |
| `pending_update` | A newer version is staged but not yet swapped in, because a job created by the plugin is still running (§3.9). | Upgrade. |
| `failed` | The module would not import, or `activate` threw or overran. `last_error` holds why. | The host. |
| `incompatible` | `recueilApi` does not admit the running plugin API version. | The host, at boot and at upgrade. |

`enabled` is a boolean, default false: a plugin is installed and then enabled, never enabled by being
installed. The two combine into the three states the plugin list actually shows —

- **active**: `install_state = 'installed'`, `enabled = true`, hooks registered;
- **needs configuration**: enabled, but a `required` setting has no value. Not an error, does not log
  on every boot, and the plugin's hooks are simply not registered until it is resolved;
- **inactive**: everything else, with the reason shown — disabled by the operator, `failed` with the
  error, or `incompatible` with the range it asked for and the version on offer.

### 3.5 Boot sequence

```
1  read configuration and secrets
2  open the database, run migrations
3  discover plugins, validate manifests, resolve compatibility
4  activate plugins in load order        ← hooks register here
5  build the hook registries and freeze them
6  start the job runner
7  start the HTTP listener
```

Hooks are registered before anything can be requested, so there is no window in which a request sees a
half-populated registry. The registries are frozen after step 5: a plugin cannot register a hook later,
and cannot register one that is not in its manifest. The manifest is the authority; `activate` is where
the plugin gets ready, not where it declares itself.

**Load order** is: built-in plugins first, then everything else, each group sorted by plugin `name`.
Within a plugin, hooks are registered in manifest order. Ordering *between* plugins for a given hook
type is decided by the hook's `priority`, not by load order (see [`hooks.md`](hooks.md)). Load order
exists only so that activation is deterministic across restarts. There is no plugin dependency graph
in v1: a plugin that needs another plugin's data reads it through the API like anything else.

### 3.6 The plugin object

```ts
import type {
  RecueilPlugin, PluginContext, HookContext, Resolver,
  EventEnvelope, ItemCreatedPayload,
} from '@recueil/plugin-sdk';

const plugin: RecueilPlugin = {
  async activate(ctx: PluginContext) {
    // Read settings, open clients lazily, subscribe to setting changes.
    // Must return within the activation budget (10 s by default).
    // Must not: block on the network, run migrations, do bulk work.
  },
  async deactivate() {
    // Release everything: timers, sockets, watchers, byte handles.
    // ctx.signal is already aborted by the time this is called.
  },
};

export default plugin;

// Hook implementations are named exports, matched to `hooks[].export` in the manifest.
export const openAlexResolver: Resolver = { /* ... */ } as Resolver;

// Event handlers are named exports too, matched to `events[].export`.
export async function onItemCreated(
  envelope: EventEnvelope<ItemCreatedPayload>,
  ctx: HookContext,
): Promise<void> { /* ... */ }
```

`activate` is optional. A plugin that only exports hooks and needs no setup can omit it entirely, and
many should.

### 3.7 The capability object

`ctx` is constructed per plugin from its declared permissions. A namespace whose permissions are not
declared is absent from the object; a method within a partially-permitted namespace rejects with
`PermissionDeniedError`. That is ADR-0018's condition 4 wired up early: when isolation arrives, the
same rejection becomes an enforcement point rather than a contract check, and no plugin source
changes.

Everything the host offers arrives this way. There is no `import { db } from ...`, no ambient
singleton, no `process`-level registry. Tests substitute a fake `ctx` and that is the whole test
harness — which is also why the compatibility suite can instrument every call a plugin makes.

### 3.8 Failure isolation

A plugin failure never stops the server. Concretely:

| Failure | Consequence |
|---|---|
| Manifest invalid | Not installed; errors shown. Already-installed copy keeps running. |
| `recueilApi` mismatch | `incompatible`; not activated; server starts. |
| Module fails to import | `failed`; not activated; stack trace in the plugin row and the log; server starts. |
| `activate` throws | `failed`; hooks not registered; server starts. |
| `activate` exceeds its budget | `failed`; the promise is abandoned but, being in-process, cannot be killed — this is logged plainly. |
| Hook throws | Per the hook's error contract in [`hooks.md`](hooks.md). |
| Three consecutive hook timeouts in one run | Hook disabled for the remainder of the run; operator notified. |
| Event handler throws | Retried, then dead-lettered; visible in the plugin list. |
| Plugin crashes the process | Nothing protects against this in v1. It is the honest cost of ADR-0012 and it is why `activate` should do as little as possible. |

The corollary the docs must not soften: because the host is in-process, a plugin that blocks the event
loop stalls the whole server, and a plugin that leaks memory leaks the server's memory. CPU-bound work
belongs in a job, and genuinely heavy computation belongs in a `worker_threads` worker the plugin
creates and owns.

### 3.9 Enable, disable, upgrade, uninstall

**Enable** activates the plugin immediately without a restart, provided no `x-recueil-restart` setting
has changed. **Disable** calls `deactivate`, aborts `ctx.signal`, drops the hooks from the registries
and cancels the plugin's queued jobs; data the plugin wrote stays, because Recueil never deletes (P5).

**Upgrade** is deactivate, replace, validate, activate. It is not performed while a job created by the
plugin is running, because a job must not resume into a different code version mid-flight: the new
artefact is staged, the row goes to `pending_update`, and the swap happens when the last such job
finishes or the operator cancels it. If the new
version's `settings` schema no longer validates the stored settings, the plugin lands in
`needs_configuration` with a diff of what no longer fits; the old settings are kept, never discarded.

**Uninstall** deactivates the plugin and removes the artefact, but it does **not** remove the
`plugins` row while anything still points at it — custom fields it declared, jobs it created, review
queue entries it raised, audit entries naming it as actor (data-model invariant PL1). The row stays as
a resolvable owner with `enabled = false`; the settings, including their environment references, stay
with it, so reinstalling restores the configuration. Check results, field provenance and graph edges
carrying the plugin's source name likewise stay in the library with their provenance intact, because
removing them would be rewriting history (P4, P5). The confirmation dialogue names all of this before
the operator agrees to it, and afterwards those records are shown as coming from an uninstalled plugin
rather than being quietly hidden.

### 3.10 Development

`RECUEIL_DEV=1` enables watch-mode reload: on a change under a `local` plugin path the host
deactivates, re-imports and reactivates that plugin only. Reload is a development convenience and is
refused when the server is not in development mode, because a half-reloaded plugin in production is
worse than a restart.

`create-recueil-plugin` scaffolds a working plugin with a manifest, one hook, a test using the fake
`ctx`, and the compatibility suite wired into CI (Phase 9; the template exists from Phase 3 for
first-party use).

### 3.11 The `when` expression grammar

UI contributions may carry a `when` expression, evaluated by the host against the current UI context
to decide visibility without mounting the contribution. The grammar is deliberately tiny and cannot
call code:

```
expr    := or
or      := and ( "||" and )*
and     := not ( "&&" not )*
not     := "!" not | primary
primary := "(" expr ")" | comparison | path
comparison := path ( "==" | "!=" | "in" ) literal
path    := ident ( "." ident )*
literal := string | number | "true" | "false" | "null" | "[" literal ( "," literal )* "]"
```

Available paths: `item.type`, `item.hasAttachments`, `item.hasDoi`, `item.inReview`, `item.isTrashed`,
`selection.count`, `selection.kind`, `view` (`library`, `reader`, `graph`, `review`, `settings`),
`review.stage`, `plugin.settings.<key>` for boolean and string settings, and `platform`
(`web`, `desktop`, `mobile`). An expression referring to an unknown path evaluates to `false` and logs
once. New paths are additive and therefore a minor.

---

## 4. Settings

### 4.1 Storage

A plugin's settings are one JSON object, stored in `plugins.settings`, validated against the
manifest's `settings` schema on every write. There is no per-plugin table and no key-value store: a
plugin that wants structured data of its own creates custom fields, notes or analytics tables through
the API, and does not invent storage.

Defaults come from the schema. When a plugin is installed, the host materialises the object by walking
the schema and taking every `default`; properties without a default and without a value are simply
absent, and if such a property is in `required`, the plugin is `needs_configuration`.

On upgrade the stored object is re-validated against the new schema. Properties that disappeared from
the schema are kept in the row but not surfaced, so a downgrade does not lose the operator's
configuration. Properties that appeared take their default.

### 4.2 Secrets

A settings property marked `"x-recueil-secret": true` never holds its own value. Credentials do not
live in the database: what `plugins.settings` stores is a **reference**, and the value comes from the
environment (CONCEPT.md §5.15, data-model invariant PL2).

- **Accepted forms** are `${env:VAR_NAME}` and `${file:/run/secrets/name}`. A write supplying anything
  else for a secret property is rejected with a `ValidationError` naming the property — there is no
  path by which a literal credential reaches the database, not through the API, the CLI, an import or
  a plugin's own `settings.patch`.
- **Resolved** at `ctx.settings.get()` time. The plugin receives the value; nothing else does, and the
  resolved value is never written anywhere.
- **Read back** through the API as the reference itself — `${env:OPENALEX_KEY}` is not a secret — with
  a `resolves: true | false` flag so the UI can tell the operator that the variable they named is not
  actually set, which is otherwise a maddening class of bug.
- **Excluded** from logs, event payloads, job parameters, error messages and the audit log's
  `before`/`after` columns. Since the value is not in the database, `recueil backup` carries the
  reference and not the credential, which is the main reason for doing it this way.
- **Canary-tested.** The compatibility suite seeds a known value into the referenced variable and
  fails the plugin if it appears in anything the plugin emits (check P3).

### 4.3 Settings that need a restart

`"x-recueil-restart": true` on a property means a change takes effect only after the plugin is
reactivated. The UI marks the field, the API response to a write that touched such a property includes
`requiresReactivation: true`, and the plugin list offers the reactivation. The host does not reactivate
by itself, because a reactivation during a running job is exactly what §3.9 refuses.

Everything else is live: the host validates the write, stores it, and notifies the plugin.

```ts
interface SettingsHandle<T = JsonObject> {
  /** Current values, secrets resolved, defaults applied. Cheap; call it per invocation rather than caching. */
  get(): Promise<T>;
  /** Fires after a committed change. Does not fire for `x-recueil-restart` properties. */
  onChange(handler: (next: T, changedPaths: string[]) => Promise<void>): () => void;
  /** Writes the plugin's own settings. Requires `settings:write`; most plugins never need it. */
  patch(values: Partial<T>): Promise<T>;
}
```

### 4.4 How settings are surfaced

**Generated form.** By default the web UI generates the settings form from the JSON Schema. This is
why the schema's annotations matter more than they look: `title` becomes the label, `description` the
help text, `default` the placeholder and the reset value, `enum` a select, `format: "email"` and
`format: "uri"` the input type and client-side validation, `minimum`/`maximum` the numeric bounds,
`x-recueil-secret` a reference field that accepts only `${env:...}` or `${file:...}` and shows whether
the reference currently resolves. A property with no `title` and no `description` renders as a bare
key name and looks like the oversight it is.

**Custom page.** A plugin whose configuration is too rich for a generated form contributes a
`settingsPages` entry (see the manifest schema). It still declares the `settings` schema: the schema
remains the validation contract, and the page is only a better editor for the same object.

**API.** `GET /api/v1/plugins/{name}/settings` returns the current values with secrets redacted and
the schema alongside, so any client can render a form. `PUT` replaces, `PATCH` merges; both validate
and both write an audit entry with secrets redacted in `before`/`after`.

**CLI.** `recueil plugins settings <name>` prints them; `recueil plugins settings <name> --set key=value`
writes one. `recueil plugins settings <name> --schema` prints the schema, which is what a deployment
script reads.

**Environment.** Every setting can be overridden from the environment, which is how a Docker
deployment configures a plugin without touching the database:

```
RECUEIL_PLUGIN_<NAME>__<PATH>
```

`<NAME>` is the manifest `name` upper-cased with `@` removed and `/`, `-` and `.` replaced by `_`;
`<PATH>` is the settings path with `.` replaced by `__`. So `@recueil/resolver-openalex`'s `mailto`
becomes `RECUEIL_PLUGIN_RECUEIL_RESOLVER_OPENALEX__MAILTO`. Environment values win over stored values,
are shown in the UI as "set by environment" and are read-only there. Two plugin names that normalise
to the same variable prefix are a boot-time error rather than a silent shadowing.

### 4.5 What settings are not

Settings are configuration: things the operator sets and rarely changes. They are not the plugin's
runtime state. A resolver's cache belongs in `ctx.cache`, a poller's cursor belongs in the job record,
a per-item value belongs in a custom field, and a large or frequently-written blob belongs in neither
— it belongs in a table the plugin does not have, which is the host telling the plugin to reconsider.

---

## 5. The compatibility test suite

### 5.1 What it is and why the plugin runs it

`@recueil/plugin-test-kit` is a Vitest-based suite that a plugin runs **in its own CI**, against its
own build, at every commit. It is not a linter that Recueil runs over the registry; it is the plugin's
own evidence that it implements the contract.

The reason for putting it there rather than in the host is that most of what needs checking is
behaviour under conditions the host cannot manufacture cheaply at install time: what happens when the
upstream rate-limits, whether a hook is symmetric, whether two identical invocations write twice.
Those are tests, and tests belong with the code they test.

```bash
pnpm add -D @recueil/plugin-test-kit
pnpm exec recueil-plugin test          # full suite
pnpm exec recueil-plugin test --strict # warnings become failures
pnpm exec recueil-plugin test --report report.json
```

### 5.2 What it checks

**Manifest and packaging**

| Id | Check |
|---|---|
| M1 | The manifest validates against `plugin-manifest.schema.json`. |
| M2 | `recueilApi` is a valid range and includes at least one supported plugin API version. |
| M3 | `licence` parses as an SPDX expression. |
| M4 | Every `permissionNotes` key also appears in `permissions`. |
| M5 | Hook ids, contribution ids and command ids are unique within the manifest. |
| M6 | `main`, `ui` and `icon` exist **in the packed tarball**, not merely in the working tree. |

**Contract conformance**

| Id | Check |
|---|---|
| C1 | Every `hooks[].export` and `events[].export` exists in the entry module. |
| C2 | Each export structurally implements its interface: required methods present, optional ones absent or callable. |
| C3 | Type-level assignability of each export to the SDK interface, compiled against the lowest **and** highest plugin API typings in the declared range. |
| C4 | Import lint: nothing from the Recueil namespace except `@recueil/plugin-sdk`; no `node:fs`, `node:child_process`, `node:net` or `node:http` unless the matching permission is declared. |
| C5 | Structured-clone conformance: every argument and return value crossing the boundary survives `structuredClone`. |
| C6 | No top-level side effects: the entry module imports in under 200 ms, opens no socket, reads no file, starts no timer. |

**Behaviour**

| Id | Check |
|---|---|
| B1 | Activation completes within the budget; deactivation releases every timer, socket, watcher and byte handle, verified by a leak detector. |
| B2 | Idempotency: each hook invoked twice with identical input returns an equal result and causes no additional host writes. |
| B3 | Determinism, for the hooks required to be pure: `check.run`, `dedupRule.blockingKeys`, `dedupRule.compare`, `srTemplate.instrument`, `analyticsExport.produce`. |
| B4 | Symmetry: `compare(a, b)` equals `compare(b, a)` across the fixture library. |
| B5 | Read-only assertion for the hooks that must not write: `resolver`, `check`, `dedupRule`, `exporter`, `importer`, `graphEdgeProvider`, `analyticsExport`, `srTemplate`. |
| B6 | Error discipline: injected upstream failures produce `PluginError` subclasses; an injected 429 produces `RateLimitError` with `retryAfterMs`. |
| B7 | Cancellation: every hook settles within 1 s of `ctx.signal` aborting. |
| B8 | Timeout compliance against the declared or default `timeoutMs`, measured on the fixture library. |
| B9 | Budget compliance: `graphEdgeProvider` never reports `budgetSpent` above the requested budget. |
| B10 | Provenance completeness: every field, edge and metric returned carries a `Provenance` with a `fetchedAt` and a `confidence` in `[0, 1]`. |

**Permissions**

| Id | Check |
|---|---|
| P1 | Every capability the plugin actually calls is covered by a declared permission. Missing coverage fails. |
| P2 | Every declared permission is actually used. Over-declaration warns, and fails under `--strict`. |
| P3 | A canary secret seeded into settings appears in no log line, event payload, error message or hook return value. |

**Settings**

| Id | Check |
|---|---|
| S1 | The `settings` schema is a valid draft 2020-12 object schema. |
| S2 | Every property has a `title` and a `description`; every non-required property has a `default`. |
| S3 | The plugin activates cleanly with defaults only. |
| S4 | Settings round-trip: write, read, compare; secrets read back redacted. |

**Events**

| Id | Check |
|---|---|
| E1 | Every subscribed event's handler exists and is a function. |
| E2 | Duplicate delivery of the same envelope id has the same effect as a single delivery. |
| E3 | No handler emits events beyond causation depth 8. |

**Compatibility matrix**

| Id | Check |
|---|---|
| X1 | The suite runs against the lowest and the highest plugin API version satisfying `recueilApi`. |
| X2 | Deprecation scan: the plugin uses nothing deprecated as of the highest tested version. |
| X3 | Node 22 LTS and the current Node release. |

### 5.3 Fixtures and network

The kit ships the fixture library from `fixtures/` — Zotero, Paperless, BibTeX and RIS sets — so that
importer, dedup and check tests run against the same corpus the host's own tests use, and a regression
means the same thing in both places.

Network is off by default. Resolver and ingest tests run against recorded HTTP cassettes shipped with
the kit, plus fault-injection cases (429 with and without `Retry-After`, 500, timeout, malformed JSON,
truncated response) that would be tedious to provoke against a live service and rude to provoke often.
`--record` re-records a cassette against the live upstream; the recording is committed, so a reviewer
can see exactly what the plugin was tested against.

### 5.4 Output

The suite writes a JSON report and a human summary. Every check reports `pass`, `warn`, `fail` or
`skip`, with `skip` reserved for checks that do not apply — B4 is skipped by a plugin with no dedup
rule, and that is not a shortfall. Exit status is non-zero on any `fail`, and on any `warn` under
`--strict`.

```yaml
# .github/workflows/compat.yml
name: Recueil plugin compatibility
on: [push, pull_request]
jobs:
  compat:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm exec recueil-plugin test --report compat-report.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: compat-report-node${{ matrix.node }}
          path: compat-report.json
```

### 5.5 Where the report is used

**First-party plugins.** Every plugin in `plugins/` runs the suite in the monorepo CI, and a failure
blocks the merge. That is the dogfooding requirement in CONCEPT.md §5.13 made mechanical: the contract
is not a document that describes the first-party plugins, it is a document they are tested against.

**The registry (Phase 9).** `etabli/recueil-registry` records, per plugin version, the plugin API
version tested, the suite version, the date and the result. A plugin with no passing run is listed but
flagged, and the install dialogue says so alongside the trust statement from §3.1. The registry does
not re-run the suite and does not vouch for the plugin; it publishes what the author's CI reported and
links to the run.

**Upgrades.** `recueil plugins doctor` cross-references installed plugins against the running plugin
API version and the deprecation list, so the operator learns what a major upgrade will cost before
taking it rather than after.
