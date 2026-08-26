# Hardening re-attack findings (verbatim)

The three Phase 2 adversarial lenses, re-run against the fixed code. `Still reproducing` lists earlier findings the hardening round did not close.


## Lens

Adversarial re-attack: "ingestion never loses a file" — conditional consume, crash-window replay, in-flight writes, remote-backend preconditions. Every claim below was produced by running the built dist (`pnpm -r build` clean, `packages/ingest-sources` suite 103/103 green), never by reading code alone. No real server or account was touched: all remote work is against an in-process WebDAV collection I wrote in the scratchpad.

### Verdict

Two of my three original CRITICALs are genuinely closed and one is not. **Closed:** the folder source's stale acknowledgement — refused both in the direct case (`repro/r1`, replacement survives, `source_changed_before_consume` in the review queue) and after a real SIGKILL and restart (`repro/crash-*`, exit 137, the overnight file intact, the library still holding only the pre-crash digest); and the short read — `repro/r2b` sweeps the truncation across 5%, 25%, 50%, 75% and 95% of a 400 MB read and gets a clean `source_changed` refusal every time, never a short buffer, and `repro/r2` files no document at all. The two adjacent findings from my lens are also closed: the zip name-collision (`repro/r13`, both members in the library across four normalisation variants; a `..` entry correctly refuses the container whole to review) and the nested-destination exclusion (`repro/r12`). **Not closed:** the WebDAV acknowledgement. The fix compares a revision where the folder fix compares a digest, and on a no-ETag share — a configuration the package's own test suite blesses — an object nobody read is deleted whenever the replacement lands in the same second with the same size, three runs of three, with `verified: true`. The same holds where the ETag is metadata-derived, and there `If-Match` actively endorses the delete. Beyond that, the re-stat-then-delete residual is not where the header says it is: the metadata window is 7 µs, but the digest window is the whole streaming re-hash — 260 ms at 128 MiB, three losses out of three, scaling to seconds on the 900 MB scan ADR-0022 names. And two operations that were never in scope are worse than the one that was: `moveTarget` is a stat-then-rename that destroyed an archived original 10 times out of 10 while reporting `moved / verified: true` twice to the same path, and a cross-mount `move` throws a raw EXDEV out of `acknowledge`, leaving the state row pending for ever with nothing in the review queue. Exit criterion 3 — 'the three adversarial lenses re-run and no critical or major finding reproduces' — is not met for this lens.

### Still reproducing

- packages/ingest-sources/src/webdav/source.ts — [CRITICAL] 'acknowledge never compares ref.revision against the object now on the share, so an object that replaced the original is destroyed having never been ingested'. The comparison now exists, but it compares a *revision*, never the digest, and on two entirely ordinary share configurations the revision is unchanged by a replacement. The finding's effect therefore still reproduces. (a) A share that sends no ETag — the configuration `webdav.test.ts` itself blesses with 'consumes normally on a share that sends no ETag': the revision is `mtime:<Last-Modified>:<size>`, and `Last-Modified` is an HTTP-date, one second of resolution by RFC 9110. `repro/r6b-webdav-no-etag-second.mjs`, 3 runs of 3, no timestamp manipulation of any kind: candidate offered at `mtime:Wed, 26 Aug 2026 11:02:34 GMT:617`; a writer replaces the object 75 ms later with 617 different bytes; acknowledgement `{"action":"deleted","verified":true}`; request log `[{HEAD, ifMatch:null},{DELETE, ifMatch:null}]`; `object survived? false`; `replacement ingested? false`. (b) A share whose ETag is derived from metadata — Apache's default `FileETag INode MTime Size` — with a client that preserves mtime (`X-OC-MTime`, `rsync -t`): `repro/r6-webdav-same-second.mjs` etagMode=apache-secs, `deleted / verified: true`, and here `If-Match: "110905-269-6a8ec611"` was sent, evaluated by the server and *passed*, so the precondition endorsed the destruction. The same script's etagMode=content run refuses, which is the only configuration the fix actually covers. The folder source's own principle — 'what is acknowledged is the digest the pipeline committed, not the path' — was never carried across: `acknowledge` on this path issues HEAD and DELETE and no GET, so the bytes about to be destroyed are never read.
- packages/ingest/src/scratch.ts — [MINOR] 'nothing sweeps an abandoned scratch root at start-up'. Still reproduces, as spec/hardening-2026-08.md itself records under H6. `ScratchManager`'s member list is unchanged (`ensureRoot`, `rootPath`, `outstanding`, `with`, `isEmpty`, `dispose`) and the only non-test references in the tree are `pipeline.ts:467` (`new ScratchManager(this.config.scratchRoot)`) and the index export. No sweep exists and no start-up caller exists.

### New findings

#### [CRITICAL] packages/ingest-sources/src/webdav/source.ts

**Claim:** The module header: 'identity remains the SHA-256 the pipeline computes (P2)', and the consume is 'conditional on the revision the candidate was offered under', with two mechanisms — a fresh HEAD and `If-Match` — of which 'neither is sufficient alone'. `spec/hardening-2026-08.md` H1 marks this defect closed with 8 tests.

**Reality:** Both mechanisms are functions of the same metadata, and neither is identity. `acknowledge` never re-reads the object's bytes: the whole destructive path is HEAD then DELETE. Where the folder source answers the identical attack by streaming the file and comparing the digest the pipeline committed, this source stops at the revision string. Any replacement that leaves the server's chosen version token unchanged is deleted unread, and `If-Match` makes it worse rather than better when the token is metadata-derived, because the server then affirmatively agrees. The fix is asymmetric across the two sources that share one brief.

**Evidence:**
```
repro/r6b-webdav-no-etag-second.mjs (no-ETag share, no timestamp manipulation, 3/3): revision `mtime:Wed, 26 Aug 2026 11:02:34 GMT:617`, 617 different bytes written 75 ms later in the same wall-clock second, ack `{"action":"deleted","verified":true}`, requests `[HEAD ifMatch:null, DELETE ifMatch:null]`, `object survived? false`, `replacement ingested? false`. repro/r6-webdav-same-second.mjs etagMode=apache-secs: ack `deleted / verified: true`, `DELETE ifMatch:"110905-269-6a8ec611"` evaluated and passed by the server, object gone, committed digest 77c5e0f0… never equal to what was on the share. etagMode=content in the same script refuses — the only covered case.
```

#### [MAJOR] packages/ingest-sources/src/folder/source.ts

