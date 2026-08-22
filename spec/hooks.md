# Hook catalogue, v1

| | |
|---|---|
| Status | Draft v0.1 |
| Date | 2026-08-22 |
| Phase | Phase 0 deliverable (P8: plugin contract before UI) |
| Covers | CONCEPT.md §5.13 |
| Companions | [`plugin-manifest.schema.json`](plugin-manifest.schema.json) · [`plugin-api.md`](plugin-api.md) · [ADR-0012](adr/0012-in-process-trusted-plugin-host-in-v1.md) · [ADR-0018](adr/0018-sandboxing-tier-in-process-until-multi-user.md) |

This document is the v1 catalogue: eleven hooks and twelve lifecycle events. For each hook it gives
what it is for, when the host calls it, the TypeScript interface a plugin must implement, and the
guarantees the host gives in return — ordering, error handling, idempotency and timeouts. Every
first-party plugin in `plugins/` implements hooks from this catalogue and nothing else; that is how
the contract is dogfooded rather than described.

Types are shown as they appear in `@recueil/plugin-sdk`. A plugin never declares them itself.

---

## 1. Hooks and events are different things

A **hook** is a slot in a host workflow. The host calls it, waits for a result, and does something
with that result. Hooks are how a plugin participates in a decision the host is in the middle of
making: which metadata to trust, whether two records are the same work, where the bytes go.

An **event** is a notification that something already happened. It is delivered after the
transaction that caused it has committed. Nothing the handler does can undo it, and nothing the host
does waits for the handler unless the subscription explicitly asks to block.

If you find yourself wanting an event handler to change the outcome of the thing that emitted it,
you want a hook. If you find yourself wanting a hook to have an external side effect — post to a
webhook, write a file, send a mail — you want an event, because hooks are re-run on retry and events
are not.

## 2. Two rules that apply to every hook

**Only `@recueil/plugin-sdk`.** A plugin may import the SDK and third-party packages from npm. It may
not import Recueil server internals: no Drizzle, no service classes, no `apps/server` module, no
database handle, no direct filesystem access to the content store. An import lint in the
compatibility test suite enforces this. The rule exists so that the eventual move to a
`worker_threads` or WASM host is a change of host and not a change of contract (ADR-0018).

**Everything crossing the boundary is structured-cloneable.** Arguments and return values must
survive `structuredClone`: plain objects, arrays, strings, numbers, booleans, `null`, `Date`,
`Uint8Array`, `Map`, `Set`. No class instances, no functions, no streams, no promises inside
payloads. Bytes move through the handle protocol in §4. This is a real constraint and it makes a
couple of hooks — a streaming ingest stage, most of all — more awkward than a naive in-process design
would be. That cost is accepted deliberately.

Both rules are checkable today and both are why the permissions in the manifest can become
enforcement points on the capability object later without touching plugin source.

## 3. Shared types

```ts
/** RFC 3339 timestamp in UTC, e.g. "2026-08-22T09:14:00Z". */
type Timestamp = string;
/** ULID, lexicographically sortable, used for every host-issued id. */
type Ulid = string;
/** 64 lower-case hex characters. */
type Sha256 = string;

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type JsonObject = { [k: string]: JsonValue };
/** A JSON Schema document, draft 2020-12. */
type JsonSchema = JsonObject;

/** Provenance travels with every derived fact (P4). Nothing enters the library without one. */
interface Provenance {
  /** Resolver source name, hook id or `manual`. */
  source: string;
  /** Upstream record id, where the source has one. */
  sourceRecordId?: string;
  fetchedAt: Timestamp;
  /** 0..1. A source that cannot estimate confidence reports its configured default, never 1. */
  confidence: number;
}

interface Actor {
  type: 'user' | 'token' | 'system' | 'plugin' | 'job' | 'mcp';
  userId?: string;
  tokenId?: string;
  pluginName?: string;
  jobId?: string;
}

/** Every paged host call uses this shape. An absent cursor means the page is the last one. */
interface Page<T> {
  records: T[];
  cursor?: string;
  /** Present only when the source can count without paying for it. */
  total?: number;
}

type IdentifierScheme =
  | 'doi' | 'pmid' | 'pmcid' | 'arxiv' | 'isbn' | 'issn' | 'issn_l'
  | 'openalex' | 'semantic_scholar' | 'datacite' | 'orcid' | 'ror' | 'url' | 'zotero_key';

interface Identifier {
  scheme: IdentifierScheme;
  /** Normalised: DOIs lower-cased and bare, ISBNs hyphen-free, arXiv ids without the `arXiv:` prefix. */
  value: string;
}

/** A work that is not (yet) an Item: a reference-list entry, a deep-dive hit, a search result. */
interface WorkStub {
  identifiers: Identifier[];
  title?: string;
  containerTitle?: string;
  issuedYear?: number;
  authors?: { family?: string; given?: string; literal?: string; orcid?: string }[];
  raw?: JsonValue;
}

/** Reported next to every map and every enrichment run, because a map without it misleads (P4). */
interface CoverageReport {
  /** Subjects the provider was asked about. */
  requested: number;
  /** Subjects for which it returned anything. */
  covered: number;
  /** Per upstream source: how many records came from where, and when they were fetched. */
  bySource: { source: string; records: number; fetchedAt: Timestamp }[];
  notes?: string[];
}

interface HealthReport {
  status: 'ok' | 'degraded' | 'unavailable';
  message?: string;
  checkedAt: Timestamp;
  detail?: JsonObject;
}
```

### 3.1 The context objects

Every capability the host offers reaches the plugin through a context object handed to it at
activation or at call time. There are no module globals and no singletons; that is condition 2 of the
ADR-0018 migration path.

```ts
interface PluginContext {
  readonly plugin: { name: string; version: string; pluginApi: string };
  readonly settings: SettingsHandle;
  readonly log: Logger;

  /** Namespaces are present only when the matching permission is declared. */
  readonly library?: LibraryApi;       // items, documents, attachments, notes, collections, tags
  readonly graph?: GraphApi;           // nodes, edges, shadow works
  readonly search?: SearchApi;
  readonly sr?: SystematicReviewApi;
  readonly storage?: StorageApi;
  readonly jobs?: JobsApi;
  readonly http?: HttpApi;             // permission `network:outbound`
  readonly events?: EventsApi;

  readonly bytes: BytesApi;            // §4
  readonly cache: CacheApi;            // namespaced, TTL'd, cleared on version change
  readonly scratch: ScratchApi;        // per-invocation temporary space, always cleaned up
  readonly now: () => Timestamp;       // injectable so tests are deterministic
  /** Aborted when the plugin is deactivated. Long-running work must honour it. */
  readonly signal: AbortSignal;
}

/** Handed to every hook call. Adds what is true of this invocation and nothing else. */
interface HookContext extends PluginContext {
  readonly invocationId: Ulid;
  readonly hookId: string;
  /** Aborted at the deadline as well as at deactivation. */
  readonly signal: AbortSignal;
  readonly deadline: Timestamp;
  /** 1 on the first attempt. Retries reuse the same idempotency key. */
  readonly attempt: number;
  readonly jobId?: string;
  readonly idempotencyKey?: string;
  /** Who asked. Recorded in the audit log against anything the call causes. */
  readonly actor: Actor;
  /** True when the host is producing a report rather than applying changes. Behaviour must be identical. */
  readonly dryRun: boolean;
}
```

On permissions: in v1 the host builds the capability object from the manifest's `permissions`, so an
undeclared namespace is absent and an undeclared method rejects with `PermissionDeniedError`. That is
a **contract check, not a security boundary** — the plugin runs in the server process and can reach
around it with plain Node (ADR-0012). It is written this way now so that enforcement, when it comes,
is a change of host and not a new mechanism (ADR-0018).

### 3.2 Errors

