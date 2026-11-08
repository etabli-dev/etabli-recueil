---
title: "Platform roadmap"
subtitle: "Ubuntu and Debian, Windows, macOS, iOS and Android: what runs where, how it is built, and what comes next"
---

This document plans Recueil's clients on five platforms. It sits beside the [roadmap](roadmap.qmd),
which summarises the product phases of
[CONCEPT.md §7](https://github.com/etabli-dev/etabli-recueil/blob/main/CONCEPT.md); where the two
touch, the phases there are authoritative and this page says which phase each step belongs to. It
describes the state of 2026-11-08.

The milestones below are numbered **PM1, PM2, …** (platform milestones), so that they cannot be
confused with the product milestones M1–M6 of CONCEPT.md.

## 1. Platform role

Recueil runs on **both** desktop and phone, with different jobs.

- **Desktop — Ubuntu and Debian, Windows, macOS** — is where the library is worked on: screening
  and analysis, reading and annotating PDFs, the review queue, rules and sources. It is the full web
  client in a window of its own, and in local mode (phase B below) it also carries its own server.
- **Phone — iOS and Android** — is for capture and quick lookups: a camera document scan, a barcode
  lookup of an ISBN or DOI, "save to library" from the share sheet, reading cached PDFs and searching.
  There is deliberately no management interface on the phone (CONCEPT.md §2, non-goals).

Every platform is a client of the same server and the same REST contract (ADR-0001, P6). The web
client in a browser, installable as a PWA, remains the fallback on any platform not yet covered.

## 2. Current state

| Platform | Status | Technology | How it is built | What is verified | Distribution |
|---|---|---|---|---|---|
| Ubuntu / Debian | Phase A in the tree: a client of a running server | Tauri 2.12 shell around the built web client, WebKitGTK 4.1 | `pnpm --filter @recueil/desktop exec tauri build --bundles deb,appimage` | Locally on Ubuntu 26.04 x86_64, 2026-11-08: `.deb` and AppImage built; package inspected with `dpkg-deb -I/-c`; headless launches under `xvfb-run` of the packaged binary and the AppImage — first-run page with no server, the page naming the missing `RECUEIL_CORS_ORIGIN` against a server that refuses the origin, the library loaded against a local server, an address off loopback refused, and a token typed into the page stored in an isolated Secret Service and reused on the next launch; a `tauri dev` debug window launched the same way; 11 Rust and 10 TypeScript unit tests in the shell and 5 for the host contract in the web client. The CI job is written and has not run yet | Workflow artifact only, unsigned; no release |
| Windows | Phase A source; same code | Tauri 2.12, WebView2 | `tauri build --bundles msi` on `windows-latest` | Not verified locally (CI only); the CI job has not run yet | Workflow artifact only (unsigned MSI) |
| macOS | Phase A source; same code | Tauri 2.12, WKWebView | `tauri build --bundles dmg` on `macos-15` (Apple silicon) | Not verified locally (CI only); the CI job has not run yet | Workflow artifact only (unsigned, not notarised; arm64 only) |
| iOS | Not started; `apps/mobile` is a placeholder | Recommended: Capacitor 8 ([ADR-0024](https://github.com/etabli-dev/etabli-recueil/blob/main/spec/adr/0024-capacitor-for-the-mobile-shell.md), proposed). Today: the web client in Safari | — | Nothing on a device | None. Safari can add the web client to the home screen; iOS does not support the PWA share target |
| Android | Not started | As iOS. Today: the web client and its PWA, whose manifest declares a share target (Phase 2) | — | Nothing on a device; the PWA share target is covered by unit tests only | None |

The server itself is unchanged by any of this: it runs from a source checkout on Node 22, or in the
container described in [`deploy/README.md`](https://github.com/etabli-dev/etabli-recueil/blob/main/deploy/README.md).

## 3. Architecture

### Now

```
apps/web  ── vite build ──>  apps/web/dist ──┐
                                             ├─ scripts/assemble.mjs ─> apps/desktop/dist ─> embedded by Tauri
apps/desktop/shell (connect.html, host.ts) ──┘

window (tauri://localhost, or http://tauri.localhost on Windows)
   │  HTTPS, or plain HTTP to the loopback interface; ordinary CORS requests
   ▼
Recueil server (apps/server) — wherever it runs; RECUEIL_CORS_ORIGIN lists the shell's origin
```

- **One web bundle.** The browser, the desktop window and — later — the phone all run the build of
  `apps/web`. Nothing in the client is forked per platform.
- **One host contract.** A shell that serves the bundle from its own origin defines
  `globalThis.recueilHost` before the client starts; the client asks it one question — where is the
  server, and with which token — and builds its API client from the answer
  ([`apps/web/src/host.ts`](https://github.com/etabli-dev/etabli-recueil/blob/main/apps/web/src/host.ts)).
  In a browser there is no host and the client uses relative paths as before.
- **A thin native shell.** The Rust side of `apps/desktop` holds the server address in a settings
  file, the token in the operating system's credential store, grants the window four commands and
  nothing from Tauri's core, enforces a strict content security policy and keeps navigation inside
  the bundle and the configured server
  ([ADR-0023](https://github.com/etabli-dev/etabli-recueil/blob/main/spec/adr/0023-desktop-shell-connects-before-it-bundles.md)).

### Target

- **Desktop phase B** adds the server as a sidecar: the same server code as the container (ADR-0001),
  started by the shell on `127.0.0.1` with an ephemeral port and a per-launch token, and stopped with
  it. The connection page becomes the switch between the built-in server and another one.
- **Mobile** (CONCEPT.md Phase 8) wraps the same bundle in a native shell that answers the same host
  contract, plus a capture layer — document scanner, barcode scanner, share target, an on-device
  upload queue — and a compact capture, search and reading layout inside `apps/web`, selected when
  the host says it is a phone.
- Code shared across all five platforms is therefore the web client, the REST client in it and the
  host contract; code shared across the three desktops is the whole of `apps/desktop`; nothing
  platform-specific lives in the server.

## 4. Per-platform execution

### Shared: build, test and run the desktop shell

Prerequisites: Node 22, pnpm 9.15.4, Rust 1.90 or newer (CI pins 1.93.1), and the platform's web
view build dependencies (Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libdbus-1-dev`).

```sh
pnpm install --frozen-lockfile
pnpm --filter "@recueil/desktop..." run build    # the web client, its dependencies and the shell pages → apps/desktop/dist
pnpm --filter @recueil/desktop test               # shell unit tests (probe, wording, host contract)
(cd apps/desktop/src-tauri && cargo test --locked) # address policy, navigation policy, settings file
pnpm --filter @recueil/desktop exec tauri build --bundles deb,appimage   # or msi / dmg
pnpm --filter @recueil/desktop exec tauri dev     # a debug window; its origin is http://127.0.0.1:1430
```

A local server the window may talk to, from the same checkout:

```sh
pnpm build
RECUEIL_CORS_ORIGIN=tauri://localhost,http://tauri.localhost \
  node apps/cli/dist/index.js serve --host 127.0.0.1 --port 3000
```

### Where the server runs

| Client | Now (desktop phase A) | Target |
|---|---|---|
| Ubuntu / Debian desktop | `recueil serve` from source on loopback; the container from `deploy/` on `127.0.0.1:3000`; or any server over HTTPS | The built-in sidecar (phase B); another server stays selectable |
| Windows desktop | From source on Node 22, or Docker Desktop, on loopback; or any server over HTTPS | The built-in sidecar |
| macOS desktop | From source, or Docker Desktop or Colima, on loopback; or any server over HTTPS | The built-in sidecar |
| iOS, Android | — | Always a server reachable over HTTPS: a home server or VPS behind a TLS reverse proxy, or a tailnet with HTTPS certificates. `RECUEIL_REQUIRE_AUTH=true` and one scoped token per device |

Every server a desktop window talks to lists the shell's origins in `RECUEIL_CORS_ORIGIN`
(`tauri://localhost` on Linux and macOS, `http://tauri.localhost` on Windows). A sidecar listens on
loopback only and is never reachable from a phone: a library used from a phone lives on an always-on
server, which is the server-first model (ADR-0001), not a gap in it.

### 4.1 Ubuntu and Debian

- **Packages.** `etabli-recueil_<version>_amd64.deb` (depends on `libwebkit2gtk-4.1-0`,
  `libgtk-3-0`, `libdbus-1-3`; installs `/usr/bin/etabli-recueil`, a desktop entry, icons, the
  licence and a DEP-5 copyright file) and `etabli-recueil_<version>_amd64.AppImage` (self-contained,
  about 85 MiB). Install with `sudo apt install ./etabli-recueil_<version>_amd64.deb`.
- **Baseline.** CI builds on Ubuntu 24.04, so the `.deb` needs glibc 2.39: Ubuntu 24.04 or newer,
  Debian 13 or newer. Building on an older image would widen that (owner decision below).
- **Flatpak and Snap: not now.** A Flathub build needs a source manifest with vendored npm and cargo
  dependencies; the `.deb` and the AppImage cover Ubuntu, Debian and everything else until a
  distribution asks for more.
- **Credential store.** The Secret Service (GNOME Keyring, KWallet). Without one the window keeps a
  token for the session only and says so.
- **Signing.** Debian packages handed out as files are not signed individually. Publish a
  `SHA256SUMS` file and GitHub build-provenance attestations with each release — `release.yml`
  already attests the container image the same way. A signed APT repository is possible later and
  not planned. Secrets needed: none beyond the workflow's own token.
- **CI.** `.github/workflows/desktop.yml`, Linux leg: unit tests, `tauri build --bundles
  deb,appimage`, `cargo test`, `dpkg-deb` inspection, artifact `recueil-desktop-linux-x86_64`.
- **Acceptance.** On clean Ubuntu 24.04 and Debian 13 machines: the package installs with no
  missing dependency; the application starts from the desktop menu; with no server it shows the
  first-run page; against a server started as above it opens the library, the reader and the review
  queue; a token stored in GNOME Keyring survives a restart; removal leaves no files behind; and the
  PDF.js reader passes the WebKitGTK performance test CONCEPT.md Phase 4 names as a risk (a 300-page
  PDF, page turn and text search timed against Chromium).

### 4.2 Windows

- **Package.** An MSI (WiX, x64) built by Tauri. MSIX is not produced by Tauri's bundler and would
  need separate tooling for no gain at this stage; the MSI serves direct download and winget.
- **Web view.** WebView2. The MSI downloads the Evergreen runtime if it is missing, which needs a
  network connection during installation; Tauri can embed an offline installer instead, at about
  130 MB more (owner decision below).
- **Origin.** `http://tauri.localhost`, which the server must allow.
- **Credential store.** Windows Credential Manager.
- **Signing.** Unsigned for now, so SmartScreen warns. Either Azure Trusted Signing (Microsoft-managed;
  identity validation; secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and the
  account and profile names) or an OV code-signing certificate (`WINDOWS_CERTIFICATE` as base64 PFX,
  `WINDOWS_CERTIFICATE_PASSWORD`), wired through Tauri's `bundle.windows` signing settings.
- **CI.** `desktop.yml`, Windows leg: unit tests, `tauri build --bundles msi`, artifact
  `recueil-desktop-windows-x86_64`. Not verified locally (CI only).
- **Acceptance.** On a clean Windows 11 machine: the MSI installs, the Start menu entry opens the
  first-run page, the window connects to a loopback server and to an HTTPS server, a token lands in
  Credential Manager and survives a restart, uninstalling removes the program; after PM5,
  `signtool verify /pa` passes and SmartScreen names the publisher.

### 4.3 macOS

- **Package.** `Recueil.app` in a DMG, minimum macOS 11. The `macos-15` runner builds for Apple
  silicon only; a universal binary for Intel Macs (`--target universal-apple-darwin`) is PM7.
- **Origin.** `tauri://localhost`.
- **Credential store.** The login Keychain.
- **Signing and notarisation.** Unsigned for now: Gatekeeper refuses the first launch until the
  user opens it from the context menu or *System Settings → Privacy & Security*. Signing needs an
  Apple Developer Program membership and a *Developer ID Application* certificate (`APPLE_CERTIFICATE`
  as base64 .p12, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`); notarisation needs an App
  Store Connect API key (`APPLE_API_ISSUER`, `APPLE_API_KEY`, and the .p8 file). Tauri signs,
  notarises and staples when these are present. The Mac App Store is not planned: its sandbox and
  the phase B sidecar pull in opposite directions, and a notarised DMG reaches the same users.
- **CI.** `desktop.yml`, macOS leg: unit tests, `tauri build --bundles dmg`, artifact
  `recueil-desktop-macos-arm64`. Not verified locally (CI only).
- **Acceptance.** On a clean macOS 15 machine: the DMG opens, the app runs from Applications, it
  connects to a loopback and an HTTPS server, a token lands in the Keychain; after PM5,
  `spctl --assess --type execute` accepts the app and `xcrun stapler validate` passes; after PM7 the
  universal build runs on an Intel Mac.

### 4.4 iOS

- **Technology.** `apps/mobile` on Capacitor 8 if the owner accepts ADR-0024; otherwise Tauri 2
  mobile, with PM9 growing by a document-scanner and a share-target plugin written here for both
  platforms. The comparison against the capture use cases is in that ADR.
- **Build.** `pnpm --filter @recueil/mobile exec cap sync ios`, then Xcode 16 or newer on macOS:
  `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release archive`, then
  `xcodebuild -exportArchive` for App Store distribution. The share extension is a second Xcode target
  sharing an App Group with the app.
- **Distribution.** TestFlight for internal testing, then App Store review and release. The privacy
  label is short: no tracking, and data goes only to the user's own server. Camera and photo-library
  usage strings are required.
- **Signing prerequisites.** The same Apple Developer Program membership as macOS; App IDs for the
  app and the share extension; an App Group; a distribution certificate and provisioning profiles,
  or automatic signing with the App Store Connect API key; an App Store Connect app record. Secrets:
  `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY` (base64
  .p8), `IOS_DISTRIBUTION_CERTIFICATE` (base64 .p12) and its password.
- **Server.** HTTPS only (App Transport Security); the token in the Keychain; the server's
  `RECUEIL_CORS_ORIGIN` lists `capacitor://localhost`, unless the shell's native HTTP is used.
- **CI.** A `mobile.yml` job on `macos-15`: a simulator build on every pull request touching
  `apps/mobile` or `apps/web`, a signed archive uploaded to TestFlight on a version tag.
- **Acceptance.** On a real iPhone: a three-page paper document scanned, uploaded and searchable in
  under thirty seconds (the Phase 8 exit); a PDF shared from Files and from Safari arrives through
  the share sheet; an ISBN barcode becomes an ingested item; a capture made in flight mode is
  uploaded after reconnecting, and one the server refuses stays in the queue with its reason.

### 4.5 Android

- **Technology.** As iOS.
- **Build.** `pnpm --filter @recueil/mobile exec cap sync android`, then Gradle with JDK 21 and the
  Android SDK: `./gradlew assembleRelease bundleRelease`.
- **Distribution.** A signed APK attached to each GitHub release, and an AAB to Google Play
  (internal testing, then closed testing — which a new personal developer account must run with
  enough testers for long enough before production access — then production). **F-Droid is not
  planned**: the ML Kit document scanner depends on Google Play services, and an F-Droid flavour
  would need a scanner without it (ADR-0024).
- **Signing prerequisites.** An upload keystore (Play App Signing holds the app signing key):
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`;
  a Google Play developer account and a service-account key for uploads (`PLAY_SERVICE_ACCOUNT_JSON`).
- **Server.** HTTPS only (cleartext traffic is off by default); the token in Keystore-backed secure
  storage; `RECUEIL_CORS_ORIGIN` lists `https://localhost` (Capacitor's Android origin), unless the
  shell's native HTTP is used.
- **CI.** A `mobile.yml` job on `ubuntu-24.04`: `assembleDebug` on pull requests, signed APK and AAB
  on a version tag, APK checksum and attestation published with the release.
- **Acceptance.** As iOS, on a real Android 10 or newer phone, plus: the APK from the release
  installs and its SHA-256 matches `SHA256SUMS`; the Play internal-testing build installs from the
  store.

### 4.6 Desktop phase B — the sidecar

Phase B belongs to CONCEPT.md Phase 4 ("Tauri desktop v1"). It is not started, and each step has a
check that says when it is done.

1. **Bundle the server.** One ESM file built from `apps/server`'s entry with esbuild or rolldown.
   `better-sqlite3` is a native addon: add a `nativeBinding` path to the database client in
   `packages/core` (`better-sqlite3` accepts one) so the addon can sit next to the executable.
   *Done when* the bundled file passes the health smoke check of `scripts/smoke-health.mjs`, pointed
   at the bundle instead of the CLI, against a throwaway library on all three operating systems.
2. **Make it an executable.** A Node single executable application (`node --experimental-sea-config`
   and `postject`, Node 22) per target triple, shipped through Tauri's `bundle.externalBin` as
   `binaries/recueil-server-<target-triple>`, with `better_sqlite3.node` as a bundled resource. If
   the single executable gets in the way of signing, the fallback is the plain Node binary as the
   external binary and the bundle as a resource. On macOS both executables and the addon are signed
   with the hardened runtime and the `com.apple.security.cs.allow-jit` entitlement V8 needs.
3. **Data directory.** Tauri's `app_local_data_dir()` plus `library/`: on Linux
   `~/.local/share/com.raban.etabli.recueil/library`, on macOS
   `~/Library/Application Support/com.raban.etabli.recueil/library`, on Windows
   `%LOCALAPPDATA%\com.raban.etabli.recueil\library` (local, not roaming: a library is large). The
   shell sets `RECUEIL_DATABASE_URL` and `RECUEIL_STORAGE_PATH` there and never writes into the
   installation directory. `recueil backup` is documented against this path.
4. **Port.** `RECUEIL_HOST=127.0.0.1`, `RECUEIL_PORT=0`. The server already knows the port the
   kernel assigned (`start()` returns the URL); in `RECUEIL_MODE=sidecar` it prints one line,
   `recueil-sidecar listening http://127.0.0.1:<port>`, on standard output. The shell waits for it
   for at most twenty seconds and then probes `/health`.
5. **Credential.** The shell draws 32 random bytes per launch and passes them in a new
   `RECUEIL_SIDECAR_TOKEN`, honoured only in sidecar mode, never stored, with
   `RECUEIL_REQUIRE_AUTH=true` — so no other local process or user can use the API on that port —
   and `RECUEIL_CORS_ORIGIN` set to the shell's origin. This is a change to the authentication
   contract and gets its own ADR.
6. **Supervision.** The shell starts the process itself (`std::process`, no shell plugin and no
   permission granted to the window), writes its output to the application log directory with
   rotation, and restarts it after an unexpected exit with back-off — three attempts a minute —
   before showing the connection page with the log's location.
7. **Shutdown.** On exit the shell closes the sidecar's standard input; in sidecar mode the server
   treats end-of-input as its shutdown signal, which works on Windows, where there is no `SIGTERM`,
   and when the shell itself crashes. The server drains within `RECUEIL_SHUTDOWN_TIMEOUT_MS`; the
   shell kills it two seconds after that. *Done when* no server process outlives the window on any
   of the three systems, after a normal quit and after the shell is killed.
8. **One instance.** `tauri-plugin-single-instance`, so a second launch focuses the first window
   instead of starting a second server on the same SQLite file, and a lock file in the data
   directory as the second guard.
9. **Choice.** The connection page offers "This computer (built-in server)", the default on a new
   installation, and "Another server", which is phase A unchanged.
10. **Size.** A Node runtime adds roughly 35–45 MB to each compressed installer. Measured and
    recorded in PM6, not assumed.

## 5. Milestones

In order; each can be picked up from its exit criterion alone.

| # | Milestone | Exit criterion |
|---|---|---|
| **PM1** | Desktop phase A in the tree | The shell, the host contract, ADR-0023, ADR-0024, `desktop.yml` and this page committed; the Linux `.deb` and AppImage built and launched as recorded in §2. **Done locally on Linux on 2026-11-08**; CI has not run |
| **PM2** | First green `desktop.yml` on all three systems | One workflow run green on `ubuntu-24.04`, `windows-latest` and `macos-15`; each artifact downloaded and launched on its platform against a server with the shell's origin allowed; the run URL and results recorded in `docs/current-status.qmd` |
| **PM3** | Linux acceptance and the WebKitGTK reader test | §4.1 acceptance on clean Ubuntu 24.04 and Debian 13; reader timings recorded beside Chromium's |
| **PM4** | Desktop artifacts on releases | A `v*` tag produces a draft GitHub release carrying the `.deb`, AppImage, MSI and DMG, a `SHA256SUMS` file and build-provenance attestations (`contents: write` granted to that one job only); `gh attestation verify` passes for each file. Third-party licence notices for the npm and cargo dependencies ship inside each package |
| **PM5** | Signed desktop packages | macOS: Developer ID signed, notarised and stapled; Windows: Authenticode signed. The checks in §4.2 and §4.3 pass |
| **PM6** | Phase B: the built-in server | §4.6 steps 1–10. On all three systems a new installation with no server opens an empty library without a terminal; the library survives a restart and an upgrade; quitting leaves no server process; a backup of the sidecar library restores |
| **PM7** | Desktop v1 (CONCEPT.md Phase 4) | Watched folders, tray, the `recueil://item/<id>` URI scheme, open-in-external-app, signed auto-update (`TAURI_SIGNING_PRIVATE_KEY`), a universal macOS build; the Phase 4 exit — annotate, note and cite inside the desktop shell |
| **PM8** | Mobile decision and skeleton (CONCEPT.md Phase 8) | ADR-0024 accepted or replaced; `apps/mobile` (`@recueil/mobile`) wraps the web bundle and answers the host contract; `mobile.yml` builds an iOS simulator app and a debug APK; both connect to an HTTPS server with the token in secure storage |
| **PM9** | Mobile capture | Document scan, barcode, share target, the on-device queue, and the compact layout in `apps/web`; the Phase 8 exit on a real iPhone and a real Android phone (§4.4, §4.5) |
| **PM10** | Store distribution | TestFlight, then the App Store; signed APK on GitHub releases; Google Play internal testing, then production |

PM8–PM10 are CONCEPT.md Phase 8 work and follow its sequencing rules: Phase 8 is cheap once the API
is stable, and it does not jump the critical path of Phases 1–3. PM2–PM5 can run at any time; PM6
needs the server changes in §4.6 steps 1, 4, 5 and 7.

## 6. Owner decisions and prerequisites

- **ADR-0023 and ADR-0024** are proposed. Accepting ADR-0023 records the desktop split into phases A
  and B; accepting ADR-0024 moves mobile from Tauri to Capacitor and supersedes ADR-0007 for iOS and
  Android only.
- **Application identifier.** The shell uses `com.raban.etabli.recueil`, following the suite's
  identifiers. It names the settings and data directories and the credential-store entries, and it
  becomes permanent with the first signed or store release — confirm it before PM4.
- **Linux baseline.** Build on Ubuntu 24.04 (24.04 and Debian 13 onwards) or on an older image for
  wider reach.
- **Apple Developer Program** (one membership covers macOS and iOS): the Developer ID and
  distribution certificates, the App Store Connect API key, the App IDs and App Group.
- **Windows signing route:** Azure Trusted Signing or an OV certificate.
- **WebView2 installation mode** for the MSI: download on demand (default) or the offline installer.
- **Google Play developer account** and its testing requirement for personal accounts; F-Droid stays
  out unless a scanner without Google Play services is wanted.
- **Phase B packaging:** a Node single executable or the plain Node runtime as the sidecar, and the
  sidecar-token change to the server's authentication.
- **Release cadence:** whether every `v*` tag also carries desktop packages, or only some.
