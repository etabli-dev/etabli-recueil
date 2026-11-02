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
- CI runs frozen install, lint, build, typing, spec validation, tests and production dependency audit on Node 22/24, plus Chromium against the built client and real API/SQLite. These checks were initially prepared locally; the observed remote result is recorded below.

Local results on 2026-10-30: `pnpm build`, `pnpm typecheck`, `pnpm lint`,
`pnpm check:spec`, `pnpm install --frozen-lockfile`, and
`pnpm audit --prod --audit-level high` passed. The complete workspace suite passed **2,491 tests across all 12 packages/apps**, before the five filesystem regressions added below. Chromium passed **15 end-to-end
journeys**, including real multipart service-worker capture, HTTP failure/retry,
server content retrieval with exact byte comparison, persisted bibliographic edits,
PDF rendering, folder ingestion and review decisions. The web unit suite passes
269 tests; the rules suite passes 256 after the schema-reference update.

Raw command receipts: suite `.refinement/2026-10-30/logs/recueil-*.json`.
The README contains the runnable localhost first-use commands. At this October 30 checkpoint, Docker and live-service checks had not run; the November 2 local container results below supersede that Docker limitation. Sidecar integration, real scanner/mailbox/Paperless/Zotero migration acceptance and deployed operation remain separate gates; no published image, release or production acceptance is claimed.

## Critical: WebDAV response size limit disabled

Confirmed in the audited baseline, `packages/ingest-sources/src/webdav/client.ts`: `if (total > limit && false)` prevented the bounded reader from enforcing `maxListingBytes` or `maxObjectBytes`. Both broad test runs lost the WebDAV worker while feeding an unbounded response. The conditional is restored and the existing adversarial stream tests are retained unchanged. The complete source package now passes, including cancellation and normal WebDAV ingestion.

### Performance-test measurement repairs

The simhash fixture counted every generated word as eight characters, so its claimed 4 MiB baseline was below the implementation's actual 4 MiB bound. Count real characters and assert exact input sizes and prefix-identical output. The PDF/TEI ratio checks use five interleaved samples and warmed inputs to avoid single scheduler/JIT outliers; original growth factors and absolute ceilings remain, with the ceiling checked for every sample.

An isolated 2/8 MiB PDF probe measured approximately 3/12 ms CPU while wall time varied with scheduling. Complexity ratios now compare process CPU work, with the original 2-second wall ceiling separately asserted on every call. This avoids attributing other running jobs to the parser while retaining both complexity and responsiveness checks.

The final workflow review pinned all eight third-party actions in the container release workflow to verified upstream commit SHAs, preserving their existing major versions and tag-triggered publication behavior. All suite workflow YAML parses; no container build, registry publication or remote workflow result is implied.

## Linux CI follow-up — 2026-10-31

The first published revision's browser job passed, but both Node 22 and Node 24 source jobs failed the existing replacement-file regression on Linux. Inode numbers can be reused immediately after unlink; checking only device/inode therefore allowed replacement bytes to be imported under the original candidate's metadata.

The reader now captures bigint filesystem statistics at scan time and verifies identity, size, modification/change timestamps and birth time at nanosecond precision on the open descriptor before and after its bounded read. A changed file is refused without being imported. The existing size-budget error remains the first result for an oversized in-place rewrite. Revision strings retain the former `stat().mtimeMs` conversion so unchanged files are not presented as new revisions.

A new real-file regression was observed failing before the repair: rewriting the same inode with equal-size bytes and restoring its exact mtime was accepted. It now complements the unchanged Linux replacement-file test. A second regression protects fractional-millisecond revision compatibility. Validation receipts and the follow-up remote CI result are recorded with the final publication evidence; no failed or interrupted run is counted as passing.

Local follow-up evidence: `recueil-file-identity-focused-final` passes all 9 selected source/TOCTOU cases (35 unrelated cases intentionally outside that focused command). Ingest typechecking and affected-file ESLint both pass; the combined wrapper then encountered a missing optional `tsx` harness command, so it is not recorded as an overall pass. The compiled production-code probe `recueil-file-identity-negative-time` separately passes all five actual pre-1970 timestamp fixtures. Two interrupted broad local runs are retained as interrupted; the completed Node 22/24 CI jobs below provide the complete-suite result separately.

## Watched-folder scan identity (2026-10-31)

Confirmed: a parent directory replaced by an outside symlink between the scan's containment check, metadata read and candidate construction could cause a second `stat` to accept the outside file's identity. Two deterministic tests over real temporary files imported outside bytes before the repair (`recueil-folder-race-before`). The timing hook only selects when the real parent rename/symlink occurs.

Folder scans now capture BigInt metadata once, recheck the canonical path before descending or offering a file, and pass that same metadata into candidate construction. The read-time descriptor checks retain their original reference. A late ancestor switch after the canonical recheck is rejected at read time instead of replacing the checked identity. Existing size-budget and revision formatting remain unchanged.

Verification: `recueil-folder-race-before` observed both outside-read regressions failing before the production change. `recueil-folder-race-after` passed 46 targeted tests. The final `pnpm --filter @recueil/ingest test` run passed all 189 tests across 12 files, including all three timing-boundary regressions (`recueil-folder-race-final`). Ingest typechecking and scoped ESLint passed (`recueil-folder-race-typecheck`, `recueil-folder-race-lint`), with no whitespace errors. Independent review found no material regression in the bounded repair. These are local results; the separately observed Linux CI result follows.