The SDK exports one error hierarchy (shown here as declarations, since the SDK supplies them). Throwing anything else is legal but loses the metadata the host
uses to decide what to do next, and a bare `Error` is always treated as non-retryable.

```ts
declare class PluginError extends Error {
  readonly code: string;
  /** Whether the host should try again. Default false. */
  readonly retryable: boolean;
  /** Honoured by the scheduler on rate-limit and upstream errors. */
  readonly retryAfterMs?: number;
  /** Shown to the operator. Must not contain secrets. */
  readonly userMessage?: string;
  readonly detail?: JsonObject;
}

declare class RateLimitError extends PluginError {}          // retryable, does not consume an attempt
declare class UpstreamUnavailableError extends PluginError {} // retryable
declare class NotFoundError extends PluginError {}            // not retryable; usually return empty instead
declare class ValidationError extends PluginError {}          // not retryable
declare class IntegrityError extends PluginError {}           // not retryable, always surfaced to the operator
declare class BudgetExceededError extends PluginError {}      // not retryable, batch discarded
declare class PermissionDeniedError extends PluginError {}    // not retryable
declare class TimeoutError extends PluginError {}             // raised by the host, not the plugin
```

Default retry policy for retryable errors inside a job: exponential backoff from 1 s, factor 2, full
jitter, ceiling 15 min, six attempts, then the job moves to `dead` and a `job.failed` event fires with
`state: 'dead'`. `RateLimitError` reschedules at `retryAfterMs` and does not increment `attempt`.

## 4. Bytes across the boundary

`Uint8Array` clones fine but a whole PDF does not want to be cloned, and streams do not clone at all.
Bytes therefore move through opaque handles: the host owns the buffer, the plugin owns a ticket.

```ts
interface ReadHandle { readonly id: Ulid; readonly byteSize?: number; readonly sha256?: Sha256 }
interface WriteHandle { readonly id: Ulid }

interface BytesApi {
  read(handle: ReadHandle, offset: number, length: number): Promise<Uint8Array>;
  /** Sequential convenience over `read`. Default chunk 4 MiB. */
  chunks(handle: ReadHandle, chunkBytes?: number): Promise<{ next(): Promise<Uint8Array | null> }>;
  openWrite(hint?: { byteSize?: number; mediaType?: string }): Promise<WriteHandle>;
  write(handle: WriteHandle, chunk: Uint8Array): Promise<void>;
  /** Returns the SHA-256 the host computed while the bytes went past. */
  closeWrite(handle: WriteHandle): Promise<{ sha256: Sha256; byteSize: number }>;
  abortWrite(handle: WriteHandle): Promise<void>;
  release(handle: ReadHandle): Promise<void>;
}
```

Handles are valid for the invocation that produced them and are released automatically when it ends.
A handle used after its invocation throws `ValidationError`. Text follows the same rule above an
inline threshold of 256 KiB: below it, strings are passed by value; above it, as a `ReadHandle` with
`mediaType: 'text/plain'`.

## 5. Timeouts at a glance

Every hook call runs under a deadline. At the deadline `ctx.signal` aborts; 5 s later, if the promise
has still not settled, the host abandons it, records a `TimeoutError` and — because the call is
in-process and cannot actually be killed (ADR-0012) — logs that the plugin is still running. A plugin
that repeatedly overruns is disabled after three consecutive timeouts in one run and the operator is
told which hook did it.

| Hook | Call | Default | Ceiling via `timeoutMs` |
|---|---|---|---|
| `resolver` | `lookup`, `search`, `metrics` | 30 s | 5 min |
| `resolver` | `references`, `citations` (per page) | 60 s | 5 min |
| `check` | `run` per subject | 60 s | 5 min |
| `check` | `autoFix` | 30 s | 2 min |
| `dedupRule` | `blockingKeys` | 2 s | 10 s |
| `dedupRule` | `compare` | 5 s | 30 s |
| `ingestSource` | `poll` | 60 s | 10 min |
| `ingestSource` | `fetch` | 15 min | 60 min |
| `ingestSource` | `acknowledge` | 30 s | 5 min |
| `ingestStage` | `run` | 120 s | 10 min |
| `storageBackend` | any single operation | 60 s | 15 min |
| `exporter` | inline export | 30 s | — (use a job) |
| `exporter` | job export, per sink write | 60 s | 10 min |
| `importer` | `detect` | 5 s | 30 s |
| `importer` | `parse` per batch | 120 s | 10 min |
| `graphEdgeProvider` | `provide` per batch | 120 s | 10 min |
| `analyticsExport` | `produce` per batch | 60 s | 10 min |
| `srTemplate` | `instrument`, `derive`, `migrate` | 10 s | 60 s |
| lifecycle event | `async` handler | 120 s | 10 min |
| lifecycle event | `blocking` handler | 2 s, shared across all plugins | not raisable |
| activation | `activate` | 10 s | 60 s |
| deactivation | `deactivate` | 5 s | 30 s |

---

# 6. The eleven hooks

## 6.1 `resolver`

**What it is for.** Turning an identifier or a scrap of metadata into bibliographic facts, and
fetching the reference lists, citing works and metrics that the graph and bibliometrics layers are
built from (CONCEPT.md §5.4). Crossref, OpenAlex, PubMed, Semantic Scholar, DataCite, arXiv,
OpenLibrary, ORCID and Unpaywall are all first-party plugins implementing this one interface.

**When the host calls it.** At ingestion stage 7 (identifier resolution); from the enrichment job,
scheduled or on demand; from the connector and translation-server paths when an id is captured
without metadata; from the bibliography audit mode on records that are not in the library; from the
`existence` and `doi_resolves` checks; and from the deep-dive expansion for `references` and
`citations`.

```ts
interface Resolver {
  readonly id: string;
  /** Source name written into `Provenance.source` and `field_provenance.source`. */
  readonly source: string;

  readonly supports: {
    lookup: readonly IdentifierScheme[];
    search: boolean;
    references: boolean;
    citations: boolean;
    /** Metric names this source can observe, e.g. `cited_by_count`, `fwci`. */
    metrics: readonly string[];
  };

  /** Advisory ceiling. The host's adaptive limiter starts here and backs off; it never exceeds it. */
  readonly rateLimit?: { requestsPerSecond: number; burst?: number; concurrency?: number };

  lookup(req: ResolverLookupRequest, ctx: HookContext): Promise<ResolverRecord[]>;
  search?(req: ResolverSearchRequest, ctx: HookContext): Promise<ResolverRecord[]>;
  references?(req: ResolverEdgeRequest, ctx: HookContext): Promise<Page<WorkStub>>;
  citations?(req: ResolverEdgeRequest, ctx: HookContext): Promise<Page<WorkStub>>;
  metrics?(req: ResolverMetricRequest, ctx: HookContext): Promise<MetricObservation[]>;
  health?(ctx: HookContext): Promise<HealthReport>;
}

interface ResolverLookupRequest {
  /** One or more identifiers for the same work. Resolving any of them is a success. */
  identifiers: Identifier[];
  /** Field paths the caller wants. A resolver may return more; it must not return less than it has. */
  fields?: string[];
}

interface ResolverSearchRequest {
  query: {
    title?: string;
    authors?: string[];
    containerTitle?: string;
    issuedYear?: number;
    /** Free text, when the caller has nothing structured. */
    text?: string;
  };
  limit: number;
}

interface ResolverEdgeRequest {
  identifier: Identifier;
  cursor?: string;
  limit: number;
}

interface ResolverMetricRequest {
  identifiers: Identifier[];
  metrics: string[];
}

interface ResolverRecord {
  /** Which of the requested identifiers this record answers, plus any the source added. */
  matched: Identifier[];
  itemType?: string;
  /**
   * Dotted field paths into the bibliographic or office facet, each with its own provenance.
   * A resolver never returns a bare value: the merge policy needs to know where it came from.
   */
  fields: Record<string, { value: JsonValue; provenance: Provenance }>;
  creators?: {
    role: string;
    family?: string;
    given?: string;
    literal?: string;
    orcid?: string;
    sequence: number;
    provenance: Provenance;
  }[];
  terms?: { scheme: string; code?: string; label: string; provenance: Provenance }[];
  /** 0..1, the resolver's own belief that this record is the requested work. */
  score: number;
  /** Upstream payload, kept for the provenance trail. Trimmed by the host above 256 KiB. */
  raw?: JsonValue;
}

interface MetricObservation {
  identifier: Identifier;
  metric: string;
  value: number;
  observedAt: Timestamp;
  provenance: Provenance;
}
```

