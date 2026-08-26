# Hardening round — August 2026

| | |
|---|---|
| Status | H1–H5 closed; H6 carried. See [Status](#status) below |
| Opened | 2026-08-26 |
| Audited | 2026-08-26 |
| Trigger | The Phase 2 adversarial review, which returned 8 critical, 8 major and 5 minor findings, every one reproduced by a runnable script |
| Position | Between Phase 2 and Phase 3 of CONCEPT.md §7. Phase 3 does not start until H1–H4 are closed |
| Governs | ADR-0021 (a verification check queries both sides), ADR-0022 (resource budgets on untrusted input) |

## Why this round exists

Phase 2 shipped 2190 passing tests and a green M2 rehearsal. Every defect below was found by agents
instructed to refute the code, not by the suite. That asymmetry is the reason the adversarial stage
stays in every remaining phase, and the reason this round is a gate rather than a backlog.

Phase 3 adds resolvers that fetch third-party data, a checks engine and a dedup engine that merges
records. All three build directly on ingestion. Building them over a pipeline that can delete a
file it never read is the wrong order of work.

## Principles this round establishes

Two findings recurred across independent agents, which makes them design faults rather than
mistakes. Both are now ADRs and both are binding on later phases.

- **ADR-0021** — a verification check queries both sides, and ships with a test proving it can fail.
  Three separate reports independently compared the source against the importer's own narration.
- **ADR-0022** — every path that decompresses, parses or pattern-matches untrusted input runs under
  an explicit budget enforced by the call. The rule engine had a regex timeout; the mail path,
  written from a different brief, did not.

## Workstreams

Ordered by severity. H1–H4 are blocking; H5 and H6 close before Phase 3 exits.

### H1 — Source acknowledgement and reads (data loss)

| Defect | File |
|---|---|
| `acknowledge` deletes or moves without comparing `ref.revision` to the file now on disk, so a file replaced during ingestion is destroyed unread | `packages/ingest-sources/src/folder/source.ts` |
| Same defect at network distance, where the window is a whole poll interval; `WebDavClient.delete` sends no `If`/`If-Match` precondition | `packages/ingest-sources/src/webdav/source.ts`, `webdav/client.ts` |
| `fetch` never re-checks size after `readFile`, which returns short data without error, so a file truncated mid-read is hashed and filed as a document in its own right | `packages/ingest-sources/src/folder/source.ts` |

**Fix.** Consume is conditional on the revision the candidate was offered under: re-stat (or
re-HEAD) immediately before the destructive operation, compare size, mtime and inode — ETag for
WebDAV — and refuse when it differs, routing to review with the reason. WebDAV deletes carry
`If-Match`. Reads verify the byte count against the stat that authorised them and re-read or refuse
on mismatch. The digest the pipeline committed is the thing acknowledged, not the path.

**Acceptance.** A test that replaces the file between ingestion and acknowledgement and asserts the
replacement survives. A test that truncates during the read and asserts refusal, not a short
document. Both must fail with the fix reverted.

### H2 — Resource budgets (denial of service)

| Defect | File |
|---|---|
| Zip limits computed from the attacker-declared `uncompressedSize`; `inflateRawSync` called with no `maxOutputLength` | `packages/ingest/src/archive/zip.ts` |
| PDF stream inflation with no per-stream, accumulated or wall-clock budget; synchronous on the loop | `packages/ingest/src/text/pdf-text.ts` |
| Mail rules compile to native `RegExp` with no timeout; a 33-character `Subject:` costs 45 s | `packages/ingest-sources/src/imap/rules.ts` |

**Fix.** Per ADR-0022. Declared sizes inform rejection but never bound; `maxOutputLength` on every
inflate; per-member, per-container, depth and wall-clock budgets that compose and are inherited by
nested containers; the rule engine's existing bounded matcher reused on the mail path rather than a
second implementation. Exceeding a budget is a review outcome under P3, not a crash.

**Acceptance.** The three reproduction scripts from the review, committed as tests, each asserting a
clean bounded refusal that names the limit. A memory ceiling assertion on the PDF case.

### H3 — Pipeline concurrency and its verification

| Defect | File |
|---|---|
| Stage 2's duplicate check and stage 10's commit are separated by every awaited stage with no lock, so at the shipped concurrency the same digest files twice | `packages/ingest/src/pipeline.ts` |
| `verify()` cannot detect it: three one-sided inequalities and a counter derived by subtraction that goes negative | `packages/ingest/src/pipeline.ts` |

**Fix.** Serialise on the digest — an in-flight set keyed by sha256 with the commit inside the same
critical section, or a unique constraint the commit relies on and handles. `verify()` rebuilt under
ADR-0021: both sides queried, equality asserted, no derived counter permitted to go negative.

**Acceptance.** A concurrency test that files the same bytes from N workers and asserts exactly one
document and one attachment. A falsification test that injects a double-file and asserts `verify()`
FAILS.

### H4 — Server attack surface

| Defect | File |
|---|---|
| Document content served with an attacker-chosen extension as `text/html`, same-origin | `apps/server/src/routes/documents.ts` |
| Source URL unrestricted by host or address range; reached loopback metadata endpoints | `apps/server/src/ingestion/sources.ts` |
| URL userinfo credentials stored in cleartext in `ingestion_sources.config` and echoed back by the API | `packages/ingest-sources/src/webdav/client.ts` |

**Fix.** Serve stored documents from a sandboxed disposition — `Content-Disposition: attachment`,
`X-Content-Type-Options: nosniff`, a restrictive `Content-Security-Policy`, and an allow-list of
inline-renderable types that excludes HTML and SVG. Validate source URLs against a blocklist of
loopback, link-local, multicast and private ranges, resolved at connection time rather than parse
time, with an operator opt-in for deliberately internal targets. Strip userinfo on ingress, move the
secret to the credential store, and never return it.

**Acceptance.** The three proof-of-concept scripts committed as tests. A DNS-rebinding case for the
SSRF fix. An assertion that no source response body contains the secret.

### H5 — Report checks (ADR-0021 audit)

| Defect | File |
|---|---|
| `tag_assignments_carried` and `custom_field_values_carried` add importer-narrated `skipped` counts to the target side | `packages/import-paperless/src/report/build.ts` |
| `custom_field_values_carried` buckets both sides through the importer's own plan, so an empty plan passes | `packages/import-paperless/src/report/build.ts` |
| Job state derived from `counts.review` rather than the `review_queue` itself, so blocker entries are uncounted | `packages/ingest/src/pipeline.ts` |
| Re-import throws `ConflictError` on an item trashed since the previous run | `packages/import-paperless/src/import.ts` |

**Fix.** Every blocking check in every report audited against ADR-0021 and rewritten as a query
against both sides, with a falsification test each. The Zotero report was fixed in the previous
round and is re-audited to confirm the fix held.

**Acceptance.** For each blocking check, a test that mutates the target and asserts failure. The
idempotence case: re-import over trashed items completes and reports them.

### H6 — Carried gaps (not defects, still open)

Recorded so they are not silently dropped. None blocks Phase 3.

- OCR is decided per document, not per page, so a born-digital file with one scanned page is never
  OCRed. Real, user-visible, and the fix belongs with the OCR work.
- `OcrMyPdfEngine` and `GrobidExtractor` have never run against real OCRmyPDF or GROBID.
- WebDAV, S3, IMAP have only ever met in-process fakes, never Nextcloud, MinIO or a real mailbox.
- `item_tags.rule_ref` is documented but never written; a source's compiled stage-8 rules are not
  wired into the server's pipeline (latent, the CLI path is correct).
- The Paperless client models API v10 (3.x) while the committed corpus declares 2.14.7 / API 6.
- `deploy/` has never been executed — no Docker in the build environment.
- `pnpm lint` is a green no-op; no linter is installed, so CI's lint job passes vacuously.
- translation-server integration, `recueil token` and `recueil job` remain unimplemented Phase 1
  bullets.
- `docs/` retains aspirational material — api.qmd's MCP and analytics sections, plugins.qmd in
  full — carrying phase callouts but written as description.

Added by the audit of 2026-08-26. The first three are the Phase 2 MINORs no workstream claimed; each
was re-attacked and still reproduces. The last two are new observations from the audit itself.

- `ScratchManager` makes a fresh `mkdtemp` root per run and nothing sweeps abandoned roots at
  start-up, so a hard kill leaks one directory per crashed run. `apps/server/src/health.ts` reports
  the *storage* backend's stray `.part` files and knows nothing about ingest scratch. The fix is a
  sweep with a caller, and it belongs with whoever next owns `scratch.ts`.
- `parseEmail(raw)` takes no limits argument and decodes every part of the MIME tree in full before
  `extractEmail` makes its first size comparison, so the module header's "every part is bounded by
  the caller's limits before it is decoded" is the reverse of what happens. ADR-0022 §2 applies and
  this is the one ingestion path still outside it. `decodeQuotedPrintable` accumulating into a
  `number[]` — roughly eight bytes per decoded byte — is the same fix.
- `restoreItem` un-trashes an item and clears `item_office.item_trashed_at` without first checking
  whether the ASN it is bringing back is already held by a live item. The partial unique index
  catches it, so nothing is corrupted, but the caller gets `SqliteError: UNIQUE constraint failed:
  item_office.asn` where every other trash refusal gives a `ConflictError` naming the obstacle.
- The ingest budgets are configuration in the sense ADR-0022 asks for — `DEFAULT_INGEST_CONFIG` and
  `DEFAULT_PDF_BUDGET`, both overridable by a caller — but the *server* surfaces none of them as an
  environment variable, so the operator with a legitimate 900 MB scan the ADR names cannot raise them
  without a code change. `RECUEIL_MAX_UPLOAD_BYTES` and `RECUEIL_INGEST_CONFIDENCE_THRESHOLD` are the
  only ingest numbers an operator can reach.
- A budget refusal reaches the review queue with a purpose-built `resource_budget_exceeded` reason
  code, and the run continues — ADR-0022 §6 holds. But it arrives there through the generic retry
  path: the candidate's outcome is `failed`, the job's state is `failed` rather than
  `waiting_review`, and three attempts are spent on a refusal that is deterministic. A hostile
  attachment therefore turns an otherwise clean run red. Verified against the real pipeline: one
  over-budget PDF and one ordinary one gave `{"ingested":1,"failed":1}`, `job state: failed`, and one
  open blocker entry.

## Exit criteria

1. Every H1–H4 defect reproduced, fixed, and guarded by a regression test verified to fail with the
   fix reverted.
2. Every blocking check in every report has a falsification test (ADR-0021).
3. The three adversarial lenses from Phase 2 re-run against the fixed code and no longer reproduce
   any critical or major finding — re-attacked, not merely re-asserted.
4. The workspace builds, the full suite passes, and the M2 rehearsal still holds.

## Status

Audited on 2026-08-26 by re-running the reproductions and, for every H1–H5 defect, by reverting the
fix in the working tree and watching the named regression test go red. A test nobody has watched
fail is not a regression test, so the third column below is the evidence and not a claim about
intent: it names what went red, with the fix out.

### H1 — Source acknowledgement and reads — **closed**

| Defect | Closed by | Watched fail |
|---|---|---|
| `acknowledge` deletes or moves without comparing `ref.revision` | `stillTheFileThatWasRead` before the destructive call, plus a second look with no `await` between it and the call; refusal routes to review as `source_changed_before_consume` | 4 tests in `folder.test.ts` › "when the original changes under the acknowledgement (H1)" — including the replayed acknowledgement after a crash, and a file whose bytes changed without its size or mtime doing so |
| WebDAV: same defect, no `If`/`If-Match` on the delete | ETag compared against a fresh `HEAD`, and the ETag sent as `If-Match` on both `DELETE` and `MOVE`, so the share gets the last word; a 412 is a refusal, not an error | 8 tests in `webdav.test.ts` › "when the object changes under the acknowledgement (H1)", covering the no-ETag share, the share that ignores `If-Match`, and a ref carrying no revision at all |
| `fetch` never re-checks size after `readFile` | Byte count compared against the authorising `stat`, a second `stat` after the read, and a bounded retry before a `source_truncated` refusal | 2 tests in `folder.test.ts` › "when the read comes back short (H1)" |

One note for whoever touches this next: the `bytes.byteLength !== before.size` comparison is not on
its own load-bearing under either test — truncating a file moves its mtime, so the post-read `stat`
catches it first. The post-read verification *block* is load-bearing; removing it puts both tests
red. The size comparison stays because it is the one check that does not depend on a timestamp
having moved.

### H2 — Resource budgets — **closed**

| Defect | Closed by | Watched fail |
|---|---|---|
| Zip limits computed from the declared `uncompressedSize`; no `maxOutputLength` | `maxOutputLength` on every `inflateRawSync`, set to the smaller of `maxArchiveEntryBytes` and what the container's `BudgetLedger` has left; declared sizes may only refuse earlier, never later | `budgets.test.ts` › "refuses a member that inflates past its allowance, and names the limit", which also asserts a memory ceiling |
| PDF stream inflation with no budget | `DEFAULT_PDF_BUDGET` — per-stream, accumulated, stream count, input size and a wall clock — enforced on the call | same file › "refuses a 300 MB stream from a 300 KB file, names the limit, and stays under a ceiling" |
| Mail rules compile to native `RegExp` | `@recueil/rules`' `safeRegex` on the mail path, with a step budget and a clock; a clause that runs out of budget does not match and is recorded in `refusals` | `mail-rule-budget.test.ts` — with the native `RegExp` put back, the runner does not fail, it *hangs*, which is the finding |

Re-attacked directly at the shipped defaults: a 3.1 MB archive declaring 1024 bytes and really
holding 3 GiB is stopped at the 512 MiB `maxArchiveEntryBytes` ceiling, growing 514 MB and refusing
in 350 ms with the limit named. A payload *under* that ceiling is still allowed to materialise —
that is what the operator's own budget says, not a defect — which is why the number is worth knowing.

### H3 — Pipeline concurrency and its verification — **closed**

| Defect | Closed by | Watched fail |
|---|---|---|
| Stage 2's duplicate check and stage 10's commit separated by every awaited stage | A digest gate held across stages 2–10, per pipeline instance so two runs sharing one instance serialise too, with a lock timeout that is itself a budget (ADR-0022) | `concurrency.test.ts` › "files exactly one document, one item and one attachment" |
| `verify()` cannot detect it | Rebuilt under ADR-0021: equalities where equality is meant, the two remaining inequalities carrying a comment naming the failing direction, and `documentsWithoutAttachment` counted rather than subtracted so it cannot go negative | 7 falsification tests in `concurrency.test.ts` › "verify(), handed a library that contradicts the run"; putting `>=` back on `documents_filed_once` reds "FAILS when the run's own item acquires a second attachment behind its back" |

### H4 — Server attack surface — **closed**

| Defect | Closed by | Watched fail |
|---|---|---|
| Document content served as attacker-chosen `text/html`, same-origin | An inline allow-list that excludes HTML, XHTML, SVG and XML; everything off it is `application/octet-stream` + `attachment` + `sandbox`; `nosniff`, a restrictive CSP and `X-Frame-Options` on every response | 4 tests in `documents.test.ts` › "the content route serves stored bytes from a sandbox", including the two that prove a PDF and an image still render inline |
| Source URL unrestricted by host or address range | `EgressGuard`: loopback, link-local, private, unique-local and multicast refused at *connection* time as well as at the form, with `RECUEIL_INGEST_ALLOW_PRIVATE_TARGETS` as the operator opt-in | 7 tests across `egress.test.ts` and `ingestion.test.ts`, including the DNS-rebinding case the acceptance asked for |
| URL userinfo stored in cleartext and echoed back | `splitUserinfo` on ingress: the credential moves into the `SecretBox` and the stripped URL is the only one stored, logged or interpolated into an error | 6 tests in `webdav.test.ts` › "WebDavClient credentials in the URL (H4)" |

Re-attacked through the real application: the review's `xss.mjs`, `ssrf.mjs` and `ssrf2.mjs` payloads
now give `content-type: application/octet-stream`, `content-disposition: attachment`, `nosniff` and a
CSP; a `422` naming the loopback range with nothing sent to the internal service; and no occurrence
of the password in the create response, the stored `ingestion_sources.config` or the list response.

### H5 — Report checks — **closed**

| Defect | Closed by | Watched fail |
|---|---|---|
| `tag_assignments_carried` / `custom_field_values_carried` add narrated `skipped` counts | Both sides queried, `equals` rather than `at-least`, and the source-side exclusion (`tag_references_resolvable`) promoted to a blocking check of its own rather than subtracted | `report-checks.test.ts` › "stays red however many skipped records the job log claims", and the structural rule "uses no inequality in a blocking check" |
| `custom_field_values_carried` buckets both sides through the importer's plan | The carryable set recomputed from `DATA_TYPE_MAP` against the raw `data_type`, never read off `plan.customFieldPlans` | same file › "fails when /api/custom_fields/ answers empty and the documents still carry values" |
| Job state derived from `counts.review` | Derived from `review_queue` itself, so entries raised inside `commitProposal` and by `ingestWithRetries` are counted | 2 tests in `concurrency.test.ts` › "a run that left work for a person" |
| Re-import throws `ConflictError` on a trashed item | `leaveTrashedItemAlone`: the document is skipped whole, the item is neither written to nor restored, and it becomes a review entry naming the item | 4 tests in `trashed-reimport.test.ts` |

`report-checks.test.ts` enforces the ADR-0021 rule structurally: `FALSIFIED` lists every blocking
check with a falsification test, and the first test in the file asserts that set is exactly the set of
blocking checks a real run emits — so a check added without one turns the suite red naming it. The
Zotero report was re-audited and its Phase 1 fix held: its falsification tests still fail on a
mutated target, including the group-library case.

### Findings the workstreams did not claim

The Phase 2 lenses returned findings that no H1–H5 table listed. They were re-attacked with the rest.

| Finding | State |
|---|---|
| **[MAJOR]** `archive/extract.ts` — two entries whose names normalise to one path overwrite each other in scratch | **Closed in this round.** It still reproduced after the workstreams finished: `./invoice.pdf` and `invoice.pdf` gave two members, one digest, an empty `skipped` and a satisfied verification, with member A's bytes gone. A member whose relative path is already taken now gets a positional directory of its own — which is what the `.eml` path has always done — and the prefix is applied only on a collision, so an ordinary archive's `<container>!/<member>` external id is unchanged. Guarded by `archive.test.ts` › "keeps two members whose names normalise to the same path", watched red with the fix out |
| **[MINOR]** `folder/source.ts` — a nested consume destination excludes its whole parent tree | Closed. `folder.test.ts` › "excludes a nested processed directory without hiding its parent tree" |
| **[MINOR]** `routes/documents.ts` — CR/LF in `original_filename` escapes the problem formatter | Closed. `documents.test.ts` › "serves a document whose filename carries CR and LF"; control characters are stripped and both the quoted and RFC 5987 forms are sent |
| **[MINOR]** `scratch.ts` — nothing sweeps an abandoned scratch root at start-up | **Open.** `ScratchManager` still exposes no sweep — `dispose`, `ensureRoot`, `isEmpty`, `outstanding`, `rootPath`, `with` — and has no caller at start-up. Carried into H6 |
| **[MINOR]** `archive/eml.ts` — `parseEmail` takes no limits and decodes every part before any size check | **Open.** `parseEmail(raw: Buffer)` is unchanged. Carried into H6 |
| **[MINOR]** `services/library.ts` — `restoreItem` returns a raw `SqliteError` on an ASN collision | **Open.** Reproduced again: `restore threw: SqliteError: UNIQUE constraint failed: item_office.asn` where every other trash refusal gives a `ConflictError`. No corruption — the partial unique index holds — but the caller cannot tell it from an internal fault. Carried into H6 |

### Build, suite and M2

- `pnpm -r build` clean. `pnpm -r test` clean: **2 316 tests** across the twelve packages and apps
  that have them, none skipped, none weakened.
- The **M2 rehearsal still holds**, re-run against the fixed code:
  - a folder source created over `POST /api/v1/ingestion/sources`, `fixtures/scans/*.pdf` dropped
    in, `recueil ingest watch --once`: 6 offered, 6 ingested, 0 to review, 6 acknowledged, 0 refused
    acknowledgements; the library holds 6 documents and 6 items, all under `source_kind = scanner`;
    each of the six is found again through `GET /search` by a word only its own text layer or its own
    recognised text carries, and each hit resolves to exactly the item made from that file;
  - the same run under `consume: delete` empties the watched folder and refuses nothing, so H1's
    conditional consume does not stand in the happy path's way;
  - all eight `fixtures/mail/*.eml` through an in-process IMAP server: attachments as documents,
    bodies as notes, the forwarded message descended into, the traversal message refused whole;
  - the Paperless fake at parity: `pass: true`, 11 of 11 documents matched with nothing missing,
    orphaned or mistyped, 15 blocking checks all green, 90.9 % original hash coverage with the one
    unfetchable original explained in a review entry — the single non-passing check is the
    informational `original_hash_coverage`, which is the corpus's deliberate fault;
  - LocalFs, WebDAV and S3 each pass all 16 conformance cases.

### What remains before Phase 3

Exit criteria 1, 2 and 4 are met. Criterion 3 is met **as of this audit** — no critical or major
finding from the three lenses reproduces — but it was not met when the workstreams finished, because
the `archive/extract.ts` collision belonged to no table. The lesson is the same one ADR-0021 records
in a different register: a finding that is not assigned is a finding nobody re-runs. The next round
takes its workstream tables from the findings file rather than the other way round.
