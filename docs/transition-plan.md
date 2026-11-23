---
title: "Transition plan"
subtitle: "From Phase 2 to 1.0, two-way Zotero sync, and installable apps on six platforms"
---

This plan orders the remaining work: the rest of the product roadmap
([CONCEPT.md §7](https://github.com/etabli-dev/etabli-recueil/blob/main/CONCEPT.md), Phases 3–9),
a two-way sync with zotero.org ([ADR-0025](https://github.com/etabli-dev/etabli-recueil/blob/main/spec/adr/0025-two-way-zotero-sync.md)),
and installable apps for iOS and iPadOS, Android, Windows, Linux and macOS
([platform roadmap](platform-roadmap.md)). It was written on 2026-11-21, against the tree at
`bea6c5f`.

## Ground rules

1. **One step at a time.** Each step below is done on its own branch, and ends with the full local
   gates green, an adversarial audit of the step, a refinement round that closes what the audit
   found, and a written report. The next step starts only after the owner has read that report.
2. **Claims stay honest.** A milestone that needs the owner's own data — the real Zotero library
   (M1), the real scanner, mailbox and Paperless instance (M2), a real manuscript (M3), a real
   systematic review (M5) — is prepared and rehearsed against fixtures, and is not claimed until the
   owner has run it.
3. **One UI.** Every app runs the build of `apps/web`. Platform code is limited to the shell, the
   host contract (`apps/web/src/host.ts`) and the native capabilities the shell exposes: share
   sheet, camera and document scan, file system, tray, URI scheme, credential store.
4. **The server stays the source of truth** (ADR-0001). The one exception is the Zotero sync, which
   is a bridge between two sources of truth with its own conflict rules (ADR-0025), not a sync
   engine between Recueil's own clients.

## Order of work

| Step | Content | Gate at the end |
|---|---|---|
| **Z** | Two-way Zotero sync: `@recueil/sync-zotero`, the Web API client, the state tables, pull, push, three-way merge, held conflicts, files both ways, `recueil sync zotero` (with `conflicts` and `resolve`). Server routes and a conflicts screen in the web client follow with the background job queue, because a sync from the server is a long-running job | Fake-server suite (versions, 412, backoff, deletions, files); a dry run against the owner's account by the owner |
| **3** | Plugin SDK v1 and host; enrichment through eleven resolvers; the thirteen checks and bibliography audit; record dedup with reversible merges; parity tests for Metadata Mender, Attaclone and Argus One (`spec/parity-zotero-plugins.md`). File-layer near-duplicates (simhash) and server routes follow with Phase 4's reading work and the job queue | CONCEPT §7 Phase 3 exit, rehearsed on fixtures; the owner archives the three Zotero plugins and delivers one real manuscript audit |
| **4** | Annotations as records with the reader's highlight layer, annotate → note → cite, PDF export with embedded annotations, structured saved searches, GROBID reference lists for audits. The desktop shell's tray, URI scheme and folder picker move to step P; the Meilisearch backend follows the job runner | Annotate → note → cite inside the app |
| **5** | Graph schema, shadow works, citations from OpenAlex and Crossref, co-citation and coupling, WoS/VOSviewer/GEXF/GraphML/CSV exports, R and Python clients (in `clients/`), the in-app citation map. MeSH co-word maps, Parquet and the deep dive follow | `rc_bibliometrix()` output loads in bibliometrix (checked in CI); biblioshiny on the owner's library |
| **6** | Curated networks: versioned documents, freeze with a metadata snapshot, dangling nodes kept, drag-and-save in the web app, SVG/TikZ/GraphML/GEXF exports, `rc_curated()` | One publication figure end to end, on fixtures; a real paper's figure is the owner's |
| **7** | Systematic review module, specified first in `spec/systematic-review.md`: search runs and imports (RIS, MEDLINE, BibTeX, CSL-JSON) with source tracking, dedup, screening with undo and reasons, live PRISMA 2020 counts and snapshots, extraction forms and RoB instruments, PRISMA2020/robvis/metafor exports checked in CI, `recueil sr`, the screening screen, a Quarto report template. Second screener, Unpaywall retrieval and the deep dive follow with the job queue | A review run on fixtures; PRISMA from live counts. M5 waits for a real review run by the owner |
| **8** | The capture screen and its offline queue in the web client; the Capacitor 8 shell for iOS, iPadOS and Android with native projects, secure token storage, document scan (ML Kit, VisionKit), ISBN barcodes, Android share target, CI debug builds; the own MV3 connector for Chromium and Firefox. iOS share extension and offline reading follow | Phone capture under 30 s and a store listing — both need the owner's devices and accounts; CI builds and unit tests stand in until then |
| **P** | Apps for all six platforms: desktop tray, `recueil://` links and Watch a folder; a `v*` tag builds the desktop packages, the Android APK and the connector and drafts a release with SHA256SUMS and provenance. Signing, notarisation and store uploads need the owner's accounts | Per-platform acceptance list in the platform roadmap |
| **9** | `create-recueil-plugin`, the registry format and first-party index, upgrade guarantees, the newer-library refusal, citation blocks. npm publication, the registry repository, Zenodo and the tag are the owner's | 1.0 tag, by the owner |

Phases 4 and 5 may interleave (CONCEPT §7 sequencing rules); Phase 6 and 7 wait for Phase 5's graph
schema.

## Apps on six platforms

One web bundle, two shell technologies, six packages:

| Platform | Shell | Package | Built on | Native capabilities |
|---|---|---|---|---|
| Linux (Ubuntu, Debian) | Tauri 2, WebKitGTK | `.deb`, AppImage | this host or CI `ubuntu-24.04` | tray, watched folders, URI scheme, Secret Service, built-in server (phase B) |
| Windows | Tauri 2, WebView2 | MSI | CI `windows-latest` | as Linux; Credential Manager |
| macOS | Tauri 2, WKWebView | DMG (arm64, then universal) | CI `macos-latest` or the owner's Mac | as Linux; Keychain; signing and notarisation need the owner's Apple Developer account |
| iOS | Capacitor 8 (ADR-0024) | IPA via TestFlight | CI macOS or the owner's Mac | share extension, document scan, barcode, offline capture queue, Keychain |
| iPadOS | same project as iOS, universal target | same IPA | same | as iOS, plus the full three-pane layout on the larger size classes and pointer/keyboard support |
| Android | Capacitor 8 | AAB/APK | this host (Docker) or CI | share target, ML Kit document scan, barcode, capture queue, Keystore |

What the owner has to provide, and when:

- **Step Z:** a Zotero API key with read/write access (zotero.org → Settings → Security → API keys),
  kept in an environment variable or a file outside the repository, never committed.
- **Step P, Apple:** an Apple Developer account, a signing identity and an App Store Connect API key
  as GitHub Actions secrets; or a Mac on which the builds are run.
- **Step P, Windows:** optionally a code-signing certificate; without one the MSI is unsigned.
- **Step P, Android:** an upload keystore, kept outside the repository.

## Where the work runs

This host builds and tests in Docker (`node:22.23.4-bookworm`, limited to 4 CPUs and 6 GiB so the
running stack is not starved). Linux and Android packages can be built here; Windows, macOS, iOS and
iPadOS packages are built by the existing GitHub Actions workflows on hosted runners.