## Published source verification — 2026-10-31

Commit `c4023d7ef38eeedac1c3fb90b405f3f7c6882b23` was published to `main`. Its [completed GitHub Actions run](https://github.com/etabli-dev/etabli-recueil/actions/runs/41200169067) passed frozen installation, build, typing, lint, specification validation, tests and the production dependency audit on both Node 22 and Node 24. Each matrix job passed **2,496 tests across 139 test files in all 12 packages/apps**; these are the same suite executed twice. Both production audits reported no known vulnerabilities at that time. The separate Chromium job passed all **15 browser journeys** against the built client, real API and SQLite.

The suite workspace receipt `recueil-ci-final-results.json` records the exact commit, run URL, complete log hash and per-package counts. It supplements the 189 passing local ingestion tests and preserves the first Linux failure and interrupted local runs as historical evidence. Source publication and successful CI do not establish container deployment, live integrations, backup/recovery or representative real-library acceptance. Those checks remain the next deployment gates; no image, signed release or production deployment is claimed.

## November 2 deployment follow-up: local acceptance

Read-only Docker discovery now finds an existing Colima-backed Linux ARM64 engine; the October 30 missing-Docker baseline is historical. The deployment guide still described Phase 0, unsupported token/bootstrap/worker commands and obsolete backup/restore flags. The local image/Compose path is being aligned with implemented CLI/API behavior: local build by default, bounded build context, current environment settings, API token bootstrap, verified-snapshot commands, and explicitly deferred sidecars. No new application or worker feature is part of this change.

Acceptance for this milestone is a clean-context ARM64 runtime build, healthy isolated startup as the configured unprivileged user, synthetic item/file reads and deduplication, token-required and invalid-input paths, persistence after restart, and a verified backup restored to a separate owned volume with identical document bytes. The check uses only task-owned containers/volumes and preserves the existing Docker engine and unrelated workloads. These local acceptance criteria passed as recorded below; registry release, production deployment and representative real-library recovery are separate gates.

Independent review also corrected the minimum Docker Engine version to 28.0.0 for the loopback-only first-token setup: older engines can expose localhost-published ports to same-network hosts, as documented by [Docker](https://docs.docker.com/engine/network/port-publishing/#publishing-ports). The isolated validation harness checks the server version before build or container creation. The observed local engine 29.5.2 meets this prerequisite.

Observed local results on November 2: the clean-context Linux ARM64 image build completed, including frozen offline installation, workspace compilation and production CLI deployment. The synthetic runtime ran as uid 1000 and passed item/PDF creation, digest-preserving duplicate upload, 415/422 invalid input, first-token creation, 401 rejection of missing/invalid tokens, authenticated readback after recreation, online backup and snapshot verification, and restoration into a separate empty volume. Restored item/document identities and all 2,031 PDF bytes matched the original SHA-256. The real base Compose service, with an isolated project/env/volume and loopback ephemeral port, reached its configured `healthy` state and returned a healthy database/store response over host HTTP. No existing `.env`, library, secret or container was used.

Command evidence: `recueil-container-20261102-r3` exited 0 in 20.7 seconds using cached layers from the completed first image build. `recueil-container-acceptance-20261102.json` and its run directory record source hashes, image identity, API/backup/restore results and Compose `127.0.0.1:32768` acceptance. All five owned containers were confirmed stopped afterward; synthetic volumes and logs were retained. The earlier r1 attempt built successfully but could not bind-mount the Mac workspace through the existing Colima daemon; the test harness now copies its probe/fixture into newly created containers. Attempt r2 passed direct runtime/recovery and Compose health but its extra internal-only test network did not publish the port; r3 uses the base Compose standard bridge and preserves the host-reachability assertion. Both failed attempts remain evidence and are not counted as passes.

This establishes bounded local development container and synthetic recovery acceptance on ARM64. It does not establish a published registry image, AMD64 or multi-architecture runtime, public reverse-proxy/TLS configuration, live integrations, OCR/sidecars, representative real-library migration or production operation. The portable `deploy/smoke.sh`/`smoke-probe.mjs` check and required Ubuntu 24.04 container CI job are extracted from the exercised harness. Existing Node 22/24 and browser commands remain unchanged; CI completion now also requires the container job. The portable no-build extraction passed locally (`recueil-portable-container-20261102`, exit 0 in 19.21 seconds) against immutable image `sha256:59c1856d3818d209758a77cec131efa4afd414c7af07ac3d487f6a768743b4de`, with expected version `0.0.0-local-audit`. It repeated every runtime/recovery/Compose check and confirmed all five containers stopped. Its receipt explicitly identifies supplied-image provenance rather than attributing that image to the newer probe/Compose checkout. Independent review and five mocked-daemon cleanup cases verified that failed ownership inspection, mismatched labels, failed stops and still-running containers cannot produce successful cleanup. At this local verification checkpoint, the new clean-build AMD64 CI job is pending publication; its outcome is not claimed here.