**Guarantees.**

*Ordering.* Resolvers run in manifest `priority` order, ties broken by plugin name then hook id, so
the order is stable across restarts. Order is only a tiebreaker input: the host's per-field merge
policy, with its configured preferred-source order and its manual-lock flags, decides which value
wins. A resolver never sees another resolver's output.

*Error handling.* A `NotFoundError` is not how you say "no match" — return `[]`. Throwing marks the
resolver failed for that subject; the enrichment job records it on the job log and continues with the
remaining resolvers, so one dead upstream never stalls a run. `RateLimitError` with `retryAfterMs`
pauses that resolver only, across all in-flight subjects, and does not consume a retry attempt.

*Idempotency.* Calls must be a pure function of the request modulo upstream change. The host caches
by `(plugin, hook id, request hash)` for the configured TTL and will happily replay a request rather
than repeat it. Resolvers must not write to the library: they return records, and the host applies
the merge policy, writes `field_provenance` and emits `item.updated`. A resolver that writes has made
the merge policy unenforceable and fails the compatibility suite's read-only assertion.

*Timeouts.* 30 s per lookup, 60 s per edge page. Batch work belongs in a job, not in a longer timeout.

---

## 6.2 `check`

**What it is for.** One verification rule in the checks engine (CONCEPT.md §5.5): does this DOI
resolve, is this reference fabricated, has this paper been retracted, does the citation key collide.
`checks-core` ships the thirteen listed checks as a single first-party plugin.

**When the host calls it.** On import, on demand from the UI or CLI, on a schedule, and in
bibliography audit mode over pasted reference lists that have no Item behind them. The subject may
therefore be an Item, a Document, an Attachment, or a free-standing parsed reference.

```ts
type CheckSubjectType = 'item' | 'document' | 'attachment' | 'creator' | 'reference' | 'library';

type CheckSubject =
  | { type: 'item'; itemId: string; snapshot: JsonObject }
  | { type: 'document'; documentId: string; sha256: Sha256; snapshot: JsonObject }
  | { type: 'attachment'; attachmentId: string; itemId: string; snapshot: JsonObject }
  | { type: 'creator'; creatorId: string; snapshot: JsonObject }
  /** Bibliography audit mode: parsed but not in the library, so there is no id. */
  | { type: 'reference'; localRef: string; stub: WorkStub; rawString?: string }
  /** Library-wide checks such as citation-key collision. */
  | { type: 'library'; scope: { collectionId?: string; savedSearchId?: string } };

interface Check {
  readonly id: string;
  readonly title: string;
  readonly severity: 'info' | 'warning' | 'error';
  /** One paragraph in plain British English, shown verbatim in the report next to every failure. */
  readonly explanation: string;
  readonly subjectTypes: readonly CheckSubjectType[];
  readonly autoFixable: boolean;
  /** Declared so the host can skip the check when offline or when the text layer is missing. */
  readonly requires?: {
    network?: boolean;
    fullText?: boolean;
    resolvers?: readonly string[];
  };

  run(subject: CheckSubject, ctx: HookContext): Promise<CheckResult[]>;
  autoFix?(result: CheckResult, ctx: HookContext): Promise<FixProposal>;
}

interface CheckResult {
  checkId: string;
  subjectType: CheckSubjectType;
  /** Item, document or attachment id; `localRef` in audit mode. */
  subjectId: string;
  itemId?: string;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  severity: 'info' | 'warning' | 'error';
  /** One sentence naming the specific problem, not the check. "DOI 10.x/y returns 404", not "DOI check failed". */
  message: string;
  detail?: JsonObject;
  autoFixable: boolean;
  /** What the verdict rests on. A check that consulted an upstream source must say which and when. */
  evidence?: Provenance[];
}

interface FixProposal {
  explanation: string;
  changes: {
    entityType: 'item_bibliographic' | 'item_office' | 'creators' | 'attachments' | 'terms';
    entityId: string;
    fieldPath: string;
    before: JsonValue;
    after: JsonValue;
    provenance: Provenance;
  }[];
  /** True when the fix should go to the review queue rather than be applied (P3). */
  requiresReview: boolean;
  confidence: number;
}
```

**Guarantees.**

*Ordering.* Checks over different subjects run concurrently, bounded by the configured checks
concurrency. Within one subject, checks run in `priority` order, but they are forbidden to depend on
each other: the suite runs each check alone as well as in the set and compares. A check that needs
another check's output is one check.

*Error handling.* A throw is contained. The host records a single `skipped` result carrying the error
message and continues; a failing check never fails a run, never blocks an import, and never prevents
the report from being produced. Checks that declare `requires.network` are skipped, not failed, when
the host is offline.

*Idempotency.* `run` is read-only and must be deterministic given the same subject and the same
upstream state. `autoFix` is also read-only: it returns a proposal, and the host applies it inside
its own transaction, writes provenance, and emits `item.updated`. Below the auto-accept threshold or
with `requiresReview`, the proposal becomes a `review_queue` entry instead (P3). Applying the same
proposal twice is a no-op because the host compares `before` against current state and refuses a
stale fix.

*Timeouts.* 60 s per subject, 30 s per fix. A check whose honest answer needs a long upstream crawl
should return `skipped` with a message and schedule a job.

---

## 6.3 `dedupRule`

**What it is for.** One rule in the deduplication engine (CONCEPT.md §5.6), at either the file layer
(hash, simhash of extracted text) or the record layer (identifier match after normalisation, fuzzy
title/year/author/venue match). `dedup-files` and `dedup-records` are the first-party plugins; the
Attaclone and Argus One logic being retired lives here.

**When the host calls it.** During a dedup run — scheduled, on demand, or as a dry-run report — and
at ingestion stage 2 for the file layer. Never on the interactive request path.

```ts
type DedupSubject =
  | { layer: 'file'; documentId: string; sha256: Sha256; byteSize: number; mediaType: string;
      simhash?: string; textHandle?: ReadHandle; annotationCount: number }
  | { layer: 'record'; itemId: string; itemType: string; snapshot: JsonObject;
      identifiers: Identifier[]; normalisedTitle: string; issuedYear?: number };

interface DedupRule {
  readonly id: string;
  readonly layer: 'file' | 'record';
  readonly title: string;

  /**
   * Cheap, deterministic candidate keys. Two subjects are compared only if they share a key,
   * so this is what makes dedup tractable on a large library. Called once per subject per run.
   */
  blockingKeys(subject: DedupSubject, ctx: HookContext): Promise<string[]>;

  /** Called only on pairs sharing a blocking key. Must be symmetric. */
  compare(a: DedupSubject, b: DedupSubject, ctx: HookContext): Promise<DedupVerdict>;

  /** Optional opinion on which side should survive a merge. The configured winner rule still decides. */
  mergePreference?(a: DedupSubject, b: DedupSubject, ctx: HookContext): Promise<'a' | 'b' | 'undecided'>;
}

interface DedupVerdict {
  ruleId: string;
  /** 0..1. Compared against the engine's auto-merge and review thresholds. */
  score: number;
  action: 'duplicate' | 'related' | 'distinct' | 'undecided';
  /** Shown in the dry-run report and in the review queue. Must name the evidence, not the rule. */
  reason: string;
  evidence?: JsonObject;
}
```