**Claim:** Module header: the checks 'narrow the residual window to two adjacent syscalls with no `await` between them', and the digest is 'the second [check] is the one that matters'.

**Reality:** That is true of the metadata triple and false of the digest, which is the check the header calls load-bearing. `hashFile` streams the whole original; a rewrite of a region the stream has already passed is invisible to it, and nothing re-checks content between the hash finishing and the `rm`/`rename`. The blind window for the first bytes of the file is therefore the entire duration of the re-hash — four to five orders of magnitude larger than the two syscalls claimed, and linear in file size, so ADR-0022's named 900 MB scan carries roughly two seconds of it.

**Evidence:**
```
repro/r8b-folder-hash-window.mjs, 128 MiB file, delete policy. Measured phases: store verification 300 ms, re-hash of the original 270 ms. Sweeping when a same-length in-place rewrite of the first 64 KiB (mtime restored, exactly the writer the fix's own regression test uses) lands: +100/+200/+280/+320 ms → `refused` (`…now holds … hashing to …`), file kept; +360/+420/+480/+540 ms → `{"action":"deleted","verified":true}`, file gone. Three consecutive runs at the calibrated offset: rewrite at +498/+512/+506 ms with the `open(…, 'r+')` succeeding (so the file demonstrably still existed), acknowledge returning at +570/+638/+635 ms, file deleted, committed digest 642f52d1… against 49133b0b… actually on disk. Contrast, repro/gap.mjs over 200 iterations: the gap between the final stat resolving and the unlink being issued is 7.1 µs median, 21.8 µs p95, 77 µs max. At 32 MiB the window shrinks to ~60 ms, confirming it tracks the hash.
```

#### [MAJOR] packages/ingest-sources/src/folder/source.ts

**Claim:** `moveTarget` is documented as '/** Where a consumed file goes, without ever overwriting something already there. */', and the header recommends `move` as 'the safer configuration for a folder a writer is actively racing, because a wrongly moved file still exists'.

**Reality:** `moveTarget` is a `stat`-then-`rename`, and `rename(2)` replaces its destination silently. It is the same two-operation TOCTOU the H1 fix closed on the source side, left untouched on the destination side, and there is no re-check of the destination between the choice and the rename. `ConsumePolicy.to` may be absolute (`start()` handles `isAbsolute`), so two watched folders sharing one processed archive is a supported configuration, and two acknowledgements interleave at their awaits long before either renames. The WebDAV source does not have this defect — its MOVE carries `Overwrite: F`, so the server decides atomically — which makes the local path the outlier.

**Evidence:**
```
repro/r10-move-destination.mjs, two roots with a `scan.pdf` each, one shared absolute `to`, `Promise.all` over the two acknowledgements: 10 of 10 attempts destroyed an archived original. Both acknowledgements return `moved / verified: true` naming the *same* path, e.g. both `moved to '/tmp/reattack-archive-M2qDMa/scan.pdf' after verification: 1 blob(s) re-read from the store, hashed, and matched to their documents row`; the archive afterwards holds one file, both watched folders are empty, and one of the two originals hashes to nothing on disk. Nothing is reported as skipped, nothing reaches the review queue.
```

#### [MAJOR] packages/ingest-sources/src/folder/source.ts

**Claim:** `acknowledge` returns an `Acknowledgement`, and a consume that cannot be completed is a refusal routed to review (P3) naming the reason — `SOURCE_CHANGED_BEFORE_CONSUME` and the `flagForReview` path.

**Reality:** `move` across a filesystem boundary is a supported configuration (absolute `to`) that `rename(2)` cannot serve. The call throws a raw Node `Error` with `code: 'EXDEV'` — not a `SourceError` — straight out of `acknowledge`, bypassing `flagForReview` entirely. The runner catches it, records the errno string as the acknowledgement `detail`, and leaves the state row `pending` for ever, so every subsequent run replays it, throws again, and reports `ok: false`; meanwhile the file is offered again on each poll and re-ingested as a duplicate. The consume policy silently never completes, and the operator's only artefact is a bare errno. There is no copy-then-unlink fallback anywhere in the file.

**Evidence:**
```
repro/r9-exdev.mjs, watched root on /tmp (st_dev 39), processed directory on /dev/shm (st_dev 29), nothing outside two temporary directories touched. Direct call: `acknowledge threw: Error: EXDEV: cross-device link not permitted, rename '/tmp/reattack-exdev-…/scan.pdf' -> '/dev/shm/reattack-processed-…/scan.pdf'`, `error.code EXDEV`, `is it a SourceError? false`, processed directory `[]`. Through `SourceRunner.runOnce`: `ok: false`, acknowledgement `{"action":"refused","detail":"EXDEV: cross-device link not permitted, rename …"}`, `ingest_source_state` row `{"external_id":"scan.pdf","acknowledgement":"pending","detail":null}`, pipeline counts `{"duplicates":1}`, review queue empty. Pre-existing rather than introduced by the H1 fix, but squarely in its blast radius and still unhandled.
```

#### [MAJOR] packages/ingest-sources/src/runner.ts

**Claim:** `SourceRunReport.ok` is documented as 'True when the pipeline's own verification passed and every acknowledgement — this run's and any replayed from a previous one — completed without being refused', and the comment above the real computation says 'a report that called it one would be the kind of check the Phase 1 review found and condemned'.

**Reality:** The early return taken when `page.candidates.length === 0` hardcodes `ok: true` and never consults `recovered`. That is precisely the shape of the H1 crash window: the process dies between commit and acknowledgement, the next process replays, the replay is *refused* because the file changed while nothing was running — the fix working — and the run reports clean. The correct computation exists sixty lines below and is simply not reached. This is ADR-0021 §1 in a different register: `ok` narrates the poll rather than querying the acknowledgements it claims to cover.

**Evidence:**
```
repro/crash-phase1.mjs + crash-phase2.mjs driven by drive.sh, with a genuine `process.kill(pid, 'SIGKILL')` between the commit and the acknowledgement (shell reported `phase1 exit: 137`). Phase 2 output: `pending acknowledgements found: 1`, `recovered [{"action":"refused","detail":"the original was kept: 'scan.pdf' is not the file that was ingested (608 bytes then, 255 now; …)"}]`, `offered 0`, and `report.ok true`. `folder.test.ts` line ~570 already documents this in a comment and declines to assert it, on the grounds that runner.ts belongs to another workstream — so it has been seen and left.
```

#### [MINOR] packages/ingest-sources/src/webdav/source.ts

