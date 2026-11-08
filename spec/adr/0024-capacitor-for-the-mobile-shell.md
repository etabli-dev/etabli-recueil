# 0024 — Capacitor for the mobile shell

- **Status:** Proposed
- **Date:** 2026-11-08
- **Phase:** Phase 2 (governs Phase 8)

## Context

ADR-0007 chooses Tauri 2 for all five platforms and names Capacitor as the documented fallback "if
Tauri mobile proves immature". CONCEPT.md §5.14 and Phase 8 define what the phone is for: capture
first — a camera document scan with edge detection, barcode lookup of ISBNs and DOIs, a share-sheet
"save to library" — then reading cached PDFs with annotations, queued writes and search, and no
management UI. The Phase 8 exit is "phone capture to library in under thirty seconds".

The desktop decision (ADR-0023) does not settle mobile. The comparison that matters is the three
capture use cases, checked against what each framework provides on 2026-11-08:

| Use case | Tauri 2 mobile | Capacitor 8 |
|---|---|---|
| Camera document scan with edge detection | No official plugin. A Tauri mobile plugin in Kotlin (ML Kit document scanner) and Swift (VisionKit) has to be written and maintained | Official `@capacitor/camera`; maintained community plugins scan documents with edge detection on both platforms, on Android through the ML Kit document scanner |
| Barcode (ISBN, DOI) | Official `barcode-scanner` plugin | Maintained ML Kit barcode plugin for Android and iOS |
| Share target ("save to library") | No official plugin; one community plugin, Android only, last released in 2024. An iOS share extension is an extra Xcode target outside Tauri's generated project | A maintained community share-target plugin; the iOS and Android projects are ordinary, committed native projects, so a share extension is an Xcode target like any other |
| Offline queue of captures | Written in the web layer (IndexedDB) or in Rust; either works | Written in the web layer (IndexedDB), with official network-status and filesystem plugins |

Both run the same React bundle in the system web view, and both can answer the web client's host
contract (`apps/web/src/host.ts`), so the client code does not depend on the choice. Neither needs
Rust on the phone: the server is the source of truth (P1) and the mobile shell is thin.

## Decision

Recommended to the owner: build `apps/mobile` on **Capacitor**, superseding ADR-0007 for iOS and
Android only. Desktop stays on Tauri 2 (ADR-0007, ADR-0023).

- The capture flows use maintained plugins rather than plugins written here: document scanning,
  barcode scanning and the share target. Each is pinned, and its licence and permissions are
  reviewed before it is added.
- A capture goes into an on-device queue first and is uploaded to `POST /api/v1/ingestion/upload`,
  the endpoint the PWA's share target already uses, when the server answers. The queue is the
  offline model of CONCEPT.md §5.14: the server wins and a refused upload stays in the queue for
  manual replay.
- The server address and token follow ADR-0023: HTTPS only (a phone is never on the server's
  loopback), and the token in the platform's secure storage (Keychain, Android Keystore).

This record stays **Proposed** until the owner accepts it; until then CONCEPT.md §5.14 and ADR-0007
describe the plan of record.

## Consequences

Phase 8's capture work becomes integration and testing rather than writing two native plugins per
use case. The plugins that make that true are third-party: each is a dependency to pin, audit and
replace if it is abandoned, which is the cost P7 accepts everywhere else.

The project carries two shell technologies instead of one: Tauri for desktop, Capacitor for mobile,
each with its own toolchain, CI jobs and update cadence. The shared surface between them is the web
bundle and the host contract, which is where it already was.

The Android document-scanning path through ML Kit depends on Google Play services, which F-Droid does
not accept. An F-Droid build would need a flavour without it — edge detection in the web layer or a
FOSS library — and is not planned until someone asks for it.

If the owner prefers one shell technology, the alternative is Tauri 2 mobile with a Phase 8 that
starts by writing a document-scanner and a share-target plugin for both platforms; the platform
roadmap lists the extra milestones that would add.