**Guarantees.**

*Ordering.* All rules for a layer contribute; the engine combines their verdicts with the configured
policy (by default: the highest-scoring `duplicate` wins, any `distinct` from a rule marked
authoritative vetoes). Rules run in `priority` order and the order is stable, but a rule must not
assume it runs first or last.

*Error handling.* A throw in `blockingKeys` disables that rule for the run with a logged reason —
the run continues with the remaining rules rather than aborting, because a half-blocked run produces
false negatives, which are safe, rather than false merges, which are not. A throw in `compare` yields
`undecided` for that pair and the pair goes to the review queue.

*Idempotency.* `compare(a, b)` must equal `compare(b, a)`; the suite tests symmetry on the fixture
library and fails the plugin if it does not hold. Rules never write and never merge. Only the engine
merges, only above the auto-merge threshold, only for byte-identical files or identifier matches, and
always with a reversible merge record and the loser in the trash (P5). Everything else is flagged
(P3). `ctx.dryRun` is true when the engine is producing a report; behaviour must be identical, which
is the whole point of dry-run.

*Timeouts.* 2 s per `blockingKeys`, 5 s per `compare`. These are deliberately tight: a rule that needs
a network call per pair is not a dedup rule, it is a resolver being misused.

---

## 6.4 `ingestSource`

**What it is for.** A place documents come from (CONCEPT.md §5.3): a watched folder, a WebDAV share,
an IMAP mailbox, a scanner drop directory, an S3 prefix. First-party: `ingest-folder`,
`ingest-webdav`, `ingest-imap`.

**When the host calls it.** `start` at activation, `poll` on the configured interval from the job
runner, `fetch` when the pipeline is ready for the bytes, `acknowledge` once the pipeline has finished
with a candidate, `stop` at deactivation.

```ts
interface IngestRef {
  sourceId: string;
  /** Stable within the source. Mailbox UID, WebDAV path plus etag, absolute file path. */
  externalId: string;
  /** Bump when the same externalId has new content, e.g. a rewritten file. */
  revision?: string;
}

interface IngestCandidate {
  ref: IngestRef;
  suggestedFilename?: string;
  mediaType?: string;
  byteSize?: number;
  observedAt: Timestamp;
  /** Sender, subject, folder path, scanner id — whatever the rule engine may match on at stage 8. */
  sourceMetadata?: JsonObject;
}

type IngestOutcome =
  | { status: 'ingested'; documentId: string; itemId?: string }
  | { status: 'duplicate'; documentId: string }
  | { status: 'review'; reviewQueueEntryId: string }
  | { status: 'failed'; code: string; message: string };

interface IngestSource {
  readonly id: string;
  /** `poll` is scheduled; `watch` pushes via ctx.events; `push` receives an inbound webhook. */
  readonly kind: 'poll' | 'watch' | 'push';

  start(ctx: PluginContext): Promise<void>;
  poll?(req: { cursor?: string; limit: number }, ctx: HookContext): Promise<Page<IngestCandidate>>;
  fetch(ref: IngestRef, ctx: HookContext): Promise<{ handle: ReadHandle; mediaType?: string }>;
  /** Called exactly once per candidate once the pipeline is done with it, and possibly again after a crash. */
  acknowledge(ref: IngestRef, outcome: IngestOutcome, ctx: HookContext): Promise<void>;
  stop(ctx: PluginContext): Promise<void>;
  health?(ctx: HookContext): Promise<HealthReport>;
}
```

**Guarantees.**

*Ordering.* `poll` is never called concurrently with itself for the same source; the job runner holds
a lease. `fetch` may run concurrently across candidates up to the configured ingestion concurrency.
`acknowledge` for a candidate always follows the `fetch` for it. `stop` always follows `start`.

*Error handling.* A throw from `poll` is retried with backoff and the source is marked `degraded` in
the plugin list after three consecutive failures; the cursor is not advanced, so nothing is lost. A
throw from `fetch` puts the candidate back for retry. A throw from `acknowledge` is retried
separately from ingestion — the document is already in the library, so failing to move the mail out
of the inbox must not cause a re-ingest.

*Idempotency.* The pipeline is idempotent by `(sha256, sourceId, externalId)`; a candidate whose key
has already been ingested at the same `revision` is skipped without calling `fetch`. Because
`acknowledge` can be delivered twice after a crash, its side effect — moving the mail, deleting the
remote file, writing the marker — must be safe to repeat. The plugin never hashes, never stores and
never creates Items: it produces candidates and bytes, and the host owns everything downstream (P2).

*Timeouts.* `poll` 60 s, `fetch` 15 min, `acknowledge` 30 s. `start` and `stop` are bounded by the
activation and deactivation budgets and must not block on the network: connect lazily.

---

## 6.5 `ingestStage`

**What it is for.** Inserting a step into the ten-stage ingestion pipeline (CONCEPT.md §5.3): a
custom OCR pre-pass, a barcode reader, a bank-statement parser, a house rule that reads a stamp on a
scanned letter.

**When the host calls it.** Once per document per pipeline run, at the declared `anchor` and
`position`, inside the pipeline's transaction.

```ts
type PipelineAnchor =
  | 'hash' | 'duplicate_check' | 'archive_extraction' | 'type_detection' | 'ocr'
  | 'metadata_extraction' | 'resolution' | 'rules' | 'confidence_gate' | 'commit';

interface IngestStageInput {
  readonly documentId: string;
  readonly sha256: Sha256;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly bytes: ReadHandle;
  /** Extracted text, once a stage has produced it. Inline below 256 KiB, otherwise a handle. */
  readonly text?: string | ReadHandle;
  /** The item the pipeline intends to create or update. Read-only; patch it via the result. */
  readonly proposal: {
    itemType?: string;
    fields: Record<string, { value: JsonValue; provenance: Provenance }>;
    creators: JsonObject[];
    collectionIds: string[];
    tags: string[];
    customFields: Record<string, JsonValue>;
    confidence: number;
  };
  readonly source: { kind: string; ref: IngestRef; metadata?: JsonObject };
  readonly previousStages: readonly string[];
}

type IngestStageResult =
  | {
      action: 'continue';
      patch?: {
        itemType?: string;
        fields?: Record<string, { value: JsonValue; provenance: Provenance }>;
        creators?: JsonObject[];
        addCollectionIds?: string[];
        addTags?: string[];
        customFields?: Record<string, JsonValue>;
      };
      /** Added to the running confidence used by the stage-9 gate. Range -1..1. */
      confidenceDelta?: number;
      /** Written to the job log, visible in the ingestion detail view. */
      notes?: string[];
    }
  | { action: 'review'; reasonCode: string; explanation: string; proposedAction?: string }
  | { action: 'stop'; reasonCode: string; explanation: string };

interface IngestStage {
  readonly id: string;
  readonly anchor: PipelineAnchor;
  readonly position: 'before' | 'after';
  run(input: IngestStageInput, ctx: HookContext): Promise<IngestStageResult>;
}
```

**Guarantees.**

*Ordering.* Stages are sorted by anchor position in the pipeline, then `before` before the anchor and
`after` after it, then by manifest `priority`, then plugin name, then hook id. The result is a total
order that does not change between restarts. `previousStages` tells a stage what has already run so it
can decline rather than guess.

*Error handling.* A stage runs inside the pipeline's single transaction (stage 10 is the commit). A
throw rolls the whole document's ingestion back — nothing is half-written — and the candidate is
retried later by its source. Three consecutive throws for the same document route it to the review
queue with the error as the reason rather than retrying for ever.

*Idempotency.* A stage will be re-run on retry, on a resumed job, and whenever the operator
re-ingests. It must therefore have no side effect outside its return value: no writes, no mail, no
webhook, no file. Anything with an outside effect belongs in a `document.ingested` event handler,
which fires exactly once per successful commit. Patches must be commutative with respect to fields
the stage did not touch, because another stage may have written them.