**Claim:** Header: 'the refusal wording never claims the precondition was honoured' and 'There is no way for a client to detect that [a share ignoring If-Match] from the outside'. `matchNote` promises the record 'must not read as though the far side' evaluated anything it did not.

**Reality:** Two things. First, the *success* wording does claim it: a share that ignores preconditions returns 204 and the acknowledgement is recorded as `deleted after verification: … (conditional on If-Match: "…")`, which asserts a guarantee that was never obtained — narration rather than a queried fact. Second, the detectability claim is false. `If-Match` applies to every method (RFC 9110 §13.1.1; Apache's default handler runs `ap_meets_conditions()` for GET and HEAD), so one deliberately non-matching conditional request tells a share that evaluates preconditions from one that does not, and `health()` already performs an OPTIONS handshake where such a probe would sit.

**Evidence:**
```
repro/r7-webdav-ignore-ifmatch.mjs, writer injected inside the HEAD→DELETE window by the server hook rather than raced for: with preconditions honoured, `refused` on a 412 and the object kept; with `ignoreIfMatch: true`, `{"action":"deleted","verified":true}`, detail `deleted after verification: … (conditional on If-Match: "cbba0e276618ef890cf3")`, object gone, replacement never ingested, window measured at 5.46 ms on loopback (a real share over a WAN is tens to hundreds). repro/r11-ifmatch-probe.mjs: a HEAD carrying `If-Match: "recueil-precondition-probe-that-cannot-match"` answers 412 against a precondition-evaluating share and 200 against one that ignores them, with the object untouched either way. Caveat stated plainly: the probe evidence is against my own in-process fake, since H6 records that no real WebDAV server has ever been met; the RFC and Apache behaviour are the basis for the claim about real servers.
```


## Lens

Adversarial re-attack of ADR-0022: "untrusted input cannot exhaust the server". The three Phase-2 reproductions (zip bomb, PDF bomb, 33-character-subject ReDoS) were rebuilt and re-run against the freshly built code, then the budgets themselves were attacked — nested containers, per-member vs per-container totals, budgets checked before rather than bounding an allocation, wall clocks that cannot fire because the work is synchronous — and every `inflate`, `unzip`, `parse` and `RegExp` construction over external bytes in the tree was enumerated and probed. No repository file was edited and no git command was run; the only repo-side effect was `pnpm -r build` regenerating the gitignored `dist/` trees. All work in /tmp/claude-1000/-home-rh/9ff85c49-e734-4296-8ae9-74966546842e/scratchpad/poc/.

### Verdict

Three fixes hold; the fourth path of each was missed. Re-running the Phase-2 reproductions against the freshly built tree: the 815 KB zip bomb is now refused by `maxOutputLength` at the 512 MiB per-member ceiling (peak 728 MB, 0.43 s, limit named) — closed; the 299 KB and 1.94 MB PDF stream bombs are refused in 0.02–0.03 s naming pdf.maxStreamOutputBytes — closed; `skippedBy` with `^(\w+\s?)*$` now answers in under 3 ms at every subject length up to 61 — closed. But H2's table was written from the workstream rather than from the findings file, and the lesson the hardening document itself records about unassigned findings has repeated: the ReDoS finding named TWO paths and only one was fixed, so `packages/ingest/src/rules/engine.ts` still runs a native backtracking `RegExp` over a stranger's Subject (94 s at 34 characters, no return at 36) using the very rule the ADR quotes; and the zip-bomb finding was fixed in one of the tree's two ZIP readers, so `packages/import-zotero/src/zip.ts:98` still reproduces the original verbatim, message and all, at +1.59 GB RSS. On top of that, four of the five budget shapes the brief predicted are present: the PDF wall clock does not cover `countPages`, whose quadratic regex gave 38.44 s with zero event-loop ticks through the real pipeline from an 8 MiB file and no refusal at all; nested containers each mint a fresh full ledger because `BudgetLedger.child()` has no production caller, measured at 10x the container ceiling through the real pipeline; `SafeRegex`'s 250 ms clock is preceded by an unbounded `Array.from` costing 1.03 s at the engine's own 16 MiB text ceiling, paid per matcher; and two further unbudgeted native-regex parsers over external bytes — `custom-fields.ts` (53.88 s inside a SQLite write transaction from a 33-character value) and `core/src/markdown.ts` (219 s from a 16 MiB note, inside the server's own body limit) — were never in anyone's scope. Exit criterion 3 does not hold: critical findings from the security lens still reproduce. The fixes introduced no new hole, but they left four unreached.

### Still reproducing

