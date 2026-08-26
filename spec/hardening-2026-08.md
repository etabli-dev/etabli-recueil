# Hardening round — August 2026

| | |
|---|---|
| Status | In progress |
| Opened | 2026-08-26 |
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

## Exit criteria

1. Every H1–H4 defect reproduced, fixed, and guarded by a regression test verified to fail with the
   fix reverted.
2. Every blocking check in every report has a falsification test (ADR-0021).
3. The three adversarial lenses from Phase 2 re-run against the fixed code and no longer reproduce
   any critical or major finding — re-attacked, not merely re-asserted.
4. The workspace builds, the full suite passes, and the M2 rehearsal still holds.