*Timeouts.* 120 s. A stage approaching that is doing work that belongs in a job: return `continue`
with a note and schedule one.

---

## 6.6 `storageBackend`

**What it is for.** Where document bytes physically live (CONCEPT.md §5.1, §5.15): local filesystem,
WebDAV, S3. First-party: `storage-webdav`, `storage-s3`; local filesystem is in the host.

**When the host calls it.** On every read and write of document bytes, on backup and restore, on
integrity verification, and when the reader needs a presigned URL.

```ts
interface ObjectHead {
  key: string;
  byteSize: number;
  /** The backend's own checksum, when it has one. Never trusted in place of a Recueil verify. */
  etag?: string;
  lastModified?: Timestamp;
  mediaType?: string;
}

interface StorageBackend {
  readonly id: string;
  readonly scheme: string;
  readonly capabilities: {
    ranges: boolean;
    presignedUrls: boolean;
    serverSideCopy: boolean;
    /** A backend that cannot list cannot be verified or backed up by `recueil backup`. */
    listing: boolean;
  };

  head(key: string, ctx: HookContext): Promise<ObjectHead | null>;
  openRead(key: string, range: { offset: number; length?: number } | undefined, ctx: HookContext): Promise<ReadHandle>;
  openWrite(key: string, hint: { byteSize?: number; mediaType?: string }, ctx: HookContext): Promise<WriteHandle>;
  commitWrite(handle: WriteHandle, ctx: HookContext): Promise<ObjectHead>;
  abortWrite(handle: WriteHandle, ctx: HookContext): Promise<void>;
  /** Only ever called by trash expiry or an explicit operator action. Never by the pipeline (P5). */
  remove(key: string, ctx: HookContext): Promise<void>;
  list(prefix: string, cursor: string | undefined, ctx: HookContext): Promise<Page<ObjectHead>>;
  verify(key: string, expectedSha256: Sha256, ctx: HookContext): Promise<{ ok: boolean; actualSha256?: Sha256; message?: string }>;
  presign?(key: string, opts: { method: 'GET' | 'PUT'; expiresInSeconds: number }, ctx: HookContext): Promise<{ url: string; headers?: Record<string, string> }>;
  health?(ctx: HookContext): Promise<HealthReport>;
}
```

**Guarantees.**

*Ordering.* Keys are always the content-addressed layout `aa/bb/<sha256>` (ADR-0004). The backend
never invents a layout, never renames, and never derives a key from a filename — that is what makes
the store readable without the application (P10). Operations on distinct keys may be reordered
freely; operations on one key are serialised by the host.

*Error handling.* Transient failures should be `UpstreamUnavailableError` so the host retries.
Writing an existing key with **different** bytes must throw `IntegrityError` and must not overwrite;
that condition means a hash collision or a corrupted store and the operator has to see it. `head` on
a missing key returns `null`; it does not throw.

*Idempotency.* Content addressing makes writes naturally idempotent: writing an existing key with the
same bytes succeeds as a no-op and returns the existing head. `commitWrite` may be retried after a
crash and must converge. Concurrent writes of the same key by two workers must both succeed or one
must fail cleanly with `IntegrityError` — a torn object is never acceptable. `remove` on a missing key
succeeds.

*Timeouts.* 60 s per operation, 15 min for a whole transfer through the handle protocol. A backend
that cannot meet 60 s on `head` is not usable as the primary store and should say so from `health`.

---

## 6.7 `exporter`

**What it is for.** Turning a selection into bytes in some format (CONCEPT.md §5.8, §5.11):
BibTeX, RIS, CSL-JSON, VOSviewer map files, Gephi GEXF, GraphML, CiteSpace WoS text, the bibliometrix
`M` frame, a PRISMA flow input, a Quarto bundle.

**When the host calls it.** From `GET /api/v1/export`, from the CLI, from the `.bib` endpoints, and
from a job when the selection is large. The plugin cannot tell which, and must not care.

```ts
type ExportTarget = 'items' | 'collection' | 'saved_search' | 'review' | 'graph' | 'curated_network' | 'annotations';

interface ExportRequest {
  target: ExportTarget;
  selection: {
    itemIds?: string[];
    collectionId?: string;
    savedSearchId?: string;
    reviewId?: string;
    networkId?: string;
    query?: JsonObject;
  };
  /** Validated by the host against `optionsSchema` before the call. */
  options: JsonObject;
  cursor?: string;
}

interface ExportSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Sets the Content-Disposition filename. Call before the first write. */
  setFilename(name: string): void;
}

interface ExportSummary {
  recordCount: number;
  byteCount: number;
  /** Every lossy mapping goes here. An export that silently drops data violates P10. */
  warnings: string[];
  cursor?: string;
  coverage?: CoverageReport;
}

interface Exporter {
  readonly id: string;
  readonly label: string;
  readonly mediaType: string;
  readonly fileExtension: string;
  readonly targets: readonly ExportTarget[];
  readonly optionsSchema?: JsonSchema;
  /** True when the exporter can resume from a cursor, which lets the host stream very large selections. */
  readonly resumable: boolean;

  export(req: ExportRequest, sink: ExportSink, ctx: HookContext): Promise<ExportSummary>;
}
```

**Guarantees.**

*Ordering.* Only one exporter runs per request — the one the caller selected by id. There is no chain
and no priority. Records reach the exporter in a deterministic order (item `date_added`, then id) so
that exporting the same selection twice produces byte-identical output for formats that are
themselves deterministic; the suite asserts this.

*Error handling.* A throw before the first `sink.write` returns an error response and nothing is
sent. A throw after the first write cannot un-send bytes: the host truncates, records the failure,
and — for a job export — marks the output incomplete and refuses to hand it to the operator as a
finished file. Exporters should therefore validate everything they can before writing.

*Idempotency.* Read-only. Repeat calls with the same request must produce the same bytes.
Resumable exporters must produce the same output when run as `n` cursored calls as in one.

*Timeouts.* 30 s inline. In a job there is no overall ceiling, but the sink must receive a chunk at
least every 60 s or the host declares the exporter stalled and cancels it via `ctx.signal`.

---

## 6.8 `importer`

**What it is for.** Reading a foreign format into library records (CONCEPT.md §6): BibTeX/BibLaTeX,
RIS, EndNote XML, CSL-JSON, JabRef groups, Mendeley exports, PubMed and Embase and Web of Science and
Scopus and Cochrane exports for the SR module, `zotero.sqlite`, Paperless-ngx API dumps, CSV with a
mapping.

**When the host calls it.** `detect` on the first 64 KiB of an uploaded document, for every registered
importer; `parse` in a job, in batches, with the cursor persisted after each one.