- packages/ingest/src/rules/engine.ts — the SECOND half of the Phase-2 [CRITICAL] ReDoS finding is untouched and still reproduces. The finding named two paths; only imap/rules.ts was fixed. `RuleEngine.compile` (line 198) still builds `new RegExp(pattern.pattern, ...)` and `RuleEngine.test` (line 179) still runs `.test()` with no step budget and no clock, against `sourceMetadata.subject` (a stranger's Subject: header) and `subject.text` (the whole extracted PDF/OCR text). Reproduced with the ADR's own example rule, compiled by the shipped `toIngestRules`: mail rule {match:{subject:'^(\w+\s?)*$'}} -> stage-8 rule {"sourceId":["mailbox-1"],"subject":{"pattern":"^(\\w+\\s?)*$","flags":"i"}}; RuleEngine.evaluate against subject lengths 22/26/30/32/34 gave 0.17 s / 0.39 s / 6.19 s / 20.89 s / 93.90 s, and length 36 did not return inside a 300 s timeout. scratchpad/poc/redos_engine.mjs. This is the recipe `packages/ingest-sources/src/index.ts:24` and `runner.ts:30` both document verbatim: `new IngestPipeline({ recueil, rules: source.rules })`.
- packages/import-zotero/src/zip.ts:98 — the original [CRITICAL] zip bomb reproduces VERBATIM in the tree's second ZIP reader, which the fix never reached. `inflateRawSync(compressed)` with no `maxOutputLength`, and `bytes.length !== entry.uncompressedSize` compared only after the buffer is fully materialised — the exact code shape ADR-0022 §2 forbids. The identical 815,451-byte archive from the Phase-2 evidence, declaring 1024 bytes and holding 800 MiB, gave: "ZipError - 'a.bin' decompressed to 838860800 bytes, not the 1024 the directory claims." with rss 223 MB -> peak 1817 MB (+1.59 GB) in 0.98 s. scratchpad/poc/zotero_zip.mjs. Reached from `attachments.ts:225` when the importer reads a Zotero WebDAV share's `<KEY>.zip`.
- packages/ingest/src/archive/eml.ts — the Phase-2 [MINOR] still reproduces exactly as recorded (H6 carries it as Open, so this is confirmation rather than news). `parseEmail(raw: Buffer)` still takes no limits argument: a 24.0 MB quoted-printable message decoded 8,388,608 bytes but moved RSS 268 -> 431 MB (+162 MB, 6.8x the input) before any limit was consulted, and a 7.06 MB message built 199,999 attachment objects before the 2,048-entry `maxArchiveEntries` check was reached. scratchpad/poc/eml.mjs, scratchpad/poc/emlbreadth.mjs.

### New findings

#### [CRITICAL] /home/rh/Documents/GitHub/etabli-dev/public/etabli-recueil/packages/ingest/src/text/pdf-text.ts:374

**Claim:** The module header claims "every inflate carries maxOutputLength, the streams share an accumulated ceiling, the stream count and the input size are capped, and there is a wall clock across the whole call (ADR-0022 §2, §3, §5)", and budgets.ts calls maxMillis the limit that "bounds the time, because extractPdfText is synchronous and the event loop stops with it". The hardening status records the PDF defect as closed.

**Reality:** The wall clock is consulted only at the top of the stream loop, and `countPages(bytes)` runs AFTER the loop, entirely outside every budget. It matches /\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/gu over the whole latin1 copy of the file; with no '>' after the markers the lazy [^>]*? re-scans to the end of the file for every /Type /Pages occurrence, which is quadratic in the file size. A PDF with ZERO streams skips the loop entirely, so no deadline check runs at all, and extractPdfText RETURNS NORMALLY — there is no refusal, no ResourceBudgetError, and nothing reaches the review queue. maxInputBytes is 128 MiB, so this is bounded only by the quadratic. This is the original 2 MB-PDF-blocks-the-loop-for-40-seconds finding restored through a different function of the same file.

**Evidence:**
```
scratchpad/poc/pdfpages.mjs, real `extractPdfText` from packages/ingest/dist with DEFAULT_PDF_BUDGET: 2 MiB/1260 markers -> 1.91 s; 4 MiB/2520 -> 9.50 s; 8 MiB/5041 -> 42.52 s, every one returning `ok pageCount null streamsFound 0` against a pdf.maxMillis budget of 15 000 ms. Control (scratchpad/poc/pdfpages_control.mjs): the same 8 MiB, the same 4681 markers, each closed with '>' -> 0.01 s, which isolates the cost in countPages. End to end through the real IngestPipeline (scratchpad/poc/e2e_pdf.mjs, real createRecueil, real content store): 4 MiB PDF -> outcome `review`, 8.75 s, event-loop ticks fired 0 of an expected 175 on a 50 ms interval; 8 MiB PDF -> 38.44 s, 0 of an expected 769 ticks. Zero timer callbacks in 38 seconds is the whole server stopping. At the permitted 128 MiB the same shape is hours.
```

#### [CRITICAL] /home/rh/Documents/GitHub/etabli-dev/public/etabli-recueil/packages/core/src/services/custom-fields.ts:767

**Claim:** ADR-0022 §4: "Pattern matching over untrusted text is bounded. Either a non-backtracking engine or an enforced timeout, on every path, with no exceptions for 'internal' rules." packages/rules/src/regex/index.ts: "The native RegExp is deliberately absent from every matcher in this package."

**Reality:** `checkPattern` compiles the operator's custom-field validation pattern with the native `new RegExp(pattern, 'u')` and runs `.test(value)` with no step budget and no clock — a third live path the fix did not reach. The value is attacker-influenced from three directions: `apps/server/src/routes/custom-fields.ts:131` (any HTTP client; auth is off by default), `packages/ingest/src/commit.ts:292` (stage-10 writes rule-derived custom-field values, which @recueil/rules can interpolate from the document's own text), and `packages/import-paperless/src/import.ts:1252/1261/1314` (values from the remote Paperless server). Worse than the mail case: the match happens inside `this.db.transaction`, so SQLite's writer lock is held for the whole stall and no other write to the library can proceed.

**Evidence:**
```
scratchpad/poc/customfield.mjs against a real Recueil library: `customFields.define({fieldKey:'reference', dataType:'text', config:{pattern:'^(\\w+\\s?)*$'}})` — the ADR's own "the subject is just plain words" example — then `customFields.setValue` with values of length 21/25/29/31/33 gave 0.07 s / 0.15 s / 2.36 s / 9.99 s / 53.88 s, ending in `ValidationError 'reference' requires values matching /^(\w+\s?)*$/`. A 33-character field value holds the library's write transaction for 54 seconds.
```

#### [MAJOR] /home/rh/Documents/GitHub/etabli-dev/public/etabli-recueil/packages/ingest/src/pipeline.ts:1591

**Claim:** ADR-0022 §3: "a nested container inherits the remaining budget rather than a fresh one." archive/extract.ts:18 repeats it: "a nested archive inherits the remainder rather than a fresh ceiling." budgets.ts:136 provides `BudgetLedger.child()` for exactly this. The hardening status lists the zip budget as closed.

**Reality:** `BudgetLedger.child()` has ZERO callers in production code — the only uses in the tree are two assertions in packages/ingest/test/budgets.test.ts. `expandArchive` calls `extractArchive({ bytes, kind, scratch, config })` with no `budget` property, and the members it recovers re-enter at stage 1 through `ingestWithRetries`, so a member that is itself an archive reaches `extractArchive` again — still with no `budget`, hence `containerLedger()` mints a brand-new ledger at the full `maxArchiveTotalBytes`. There is therefore no budget of any kind that spans an archive tree: `maxArchiveTotalBytes` bounds one container only, and `maxArchiveDepth` (3) merely caps how many times it is re-granted. The aggregate a single top-level file can command is (members per container)^depth x the per-member ceiling.

**Evidence:**
```
scratchpad/poc/nested_budget.mjs, same config for both cases (maxArchiveEntryBytes 1 MiB, maxArchiveTotalBytes 4 MiB, depth 3), real `extractArchive` from packages/ingest/dist. Case A, 40 x 1 MiB flat in one container: refused — "The archive declares 41943040 bytes uncompressed; the limit is 4194304." Case B, the identical payload one level down as 40 inner archives (each 7,286 bytes, ratio 144x, inside the 200x limit): ALLOWED, inner archives produced 41,943,040 bytes = 10.0x the container budget from a 295,042-byte file. Confirmed through the REAL pipeline in scratchpad/poc/nested_pipeline.mjs (real createRecueil, real content store, `IngestPipeline.ingestOne`): outer.zip 295,610 bytes -> outcome `container`, 40 documents filed, total byte_size 41,943,040 (40.0 MiB) against maxArchiveTotalBytes 4 MiB, in 1.7 s. At the shipped defaults the same construction is bounded by 200x per level over two levels of nesting, i.e. roughly 40 000x the top-level file, with nothing that adds up across the tree.
```

