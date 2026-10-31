# October 2026 refinement

Scope: dependable Phase 1/2 library, import, ingestion, API/CLI/web and packaging. Later phases remain outside this release. Original audit records are historical evidence; their open/closed labels must be checked against the current source.

## Baseline

- Starting commit: `9daab658fd0f33426cac9fd40ed970f858f4b7f7`.
- Node 22.23.4, pnpm 9.15.4, macOS ARM64.
- Frozen installation and production build passed. Fresh installation warns about the server binary before its build output exists.
- The first recursive test run stopped at six web share-page failures: jsdom's Blob was passed into Node's Response, whose constructor requires `Blob.stream()`. These are test-environment failures, not proof of browser behavior.
- Source inspection confirms the August follow-up implemented source acknowledgement safety, bounded MIME parsing, scratch sweeping and ASN conflict handling; the README and earlier hardening report still describe several as open.

## Findings and plan

| ID | Severity / evidence | Impact | Action and acceptance |
|---|---|---|---|
| R1 | Major, confirmed in `apps/web/src/routes/share.tsx`: any HTTP success sets `uploaded`, and every `uploaded` result clears the cache, including pipeline `failed`/`stopped` outcomes. | A rejected mobile capture loses its retry copy. | Retain the stash for failed/stopped results, expose retry, and test both outcomes and successful retry. |
| R2 | Build blocker, observed in `test/share-target.test.tsx`. | The test command stops before downstream packages run. | Use coherent transport/DOM Blob boundaries in the fixture without replacing the application client or weakening assertions; inspect multipart contents. |
| R3 | Major documentation drift, confirmed by source and existing tests. | Users cannot tell implemented behavior from old limitations; documented `pnpm dev` does not exist. | Reconcile first-use and status documentation with executed commands and current source. |

Milestones: first close R1/R2 and rerun affected tests; then run the complete workspace gates and browser workflows; review dependency advisories and packaging; finally update first-use instructions and remaining external gates. Failed builds, unrun device/container checks and real-library migration acceptance stay explicitly separate from local results.

## Completed repairs and validation

- Failed/stopped mobile uploads retain their local retry copy. The page owns state by share key, reports cache cleanup failures, and documents the temporary 30-minute cache lifetime. Worker and reader share the same 20-file bound; oversized batches are refused before writing, and partial writes are rolled back.
- Restored the WebDAV response byte limit. All 37 WebDAV tests, including endless listing/object streams, pass; the complete source package passes 125 tests.
- Realpath-normalise both configured ingestion roots and requested folders. Tests cover valid symlink aliases and paths escaping the allowed roots.
- Updated vulnerable dependencies; frozen pnpm installation passes and the production audit reports no known vulnerabilities (2026-10-30).
- `pnpm lint` now runs ESLint across implementation, tests and scripts instead of succeeding without checking any package. Removed unused imports/variables, retained intentional control-character sanitisation, and typed HTTP contract tests.
- Regenerated OpenAPI and rules schemas for Zod 4.6; contract tests check the named root reference and the same discriminated choice. `pnpm check:spec` validates the plugin manifest and OpenAPI structure with locked dependencies.
- CI now runs frozen install, lint, build, typing, spec validation, tests and production dependency audit on Node 22/24, plus Chromium against the built client and real API/SQLite. CI is prepared locally; no remote run is claimed.

Observed commands: `pnpm build`, `pnpm typecheck`, `pnpm lint`,
`pnpm check:spec`, `pnpm install --frozen-lockfile`, and
`pnpm audit --prod --audit-level high` pass. The complete workspace suite passes **2,491 tests across all 12 packages/apps**. Chromium passes **15 end-to-end
journeys**, including real multipart service-worker capture, HTTP failure/retry,
server content retrieval with exact byte comparison, persisted bibliographic edits,
PDF rendering, folder ingestion and review decisions. The web unit suite passes
269 tests; the rules suite passes 256 after the schema-reference update.

Raw command receipts: suite `.refinement/2026-10-30/logs/recueil-*.json`.
The README contains the runnable localhost first-use commands. Docker/sidecars,
real scanner/mailbox/Paperless/Zotero migration acceptance, and deployed operation
remain external gates; no published image, release or production acceptance is claimed.

## Critical: WebDAV response size limit disabled

Confirmed in committed HEAD, `packages/ingest-sources/src/webdav/client.ts`: `if (total > limit && false)` prevents the bounded reader from ever enforcing `maxListingBytes` or `maxObjectBytes`. Both broad test runs lost the WebDAV worker while feeding an unbounded response. The conditional is restored and the existing adversarial stream tests are retained unchanged. The complete source package now passes, including cancellation and normal WebDAV ingestion.

### Performance-test measurement repairs

The simhash fixture counted every generated word as eight characters, so its claimed 4 MiB baseline was below the implementation's actual 4 MiB bound. Count real characters and assert exact input sizes and prefix-identical output. The PDF/TEI ratio checks use five interleaved samples and warmed inputs to avoid single scheduler/JIT outliers; original growth factors and absolute ceilings remain, with the ceiling checked for every sample.

An isolated 2/8 MiB PDF probe measured approximately 3/12 ms CPU while wall time varied with scheduling. Complexity ratios now compare process CPU work, with the original 2-second wall ceiling separately asserted on every call. This avoids attributing other running jobs to the parser while retaining both complexity and responsiveness checks.

The final workflow review pinned all eight third-party actions in the container release workflow to verified upstream commit SHAs, preserving their existing major versions and tag-triggered publication behavior. All suite workflow YAML parses; no container build, registry publication or remote workflow result is implied.

## Linux CI follow-up — 2026-10-31

The first published revision's browser job passed, but both Node 22 and Node 24 source jobs failed the existing replacement-file regression on Linux. Inode numbers can be reused immediately after unlink; checking only device/inode therefore allowed replacement bytes to be imported under the original candidate's metadata.

The reader now captures bigint filesystem statistics at scan time and verifies identity, size, modification/change timestamps and birth time at nanosecond precision on the open descriptor before and after its bounded read. A changed file is refused without being imported. The existing size-budget error remains the first result for an oversized in-place rewrite. Revision strings retain the former `stat().mtimeMs` conversion so unchanged files are not presented as new revisions.

A new real-file regression was observed failing before the repair: rewriting the same inode with equal-size bytes and restoring its exact mtime was accepted. It now complements the unchanged Linux replacement-file test. A second regression protects fractional-millisecond revision compatibility. Validation receipts and the follow-up remote CI result are recorded with the final publication evidence; no failed or interrupted run is counted as passing.

Local follow-up evidence: `recueil-file-identity-focused-final` passes all 9 selected source/TOCTOU cases (35 unrelated cases intentionally outside that focused command). Ingest typechecking and affected-file ESLint both pass; the combined wrapper then encountered a missing optional `tsx` harness command, so it is not recorded as an overall pass. The compiled production-code probe `recueil-file-identity-negative-time` separately passes all five actual pre-1970 timestamp fixtures. Two interrupted broad local runs are retained as interrupted; the unchanged full Node 22/24 CI jobs will provide the complete-suite result for the follow-up commit.