```ts
interface DetectSample {
  /** First 64 KiB. Do not ask for more; open the whole document in `parse`. */
  head: Uint8Array;
  filename?: string;
  mediaType?: string;
  byteSize: number;
}

interface DetectVerdict {
  /** 0..1. Highest wins; ties are broken by manifest priority, then plugin name. */
  confidence: number;
  /** Format variant this importer would use, echoed back in the parse request. */
  format?: string;
  reason: string;
}

interface ImportRequest {
  documentId: string;
  bytes: ReadHandle;
  format?: string;
  /** Field mapping and per-importer options, validated against `optionsSchema`. */
  options: JsonObject;
  cursor?: string;
  batchSize: number;
}

interface ImportRecord {
  /** Stable id in the source system. Written to `items.source_id` and makes re-import idempotent (P9). */
  externalId?: string;
  itemType: string;
  fields: Record<string, { value: JsonValue; provenance: Provenance }>;
  creators?: JsonObject[];
  terms?: { scheme: string; code?: string; label: string }[];
  collectionPaths?: string[][];
  tags?: string[];
  notes?: { markdown: string }[];
  annotations?: JsonObject[];
  attachments?: {
    /** One of: a hash already in the library, a path inside the imported bundle, or a URL to fetch. */
    ref: { sha256: Sha256 } | { pathInBundle: string } | { url: string };
    role: 'primary' | 'supplement' | 'snapshot' | 'scan';
    filename?: string;
  }[];
  raw?: JsonValue;
  /** Anything the importer could not map. Aggregated into the verification report. */
  warnings?: string[];
}

interface ImportBatch {
  sourceSystem: string;
  records: ImportRecord[];
  cursor?: string;
  total?: number;
  /** Counted even when no record is produced, so the verification report can reconcile. */
  skipped?: { count: number; reasons: Record<string, number> };
}

interface Importer {
  readonly id: string;
  readonly label: string;
  readonly accepts: { mediaTypes: readonly string[]; fileExtensions: readonly string[] };
  readonly optionsSchema?: JsonSchema;

  detect(sample: DetectSample, ctx: HookContext): Promise<DetectVerdict>;
  parse(req: ImportRequest, ctx: HookContext): Promise<ImportBatch>;
}
```

**Guarantees.**

*Ordering.* `detect` is called for every importer whose `accepts` matches, concurrently; the winner
is the highest confidence above 0.5. `parse` is then called repeatedly on the winner, sequentially,
each call receiving the previous cursor. Records within a batch are applied in order.

*Error handling.* A throw in `detect` counts as confidence 0 and is logged, not surfaced. A throw in
`parse` fails the batch but not the import: the job retries from the last persisted cursor, so a
transient failure costs one batch, not the whole file. A `ValidationError` from `parse` stops the
import and produces a verification report saying at which cursor it stopped and why.

*Idempotency.* This is the one hook where idempotency is a user-visible promise: re-running an
importer over the same file must not duplicate anything. The host deduplicates on
`(sourceSystem, externalId)` against `items.source_system` and `items.source_id`, and on `sha256` for
attachments, so an importer that supplies a stable `externalId` gets safe re-runs for free. An
importer that cannot supply one must say so in its label, because the operator will then be relying
on record dedup instead. The importer never writes: it yields records and the host applies them,
counts them, and produces the verification report that Phase 1 exit depends on.

*Timeouts.* `detect` 5 s, `parse` 120 s per batch. Batch size is chosen by the host from the observed
per-batch duration, starting at 200 records.

---

## 6.9 `graphEdgeProvider`

**What it is for.** Supplying edges for the graph and bibliometrics layer (CONCEPT.md §5.8): citations
from OpenAlex, Crossref or Semantic Scholar; reference lists and in-text citation contexts from owned
PDFs via GROBID; same-as and version-of relations; anything else that connects two nodes with
provenance.

**When the host calls it.** From the local-citation-network build, from derived-network computation,
from deep-dive expansion with a budget, scheduled, and on demand.

```ts
type GraphNodeType = 'item' | 'shadow_work' | 'creator' | 'venue' | 'term' | 'institution';
type GraphEdgeType = 'cites' | 'co_cited' | 'coupled' | 'co_occurs' | 'co_author' | 'same_as' | 'version_of';

type NodeRef =
  | { kind: 'node'; nodeId: string }
  | { kind: 'item'; itemId: string }
  | { kind: 'shadow_work'; shadowWorkId: string }
  | { kind: 'external'; scheme: string; id: string }
  | { kind: 'stub'; stub: WorkStub };

interface EdgeProposal {
  edgeType: GraphEdgeType;
  source: NodeRef;
  target: NodeRef;
  directed: boolean;
  weight?: number;
  /** Mandatory. A batch containing an edge without provenance is rejected whole (P4). */
  provenance: Provenance;
  evidence?: {
    kind: 'citation_context' | 'reference_string' | 'api_record';
    documentId?: string;
    pageIndex?: number;
    textExcerpt?: string;
    intent?: 'background' | 'method' | 'result';
    intentConfidence?: number;
    model?: string;
  }[];
}

interface EdgeRequest {
  seeds: NodeRef[];
  edgeTypes: readonly GraphEdgeType[];
  direction: 'forward' | 'backward' | 'both';
  /** Hard caps. Exceeding any of them invalidates the batch. */
  budget: { maxNodes: number; maxEdges: number; maxUpstreamRequests: number; depth: number };
  cursor?: string;
}

interface EdgeBatch {
  edges: EdgeProposal[];
  /** Targets not yet in the library become ShadowWorks, never Items (CONCEPT.md §5.8). */
  shadowWorks: WorkStub[];
  cursor?: string;
  budgetSpent: { nodes: number; edges: number; upstreamRequests: number; depthReached: number };
  /** Mandatory. Every map in the UI displays this next to itself. */
  coverage: CoverageReport;
}

interface GraphEdgeProvider {
  readonly id: string;
  readonly edgeTypes: readonly GraphEdgeType[];
  readonly nodeTypes: readonly GraphNodeType[];
  readonly direction: 'forward' | 'backward' | 'both';

  provide(req: EdgeRequest, ctx: HookContext): Promise<EdgeBatch>;
  coverage?(req: EdgeRequest, ctx: HookContext): Promise<CoverageReport>;
}
```

**Guarantees.**

*Ordering.* All providers whose `edgeTypes` intersect the request run, concurrently, each with its own
share of the budget. Their batches are merged by the host, which upserts edges on
`(edge_type, source_node, target_node, provenance_source)` — so two providers asserting the same
citation produce one edge with two provenance records, not two edges.

*Error handling.* A throw drops that provider's contribution for the run; the merged result carries a
coverage note naming the provider and the error, and the map shows it. A `BudgetExceededError`, or a
batch whose `budgetSpent` exceeds the request budget, causes the whole batch to be discarded and the
provider to be excluded from the rest of the run: a budget that can be overrun is not a budget.

*Idempotency.* The same request must yield the same edges. Providers never write to the graph and
never promote a ShadowWork to an Item — promotion is always an explicit human action. Re-running an
expansion produces no duplicates because of the upsert key, and `seen_count` on the shadow work is
incremented rather than a second row inserted.

*Timeouts.* 120 s per batch. Deep dives are jobs; a provider that needs longer should return a cursor.

---

## 6.10 `analyticsExport`

**What it is for.** Adding tables to the Parquet analytics bundle produced by
`GET /api/v1/analytics/export` (CONCEPT.md §5.8, ADR-0008), so that a plugin's data reaches R and
Python as columns rather than as paginated JSON.

**When the host calls it.** Whenever an analytics bundle is produced, in batches, inside a single
read snapshot.

```ts
interface AnalyticsColumn {
  name: string;
  type: 'string' | 'int32' | 'int64' | 'float64' | 'bool' | 'date' | 'timestamp' | 'json' | 'list<string>';
  nullable: boolean;
  /** Becomes the column comment in the Parquet schema and the row in the data dictionary. */
  description: string;
}

interface AnalyticsTableSpec {
  /** Must be prefixed with the plugin's short name, e.g. `scicite_intents`. Core names are reserved. */
  name: string;
  description: string;
  columns: AnalyticsColumn[];
  primaryKey?: string[];
  partitionBy?: string[];
}

interface AnalyticsRequest {
  table: string;
  /** Opaque snapshot id. Every batch of every table in one bundle shares it. */
  snapshotId: string;
  filter?: { collectionId?: string; savedSearchId?: string; reviewId?: string; since?: Timestamp };
  cursor?: string;
  batchRows: number;
}

interface AnalyticsBatch {
  table: string;
  /** Exactly the spec's column names, in the spec's order. */
  columns: string[];
  rows: JsonValue[][];
  cursor?: string;
  rowCount: number;
}

interface AnalyticsExport {
  readonly id: string;
  readonly tables: readonly AnalyticsTableSpec[];
  produce(req: AnalyticsRequest, ctx: HookContext): Promise<AnalyticsBatch>;
}
```