#### [MAJOR] /home/rh/Documents/GitHub/etabli-dev/public/etabli-recueil/packages/core/src/markdown.ts:42

**Claim:** ADR-0022: "Every code path that decompresses, parses, expands or matches attacker-influenced input runs under an explicit resource budget, enforced by the call itself."

**Reality:** `htmlToMarkdown` is six chained `String.replace` calls whose patterns are all lazy `([\s\S]*?)` bounded by a closing tag, two of them with a `\1` backreference. With opening tags and no closing tag, each opener costs a scan to the end of the input, so the cost is quadratic in the note size. No budget of any kind applies. It is reached from `notes.create({contentHtml})` at `packages/core/src/services/notes.ts:452`, i.e. from `POST /api/v1/notes` (apps/server/src/routes/notes.ts:77/109) and from the Zotero connector route (apps/server/src/routes/connector.ts:385), synchronously on the request thread. The server's own `DEFAULT_BODY_LIMIT` (apps/server/src/app.ts:106) is 16 MiB, so the worst case is reachable inside the limit the server itself sets.

**Evidence:**
```
scratchpad/poc/md.mjs against the built `htmlToMarkdown`: 500 unclosed <strong> in 260 KB -> 0.04 s; 1000 in 520 KB -> 0.17 s; 2000 in 1040 KB -> 0.67 s (clean quadratic). scratchpad/poc/md2.mjs at the server's own body limit: 16.0 MB of note HTML with 30 000 unclosed <strong> -> 219.4 s of fully synchronous work. One POST inside the accepted body size stops the event loop for three and a half minutes.
```

#### [MAJOR] /home/rh/Documents/GitHub/etabli-dev/public/etabli-recueil/packages/rules/src/regex/index.ts:91

**Claim:** packages/rules/src/regex/vm.ts: "The step budget and the wall-clock allowance on top ... are there because 'linear' still multiplies ... a rule engine that can be made to spend five minutes on one document is still a denial of service." DEFAULT_TIMEOUT_MS is 250. imap/rules.ts calls the clock "a backstop".

**Reality:** The clock cannot bound the call, because the first thing `SafeRegex.exec` does is `Array.from(input, char => char.codePointAt(0)!)` — a full code-point array over the whole input — and only then enters `runProgram`, where the clock is read every 4096 steps. The allocation is unbounded by the timeout, is not memoised, and is repeated for every matcher of every rule. This is the "budget checked after an allocation rather than bounding it" shape that ADR-0022 §2 exists to forbid, in the very engine the ADR nominates as the safe one.

**Evidence:**
```
scratchpad/poc/saferegex_split.mjs, built @recueil/rules, trivial literal pattern /Rechnung/i at default limits: 1 MB -> Array.from alone 83 ms, whole test() 326 ms; 4 MB -> 272 ms / 510 ms; 16 MB (which is DEFAULT_LIMITS.maxTextLength, the engine's own ceiling) -> Array.from alone 1034 ms, whole test() 1349 ms — 5.4x the 250 ms budget, spent before the clock is ever consulted. Memory with it: scratchpad/poc/saferegex_alloc.mjs, 64 MB input -> +672 MB RSS, 3.95 s, then a RegexTimeoutError. End to end through `evaluateIngestion` (scratchpad/poc/rules_stage8.mjs), which is what the server's stage-8 adapter calls: ten ordinary rules with literal `text` matchers over a 20 MB extracted text -> 11.29 s of synchronous work and rss 86 -> 563 MB, every rule ending `"outcome":"error" ... "regular expression exceeded its allowance of 250 ms (/Rechnung 0/)"`. Note the second consequence: a literal eight-character pattern cannot match a 1 MB document at all under the shipped defaults, so every rule errors and the document goes to review for a reason that is not true of it.
```

#### [MAJOR] /home/rh/Documents/GitHub/etabli-dev/public/etabli-recueil/packages/ingest-sources/src/webdav/client.ts:484

**Claim:** The module header argues at length that an href from the far side "is hostile until it has been checked", and the XML reader's own comment says "anything it cannot read becomes a protocol error rather than a silently empty listing".

**Reality:** `blocks()` builds `new RegExp('<(?:[A-Za-z0-9_.-]+:)?response(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?response>', 'giu')` and runs it over the whole PROPFIND body, and `text()` at :489 does the same per block. An opening tag with no matching close makes the lazy `[\s\S]*?` scan to the end of the body for every opener — quadratic in the response size, synchronously on the poll loop. The body is read with `await response.text()` at :190 (and `arrayBuffer()` at :198) with no size bound of the client's own; the server's EgressGuard caps it at DEFAULT_MAX_RESPONSE_BYTES = 128 MiB, and any other caller — the client is exported from @recueil/ingest-sources and takes `options.fetch ?? fetch` — has no cap at all. A hostile or compromised share is precisely the threat the header names.

**Evidence:**
```
scratchpad/poc/webdav_xml.mjs, the exact regex the file constructs: 2000 unclosed <d:response> in a 2 MB body -> 1.34 s; 4000 in 4 MB -> 5.59 s; 8000 in 8 MB -> 27.55 s, all returning 0 blocks. Quadratic, so the 128 MiB the EgressGuard permits is hours of a blocked event loop from one PROPFIND answer.
```

#### [MINOR] /home/rh/Documents/GitHub/etabli-dev/public/etabli-recueil/packages/import-zotero/src/reader/zotero-library.ts:199

**Claim:** ADR-0022 §2: "Decompression passes maxOutputLength (or the streaming equivalent with a running total that aborts)."

**Reality:** `inflateSync(bytes)` with no `maxOutputLength`, over the `globalSchema` blob read straight out of the user-supplied `zotero.sqlite`. The surrounding try/catch would swallow an `ERR_BUFFER_TOO_LARGE`, but nothing stops the allocation itself: a kilobyte of zlib in that settings row asks for as many gigabytes as the author chose, and the process dies before the catch runs. Same class as the zip.ts:98 defect in the same package, and the fix reached neither.