**Guarantees.**

*Ordering.* Tables are produced in the order the host chooses; within a table, batches are sequential
and cursored. Row order within a table must be deterministic — the primary key ascending, by default
— so that two exports of an unchanged library produce identical files and a diff means something.

*Error handling.* A throw excludes that table from the bundle, with a note in the bundle's manifest
and a warning on the response; the rest of the bundle is still produced, because an analytics export
that fails wholesale over one optional table is useless. Column-count or column-order mismatch against
the spec is a `ValidationError` and is treated the same way.

*Idempotency.* Read-only. The `snapshotId` guarantees every batch sees the same database state, so
batches cannot straddle a concurrent write. Repeating a request with the same snapshot and cursor must
return the same rows. Table names collide at the plugin's peril: the core names (`works`, `creators`,
`works_creators`, `terms`, `works_terms`, `edges`, `metrics`, `sr_*`) are reserved and a plugin
claiming one fails validation at activation.

*Timeouts.* 60 s per batch. The host adapts `batchRows` from observed durations, starting at 10 000.

---

## 6.11 `srTemplate`

**What it is for.** Supplying instruments to the systematic-review module (CONCEPT.md §5.10):
extraction-form templates for RCT, observational and diagnostic designs; risk-of-bias instruments
(RoB 2, ROBINS-I, Newcastle-Ottawa, QUADAS-2); search-strategy templates; report templates.

**When the host calls it.** When a reviewer picks a template at extraction-form creation or at the
start of a risk-of-bias assessment; when signalling answers change and a domain judgement is derived;
and when an instrument version changes and existing values must be migrated.

```ts
interface InstrumentDefinition {
  id: string;
  version: string;
  title: string;
  /** The published instrument this implements, as a citation string. Frozen with the assessment. */
  citation?: string;
  /** The form or questionnaire itself. Rendered by the host; the plugin does not draw it. */
  schema: JsonSchema;
  /** Arms, outcomes, timepoints — the parts of an extraction form that repeat. */
  repeatableGroups?: { id: string; title: string; schema: JsonSchema; minItems?: number; maxItems?: number }[];
  /** For risk-of-bias instruments: the domains judgements are reported against. */
  domains?: { id: string; title: string; signallingQuestions: string[] }[];
  /** `deterministic` means `derive` implements the published algorithm; `none` means judgement is manual. */
  algorithm: 'none' | 'deterministic';
}

interface DerivedJudgement {
  domainJudgements: Record<string, string>;
  overallJudgement?: string;
  /** Which rule produced which judgement. Recorded so a reader can check the tool's reasoning. */
  basis: { domainId: string; rule: string; answers: string[] }[];
  /** Present only when the algorithm is genuinely probabilistic. Deterministic instruments omit it. */
  confidence?: number;
}

interface SrTemplate {
  readonly id: string;
  readonly kind: 'extraction_form' | 'rob_instrument' | 'search_strategy' | 'report';
  readonly title: string;
  readonly templateIds: readonly string[];

  instrument(req: { templateId: string; locale?: string }, ctx: HookContext): Promise<InstrumentDefinition>;
  derive?(req: { templateId: string; answers: JsonObject }, ctx: HookContext): Promise<DerivedJudgement>;
  migrate?(
    req: { from: InstrumentDefinition; to: InstrumentDefinition; values: JsonObject },
    ctx: HookContext,
  ): Promise<{ values: JsonObject; unmapped: string[]; requiresReview: boolean }>;
}
```

**Guarantees.**

*Ordering.* No chain. A template is selected explicitly by id, and only that template is called.

*Error handling.* A throw from `instrument` makes the template unavailable, with the error shown in
the picker; no half-built form is ever created. A throw from `derive` leaves the domain judgement
unset and the reviewer fills it in by hand — the review is never blocked by a plugin. A throw from
`migrate` leaves the existing values untouched and routes the assessment to review.

*Idempotency.* `instrument` must be a pure function of `(templateId, version, locale)`. The returned
definition is **frozen** into `extraction_forms.schema_json` or `rob_assessments.instrument` at the
moment of use, so the plugin may change or withdraw a template later without rewriting history — and
so an assessment made in 2026 still reports the instrument it was actually made with. `derive` must be
deterministic and must be able to explain itself through `basis`; a template whose `algorithm` is
`deterministic` and whose `derive` is not is a defect the suite catches by replaying answer sets.

*Automation disclosure.* A template never writes a judgement. It returns a derivation and the host
records it. When the review has automation disclosure enabled (ADR-0020), the host writes the stanza
alongside: `assistance` is `suggestion_shown` when the reviewer has not yet accepted the derived
value and `suggestion_accepted` when they save it unchanged, `agent` is the plugin name and version,
`basis` is the instrument id and version, `confirmed_by_human` reflects whether a person saw it. A
screening panel contributed by the same plugin that marks `influencesDecisions: true` in its manifest
is refused a write without a stanza.

*Timeouts.* 10 s. Instruments are documents, not computations.

---

# 7. Lifecycle events

Twelve events, delivered after the transaction that caused them has committed.

## 7.1 The envelope

```ts
interface EventEnvelope<T = JsonObject> {
  /** ULID. The idempotency key for handlers: the same envelope may arrive twice. */
  id: Ulid;
  type: LifecycleEventType;
  occurredAt: Timestamp;
  /** Monotonic within an install, persisted, continues across restarts. Use it to order, not `occurredAt`. */
  sequence: number;
  actor: Actor;
  /** Correlates every event caused by one API request. */
  requestId?: string;
  /** The envelope id of the event whose handler caused this one, when there is one. */
  causationId?: Ulid;
  payload: T;
}

type LifecycleEventType =
  | 'item.created' | 'item.updated' | 'item.merged' | 'item.trashed' | 'item.restored'
  | 'document.ingested' | 'attachment.added' | 'annotation.created'
  | 'check.completed'
  | 'job.started' | 'job.finished' | 'job.failed';

type EventHandler<T = JsonObject> = (envelope: EventEnvelope<T>, ctx: HookContext) => Promise<void>;
```

## 7.2 Delivery guarantees

*Ordering.* Events are delivered in `sequence` order per entity. Across entities the host makes no
promise, because handlers run concurrently. A handler that needs a global order should sort by
`sequence`, never by `occurredAt`, which has clock resolution and can tie.

*At-least-once.* An event may be delivered more than once — after a crash between the handler running
and its completion being recorded, most obviously. Every handler must be idempotent keyed by
`envelope.id`. The SDK offers `ctx.events.once(envelope.id, fn)` which records completion in the same
transaction as the handler's own writes, for handlers that cannot make themselves naturally idempotent.

*Post-commit.* Nothing a handler does can prevent or roll back the change that produced the event. A
throw from an `async` handler is retried with the standard backoff, six attempts, then dead-lettered
into the job table and shown against the plugin in the plugin list. A throw from a `blocking` handler
is logged and swallowed — the request has already committed and will still succeed.

*Blocking mode is a budget, not a promise.* All `blocking` handlers for one event share 2 s. When the
budget is exhausted the remaining handlers are demoted to `async` for that event and a warning is
logged. Use `blocking` only when the API response would be wrong without the handler having run.

*No replay.* A plugin enabled today receives events from today. There is no history replay in v1; a
plugin that needs to catch up reads the API. `sequence` makes that a well-defined operation: record
the highest sequence you have handled, backfill, resume.

*Cycles.* Events emitted by handlers carry `causationId`. The host refuses to emit an event at
causation depth greater than 8 and logs the chain, so a plugin that updates an item in response to
`item.updated` fails loudly rather than looping.