**Evidence:**
```
Read directly: `const text = bytes[0] === 0x78 ? inflateSync(bytes).toString('utf8') : bytes.toString('utf8');` — no options argument. The same call shape was measured live in the sibling reader (scratchpad/poc/zotero_zip.mjs: 815 KB of input -> +1.59 GB RSS), which is the amplification available here too.
```

#### [MINOR] /home/rh/Documents/GitHub/etabli-dev/public/etabli-recueil/packages/ingest-sources/src/types.ts:128

**Claim:** ADR-0022: "Budgets are configuration with conservative defaults, surfaced in one place rather than scattered as literals." H6 records only that the server surfaces no environment variable for the ingest budgets.

**Reality:** The first budget of all — how many bytes a source may pull into a Buffer — has no default at all. `CommonSourceOptions.maxBytes` is optional and every enforcement site is guarded by `!== undefined` (folder/source.ts:263, folder/scan.ts:160, imap/source.ts:132, webdav/source.ts:192). `apps/server/src/ingestion/sources.ts` never sets it: `maxBytes` does not occur anywhere under apps/server/src. So a server-configured IMAP source will fetch a stranger's arbitrarily large message whole into memory before `parseEmail` — which itself takes no limits — decodes it at roughly 6.8x. The same is true of `await response.text()` / `arrayBuffer()` in webdav/client.ts for any caller not routed through EgressGuard, of `response.text()` in packages/ingest/src/metadata/grobid.ts:121/140, and of `response.text()` / `arrayBuffer()` in packages/import-paperless/src/client/client.ts:280/363/604.

**Evidence:**
```
grep across apps/server/src for `maxBytes` returns nothing; grep across packages/ingest-sources/src shows every use is `options.maxBytes !== undefined && ...`. The downstream amplification was measured: scratchpad/poc/eml.mjs, a 24.0 MB message -> +162 MB RSS (6.8x) inside `parseEmail`, before any limit is consulted.
```


## Lens

Adversarial re-attack on the verification checks themselves: every blocking check in every report (Zotero, Paperless, IngestPipeline.verifyRun) was given a mutation of the kind it claims to detect, run against real SQLite libraries, real content stores and real fake servers, and the verdict observed. The falsification tests were audited for whether they mutate what the check actually reads, and the fixed code was searched for new one-sided comparisons and counters derived by subtraction. No repository file was edited and no git command was run; all work is in /tmp/claude-1000/-home-rh/9ff85c49-e734-4296-8ae9-74966546842e/scratchpad/re/.

### Verdict

The three fixes I was asked to re-attack hold, and I could not defeat them. The Phase 2 CRITICALs no longer reproduce: the folder race rebuilt through the shipped public path (FolderSource consume:delete + SourceRunner + IngestPipeline at the default concurrency of 2, a 300 ms fake OCR engine and a 60 ms extractor, two files carrying identical bytes) now gives documents 1, items 1, live attachments 1, counts {ingested:1,duplicates:1}, and a verification whose documentsWithoutAttachment is a counted 0; the stale acknowledgement is refused as source_changed_before_consume with the replacement file intact; the zip name collision keeps both members as distinct documents. All six of verifyRun's checks have falsification tests that mutate something the check actually reads, and the queried numbers no check compares are now explicitly documented as context rather than passed off as checks. The Paperless report's three named defects are genuinely gone: narrated skipped counts no longer reach the target side, an empty /api/custom_fields/ now fails custom_field_references_resolvable, and a re-import over trashed items completes instead of throwing.

What the fixes did not reach is the shape of the checks rather than their operators. Both migration reports verify quantity and — apart from the Paperless item→document→attachment reconciliation — never correspondence: swapped tags, rewritten notes, rewritten field values, and in Zotero every tag assignment and every collection membership deleted, all pass. Worse, the Paperless report has two ways to make all fifteen blocking checks compare 0 with 0: trashing the imported items, because the trash filter is applied to the API result set and so shrinks the source side; and storing no originals at all, because the only file-fidelity checks are non-blocking. Both produce a document headed "PASS — 0 of 0 documents imported", and that document is the M2 exit artefact. That is the ADR-0021 failure mode one level up from the one this round fixed: not a check with the wrong operator, but a blocking set that can be emptied. I would not treat exit criterion 3 as met while a report can say that. Two smaller things sit outside the reports: a zip can never be consumed by any source, because its unstored container digest fails the store verification and leaves the run permanently not-ok; and a configured scratchRoot is never created, which kills archive ingestion for that deployment. Neither loses data; both are permanent once hit.

### Still reproducing

- packages/core/src/services/library.ts — [MINOR] restoreItem returns a raw SqliteError on an ASN collision instead of a ConflictError. Still reproduces exactly as reported (scratchpad/re/asn-restore.mjs): item A created with ASN 5, trashed; item B created live with ASN 5; library.restoreItem(a.id) → `restore threw: SqliteError | SQLITE_CONSTRAINT_UNIQUE | UNIQUE constraint failed: item_office.asn`; final state consistent at 1 live item holding ASN 5. No corruption — the partial index holds — but the caller still cannot distinguish this from an internal fault and the message still does not name the item that holds the number. The hardening audit records this as carried into H6, and that is accurate.
- No other earlier finding from my lens reproduces. Verified individually against the built code: pipeline.ts stage-2/stage-10 duplication (does not reproduce — 1 document, 1 item, 1 attachment through the shipped folder path at the default concurrency); pipeline.ts verify() one-sided inequalities and the subtracted counter (does not reproduce — equalities, counted documentsWithoutAttachment, six falsifiable checks); import-paperless report/build.ts narrated `skipped` counts on the target side (does not reproduce); import-paperless report/build.ts custom fields bucketed through the importer's plan (does not reproduce); import-paperless import.ts ConflictError on a re-import over a trashed item (does not reproduce); pipeline.ts job state derived from counts.review (does not reproduce — derived from review_queue); ingest/archive/extract.ts member-name collision (does not reproduce); ingest-sources folder/source.ts stale acknowledgement (does not reproduce — refused, file kept, review entry raised).

### New findings

#### [MAJOR] packages/import-paperless/src/report/build.ts

**Claim:** build.ts:749-757 and the module header: every blocking check 'compares a number obtained from the API snapshot against a number obtained by querying the target's own tables, asserts equality, and has a test in test/report-checks.test.ts that mutates one side and watches it fail'. `items_not_in_trash` is described as the place 'the exclusion is stated rather than being subtracted quietly from both sides'.

**Reality:** The trash exclusion is applied to the SOURCE side. `documents_` (line 182) removes every API document whose Recueil item is trashed, and every per-document count on both sides is then derived from `documents_` and `matchedItemIds`. The target therefore decides what the source is allowed to contain, so growing the exclusion shrinks both sides together. `items_not_in_trash` is the only check that sees it and it is `blocking: false`. Trash every imported item and all fifteen blocking checks compare 0 with 0 and pass — the M2 exit artefact, the report on which Paperless is decommissioned, reads PASS over a library holding nothing from Paperless at all. ADR-0021 §2 allows a filter only when the check counts the unfiltered source and reports the exclusion as a finding; here the finding cannot fail the report however total the loss.

**Evidence:**
```
scratchpad/re/pl-attack2.mjs, end to end through the real `importPaperless` and the real fake server: run 1 `pass: true`; every imported item then trashed (the H5 'librarian bins duplicates' case taken to its limit); run 2 completes and reports `pass: true`, the only failing check being `info items_not_in_trash expected=0 actual=10`. Direct SQL on the target: `live paperless items after run 2: { n: 0 }`. `renderReportMarkdown` prints `**PASS** — 0 of 0 documents imported, 0 originals hashed into the store (100% coverage), 10 entries for review.` and a table containing `document_count_parity | pass | 0 | 0 | blocking`, `asn_preserved | pass | 0 | 0 | blocking`, `tag_assignments_carried | pass | 0 | 0 | blocking`, `notes_carried | pass | 0 | 0 | blocking`, `custom_field_values_carried | pass | 0 | 0 | blocking` — fifteen of fifteen green. scratchpad/re/pl-attack1.mjs reaches the same state through `buildReport` alone; scratchpad/re/pl-attack5.mjs shows the realistic partial case (two items binned) also passing, though there the markdown does name them.
```

#### [MAJOR] packages/import-paperless/src/report/build.ts

**Claim:** `attachment_records_carried` is blocking: 'Every blob the store holds for an imported document is reachable from its item. Both sides are queries against the target.' `original_hash_coverage` is deliberately non-blocking because CONCEPT §6 asks for a document whose file cannot be fetched to go to the review queue with a reason, not for the run to fail.

**Reality:** There is no floor under that concession. When the run stores nothing, `originals.recueilDocuments` and `originals.recueilAttachments` are both 0, so the blocking `attachment_records_carried` compares 0 with 0; `originals_accounted_for` is satisfied because the importer's own log explains every absence; and `original_hash_coverage`, the only check that would notice, cannot fail the report. A migration that carried not one byte of one file therefore reports PASS. Separately, `original_checksums_agree` — the only check comparing stored bytes against Paperless's own recorded MD5 — is also non-blocking, so a document whose stored blob is not the file Paperless holds cannot fail the report either; the baseline fixture run already prints `info original_checksums_agree expected=0 actual=1` with `pass: true`. Nothing blocking in the report is about the bytes.

**Evidence:**
```
scratchpad/re/pl-attack4.mjs: the fake Paperless answers 404 to every `/download/` request (a storage volume that failed to mount). Result: `pass: true`, with only `info original_hash_coverage expected=10 actual=0`, `info custom_field_values_representable` and `info document_links_resolved` failing. Direct SQL against the target: `documents rows in library: { n: 0 }`, `attachments rows: { n: 0 }`. Markdown verdict: `**PASS** — 10 of 10 documents imported, 0 originals hashed into the store (0% coverage), 12 entries for review.`
```

#### [MAJOR] packages/import-paperless/src/report/build.ts

**Claim:** `tag_assignments_carried`: 'Every tag id on every document that /api/tags/ defined became a row in item_tags.' `notes_carried`: 'Every distinct Paperless note text became a Recueil note, by query over notes.' `custom_field_values_carried`: 'Every custom-field value the source can express reached field_values.'

**Reality:** All three are count parities scoped to the matched items, with no correspondence and no content comparison. `recueilAssignments` (line 253) counts `item_tags` rows joined to a live tag; `recueilNotes` (line 405) counts `notes` rows; `recueilInstances` (line 376) counts distinct `(item, field, group)` slots. Which item a tag is on, what a note says and what a value holds are read by nothing in the report. The three sentences above are claims about correspondence that the checks cannot test, so a mapping bug that files the right number of the wrong things — exactly what a migration report exists to catch — is certified PASS. The falsification tests in test/report-checks.test.ts only ever delete rows, so they exercise the count and never the claim.

**Evidence:**
```
scratchpad/re/pl-attack3.mjs, three mutations against a baseline `pass: true` fixture import, each re-verified through `buildReport`. (A) the tags of documents 4 and 8 exchanged — before `{"source_id":"4","name":"Steuer"},{"source_id":"8","name":"Posteingang"}`, after `{"source_id":"4","name":"Posteingang"},{"source_id":"8","name":"Steuer"}` — `pass=true failingBlocking=[]`. (B) every note body replaced with 'REDACTED BY THE ATTACKER' (from 'Per Lastschrift bezahlt.', 'Kündigungsfrist drei Monate.', 'Kaution überwiesen.') — `pass=true failingBlocking=[]`. (C) every `field_values.value_text` set to 'WRONG' and every `value_number` to 999999, so 'Rechnung', 'RE-2024-0031', 'bezahlt' and 89.9 all become rubbish — `pass=true failingBlocking=[]`.
```

#### [MAJOR] packages/import-zotero/src/report/build.ts

**Claim:** build.ts:600-609: the blocking set is 'exact item-count parity per type and overall … plus the things that would make that parity meaningless'. `tag_parity`: 'Every Zotero tag has a live Recueil tag of the same name, matched one for one.' `collection_parity`: 'Every Zotero collection has a Recueil collection of the same name.' CONCEPT §7 M1 makes this report the artefact deciding whether the author's own library was imported.

**Reality:** Neither check — nor any other blocking check in the Zotero report — looks at `item_tags` or `collection_items`. Both are name multiset intersections over the `tags` and `collections` tables; membership is never queried on either side. The whole organisational structure of the library can be absent and the report is clean. This is a hole in the coverage rule rather than a weak check: there is no check to falsify, so the ADR-0021 §4 requirement is satisfied vacuously, and unlike the Paperless suite this package has no structural assertion binding the blocking set to a falsification list that would make the gap visible.