*Redaction.* Payloads carry no secrets and no attachment bytes. Settings values marked
`x-recueil-secret` never appear. Job `params` are redacted with the same rules as the job API.

## 7.3 Payloads

### `item.created`

Fires once per Item, after commit, whatever created it.

```ts
interface ItemCreatedPayload {
  itemId: string;
  publicId: string;          // 8-char Zotero-compatible key
  itemType: string;
  title?: string;
  collectionIds: string[];
  tags: string[];
  identifiers: Identifier[];
  citationKey?: string;
  createdVia: 'ui' | 'api' | 'mcp' | 'cli' | 'connector' | 'ingest' | 'import' | 'plugin' | 'promotion';
  sourceSystem?: string;     // e.g. `zotero`, `paperless`, `bibtex`
  sourceId?: string;
  promotedFromShadowWorkId?: string;
  dateAdded: Timestamp;
}
```

### `item.updated`

Fires once per committed update, however many fields changed. Field-level enrichment runs are
coalesced into one event per transaction, not one per field.

```ts
interface ItemUpdatedPayload {
  itemId: string;
  publicId: string;
  itemType: string;
  version: number;           // post-update
  changedFields: string[];   // dotted paths
  before: JsonObject;        // changed fields only
  after: JsonObject;         // changed fields only
  /** Fields the user has locked against overwriting; a plugin must not propose changes to these. */
  lockedFields: string[];
  provenance: Provenance[];  // one per changed field, when the change was derived
}
```

### `item.merged`

Fires once per merge, after the merge record is written. The losers are in the trash and the merge is
reversible (P5, CONCEPT.md §5.6).

```ts
interface ItemMergedPayload {
  winnerItemId: string;
  loserItemIds: string[];
  mergeRecordId: string;
  strategy: 'newest' | 'most_complete' | 'manual' | 'rule';
  ruleIds: string[];         // dedup rules that voted for the merge
  score?: number;
  movedAttachmentIds: string[];
  movedNoteIds: string[];
  unionedCollectionIds: string[];
  unionedTags: string[];
  reversible: true;
}
```

### `item.trashed`

```ts
interface ItemTrashedPayload {
  itemId: string;
  publicId: string;
  trashedAt: Timestamp;
  reason?: string;
  /** What went to the trash with it. Nothing is deleted (P5); expiry is a separate, later event on documents. */
  cascade: { attachmentIds: string[]; noteIds: string[]; annotationIds: string[] };
}
```

### `item.restored`

```ts
interface ItemRestoredPayload {
  itemId: string;
  publicId: string;
  restoredAt: Timestamp;
  restoredFrom: 'trash' | 'merge';
  /** Present when the restore was an un-merge. */
  mergeRecordId?: string;
  cascade: { attachmentIds: string[]; noteIds: string[]; annotationIds: string[] };
}
```

### `document.ingested`

Fires once per Document that reaches commit at pipeline stage 10, including when the pipeline stopped
at stage 2 because the hash already existed — with `duplicateOfDocumentId` set and no new bytes
stored. This is the event for side effects that ingest stages are forbidden from having.

```ts
interface DocumentIngestedPayload {
  documentId: string;
  sha256: Sha256;
  mediaType: string;
  byteSize: number;
  storageBackend: string;
  storageKey: string;
  hasTextLayer: boolean;
  ocrApplied: boolean;
  source: { kind: string; ref?: IngestRef; path?: string; metadata?: JsonObject };
  /** Set when stage 2 matched an existing Document; no new bytes were written. */
  duplicateOfDocumentId?: string;
  itemIds: string[];         // items this document was attached to, may be empty
  pipelineRunId: string;
  stagesRun: string[];
  confidence: number;
  /** Set when the confidence gate at stage 9 routed it for review instead of auto-accepting (P3). */
  reviewQueueEntryId?: string;
}
```

### `attachment.added`

```ts
interface AttachmentAddedPayload {
  attachmentId: string;
  itemId: string;
  documentId?: string;       // absent for linked_url
  role: 'primary' | 'supplement' | 'snapshot' | 'scan';
  linkMode: 'stored' | 'linked_file' | 'linked_url';
  url?: string;
  filename?: string;
  position: number;
  addedVia: 'ui' | 'api' | 'mcp' | 'connector' | 'ingest' | 'import' | 'plugin';
}
```

### `annotation.created`

```ts
interface AnnotationCreatedPayload {
  annotationId: string;
  publicId: string;
  documentId: string;
  itemId?: string;
  annotationType: 'highlight' | 'note' | 'area' | 'ink';
  motivation: string;        // W3C motivation (ADR-0009, ADR-0017)
  pageIndex?: number;
  colour?: string;
  authorUserId?: string;
  /** True when extracted from embedded PDF annotations rather than made in the reader. */
  isExternal: boolean;
  hasQuotedText: boolean;
  hasBodyText: boolean;
  /** The selector set is not in the payload; fetch it if you need it. */
  selectorTypes: string[];
}
```

### `check.completed`

Fires once per **run**, not once per result. A run is one invocation of the checks engine over a
scope; a library-wide run over 20 000 items emits one event, and the results are fetched by `runId`.

```ts
interface CheckCompletedPayload {
  runId: string;
  /** Absent for a run of the whole check set. */
  checkIds?: string[];
  mode: 'on_import' | 'on_demand' | 'scheduled' | 'audit';
  scope: { itemIds?: string[]; collectionId?: string; savedSearchId?: string; auditDocumentId?: string };
  subjectCount: number;
  counts: { pass: number; fail: number; warn: number; skipped: number };
  worstSeverity: 'info' | 'warning' | 'error' | 'none';
  autoFixesApplied: number;
  reviewQueueEntriesRaised: number;
  durationMs: number;
  /** Set when the run produced a stored report document (CSV or Markdown). */
  reportDocumentId?: string;
}
```

### `job.started`

```ts
interface JobStartedPayload {
  jobId: string;
  jobType: string;
  idempotencyKey?: string;
  params: JsonObject;        // redacted
  attempt: number;
  priority: number;
  parentJobId?: string;
  pluginName?: string;       // set when a plugin scheduled it
  startedAt: Timestamp;
}
```

### `job.finished`

```ts
interface JobFinishedPayload {
  jobId: string;
  jobType: string;
  state: 'succeeded' | 'cancelled';
  attempt: number;
  durationMs: number;
  /** Job-type-specific summary: records processed, edges written, bytes exported. Redacted. */
  result: JsonObject;
  parentJobId?: string;
  pluginName?: string;
  finishedAt: Timestamp;
}
```

### `job.failed`

```ts
interface JobFailedPayload {
  jobId: string;
  jobType: string;
  /** `failed` means it will be retried; `dead` means it will not. */
  state: 'failed' | 'dead';
  attempt: number;
  willRetry: boolean;
  nextRunAfter?: Timestamp;
  error: { code: string; message: string; retryable: boolean; userMessage?: string };
  parentJobId?: string;
  pluginName?: string;
  failedAt: Timestamp;
}
```

---

## 8. What is deliberately not in v1

Stated so that nobody designs around an absence and assumes it is an oversight.

- **No UI hooks in this catalogue.** UI extension is declarative, through `contributes` in the
  manifest; there is no imperative UI registration API.
- **No pre-commit veto events.** If you need to stop something happening, use the hook for that
  workflow. Events are notifications.
- **No event replay or backfill.** §7.2.
- **No cross-plugin calls.** A plugin cannot invoke another plugin's hook. Shared behaviour goes in a
  shared npm package or a resolver both can call.
- **No custom item types or custom entity tables from plugins.** Item types and custom fields are
  configuration, reachable through the API; a plugin may create them, but it cannot add a table.
  Analytics tables (§6.10) are the one exception, and they are export-only.
- **No scheduling primitives beyond `ctx.jobs`.** A plugin that wants a cron writes a job with
  `run_after` and reschedules itself on completion.