**Evidence:**
```
scratchpad/re/zt-attack1.mjs against the real `fixtures/zotero/zotero.sqlite`: baseline `pass: true` with 61 `item_tags` rows and 66 `collection_items` rows. `delete from item_tags` → rebuilt report `{"pass":true,"failing":["info attachment_hash_coverage expected=14 actual=12"]}` (that informational failure is the baseline's own). Then `delete from collection_items` as well → `{"pass":true,"failing":["info attachment_hash_coverage expected=14 actual=12"]}`. Every blocking check green with no item in any collection and no tag on any item.
```

#### [MAJOR] packages/ingest-sources/src/verify.ts

**Claim:** consume.ts:1-15 and the package index: 'nothing on the far side is moved, deleted or flagged until the bytes have been re-read out of the content store, re-hashed and matched against their documents row', with `DEFAULT_CONSUME_ON = ['ingested', 'duplicate', 'review', 'container']` (types.ts:105) — so a container outcome is one the consume policy is meant to act on.

**Reality:** `outcomeDigests` (verify.ts:52) collects the container's OWN sha256 alongside its members', and `verifyStoredDocument` then demands a `documents` row at that digest. `storeArchiveContainers.zip` defaults to false, so a zip container never has one. The two defaults contradict each other: every zip reaching a folder, WebDAV or IMAP source with a `move` or `delete` policy is refused for ever, `SourceRunner.runOnce` returns `ok: false` because a refusal is not a clean run, and the watched folder never drains — while the members were in fact ingested correctly. The refusal message blames the store ('the library does not know these bytes') for a file the deployment deliberately chose not to store. It fails safe, but it is a documented feature that cannot work and a source that is permanently not-ok.

**Evidence:**
```
scratchpad/re/zip-consume.mjs, real FolderSource + SourceRunner + IngestPipeline, `consume: { mode: 'delete' }`, one `batch.zip` holding `a.pdf` and `b.pdf`: `offered 1 ok false`, `counts {"ingested":0,"duplicates":0,"review":2,"containers":1,"stopped":0,"failed":0}`, acknowledgement `{"status":"container","action":"refused","detail":"the store write could not be verified, so the original was kept: 9a42891786b45343…: no documents row at 9a42891786b45343…: the library does not know these bytes","verified":false}`, `files left: ["batch.zip"]`, `documents: 2` — both members are in the library. The same script with `EML=1` (an .eml, whose container IS stored by default) gives `ok true`, `action deleted`, `files left: []`, which isolates the cause to the unstored container digest.
```

#### [MINOR] packages/import-zotero/src/report/build.ts

**Claim:** ADR-0021 §3: 'A count that can go negative is a bug, not a diagnostic', and its other half — a check's verdict is the comparison the table shows. The hardening audit records 'The Zotero report was re-audited and its Phase 1 fix held.'

**Reality:** The Zotero report was not brought up to the structural standard the Paperless one now has. Every check is an object literal in which `pass` is a separate expression from the `expected`/`actual` pair beside it — there is no `check()` helper deriving the verdict from the printed numbers, and no test asserting the two agree — so the `PASS … expected=6 actual=0` shape the Phase 2 review quoted is still representable in this file. `trash_parity` (build.ts:654-665) goes further and prints `actual: recueilTrashedFromZotero - trashedNotDeletedInZotero`, a counter derived by subtraction that reaches negative numbers. There is also no equivalent of the Paperless `FALSIFIED` coverage assertion, so a blocking check added here without a falsification test would not turn the suite red naming it.

**Evidence:**
```
scratchpad/re/zt-attack2.mjs: baseline `{D:3,T:3,X:0}`, `pass: true`. Clearing `trashed_at` on the imported items and then trashing one item Zotero never deleted gives `{D:3,T:0,X:1}`, and the check prints verbatim `{"name":"trash_parity","pass":false,"expected":3,"actual":-1,"blocking":true}` — the verdict is right, the number beside it is nonsense, and it is the exact derived-negative shape ADR-0021 names.
```

#### [MINOR] packages/ingest/src/scratch.ts

**Claim:** config.ts:27 — `scratchRoot`: 'Where scratch directories are made. Defaults to the OS temporary directory.'

**Reality:** `ScratchManager.ensureRoot()` (scratch.ts:68-73) calls `mkdtemp(join(this.configuredRoot ?? tmpdir(), 'recueil-ingest-'))` and never creates `configuredRoot`. An operator who points `scratchRoot` at a directory that does not exist yet — a fresh deployment, a tmpfs path, a subdirectory of the data volume — gets ENOENT on the first archive and on every archive thereafter, surfacing as an `archive_unreadable` review entry with `proposed_action: retry`, which can never succeed. No test exercises it: every test in packages/ingest/test passes `library.root`, which exists, and `test/helpers.ts` defines a `scratchRoot` field that nothing uses. Nothing is lost — the container is kept — but zip and .eml ingestion is silently dead for that deployment, and the same code path is what the H6 note about sweeping abandoned roots will touch next.

**Evidence:**
```
scratchpad/re/zip-collide.mjs run with `config: { scratchRoot: <library root>/scratch }` (not pre-created): outcome `review`, no members, and the review_queue row reads `reason_code: archive_unreadable`, `explanation: "This archive could not be expanded: ENOENT: no such file or directory, mkdtemp '/tmp/recueil-ing-attack-s9X116/scratch/recueil-ingest-yYondn' The file itself has been kept."` The identical script with `scratchRoot` pointed at an existing directory expands both members correctly into two distinct documents.
```

#### [MINOR] packages/import-paperless/src/report/build.ts

**Claim:** ADR-0021 makes this file the one audited every round, and the repository's review process is diff- and grep-driven.

**Reality:** Line 376 embeds two literal NUL bytes in a template literal (`${row.itemId}<NUL>${row.fieldId}<NUL>${row.groupScopeKey}`) as raw 0x00 bytes rather than as escapes. The file is therefore classified as binary by the standard toolchain, so it does not appear in ordinary `grep -n` output and diff tooling treats it as binary — on the very file the ADR requires to be re-audited by reading. An escape sequence, or the ASCII unit separator already used for the same purpose in pipeline.ts (`char(31)`), reads identically and keeps the file text.

**Evidence:**
```
`grep -n blocking packages/import-paperless/src/report/build.ts` → `grep: packages/import-paperless/src/report/build.ts: binary file matches`, with no line output at all; `-a` is required to see anything. Python over the bytes: `open(p,'rb').read().count(b'\x00')` → 2, at byte offsets 16161 and 16176, both on line 376 inside `valueRows.map((row) => ...)`. The file is otherwise valid UTF-8.
```

