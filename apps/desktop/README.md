# `@recueil/desktop`

The Recueil desktop application for Linux, Windows and macOS: the web client (`apps/web`) in a
Tauri 2 window, connected to a Recueil server (CONCEPT.md §5.14, ADR-0007). Licence
AGPL-3.0-or-later.

## Scope

This is **phase A** of [`docs/platform-roadmap.md`](../../docs/platform-roadmap.md) and
[ADR-0023](../../spec/adr/0023-desktop-shell-connects-before-it-bundles.md) (proposed): a client of a
server that runs elsewhere — from a source checkout, in the container from `deploy/`, or on another
machine over HTTPS. It does not start a server of its own yet.

| Not here yet | Where it is planned |
|---|---|
| The built-in server (sidecar), so the application works without one running | Phase B, CONCEPT.md Phase 4 — platform roadmap §4.6 |
| Watched folders, tray, `recueil://` URI scheme, open-in-external-app, auto-update | CONCEPT.md Phase 4 (PM7) |
| Signed and notarised packages, GitHub releases | PM4, PM5 |

## How it works

The window opens on the **connection page** (`shell/connect.html`). It checks the configured server —
on the first run, `http://127.0.0.1:3000`, where `recueil serve` listens — and hands over to the web
client the moment the server answers and accepts this application. When it cannot, it stays and
says why:

| What happened | What the page says |
|---|---|
| Nothing answered | No server is reachable; how to start one; or enter another address |
| Something answered but refused the window's origin | Set `RECUEIL_CORS_ORIGIN` on the server, with the exact value |
| The API refused without a token | The server requires an API token; enter one |
| The API refused the token | It is unknown, expired, revoked, or lacks the scope |
| `/health` was not Recueil's, or reported an error | Which of the two |

From inside the library, *Server → Connection settings…* (`Ctrl`/`Cmd`+`,`) comes back to the page,
and *Server → Reconnect* checks again.

The web client finds its server through the **host contract**: the assembled `index.html` loads
`shell/host.js` before the client's entry, which defines `globalThis.recueilHost`, and the client
builds its API client from `recueilHost.connection()` — a base URL and an optional token
(`apps/web/src/host.ts`). In a browser there is no host and nothing changes.

## The server has to allow the window

The window's origin is the shell's own, so every request to the server is cross-origin. Start the
server with the shell's origins allowed:

```sh
RECUEIL_CORS_ORIGIN=tauri://localhost,http://tauri.localhost \
  node apps/cli/dist/index.js serve --host 127.0.0.1 --port 3000
```

`tauri://localhost` is the origin on Linux and macOS, `http://tauri.localhost` on Windows. Add them
to any origins already listed.

## Security model

- **Addresses.** `https://` anywhere, plain `http://` only on `127.0.0.1`, `::1` or `localhost`. An
  address with a user name or password, a query or a fragment is refused (`src-tauri/src/connection.rs`).
- **Settings.** `settings.json` in the per-user configuration directory holds the server address and
  nothing else (`$XDG_CONFIG_HOME/com.raban.etabli.recueil/` on Linux,
  `~/Library/Application Support/com.raban.etabli.recueil/` on macOS,
  `%APPDATA%\com.raban.etabli.recueil\` on Windows). A damaged or refused file is reported, not
  trusted, and not silently overwritten.
- **Token.** In the operating system's credential store — Keychain, Credential Manager, Secret
  Service — one entry per server address. Where no store answers, a token is held in memory for the
  session and the page says so. It is never written to a file.
- **Capabilities.** The window may call four commands of the shell's own (`shell_state`,
  `check_server_url`, `save_connection`, `connection`) and nothing from Tauri's core or any plugin
  (`src-tauri/capabilities/main.json`).
- **Content security policy.** Scripts, styles, workers, fonts and the manifest come from the bundle
  only. The network, image and embedding directives admit loopback HTTP and HTTPS, because the server
  address is chosen at run time; no remote script can load (`src-tauri/tauri.conf.json`).
- **Navigation.** The window stays on the bundle and the configured server. Other `http`, `https` and
  `mailto` links open in the system browser; anything else — `file:`, `data:`, other schemes — is
  blocked. New windows are never opened.

## Building and running

From the repository root, after `pnpm install --frozen-lockfile`. Rust 1.90 or newer is needed, and
on Linux the WebKitGTK build dependencies (`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
libdbus-1-dev`).

```sh
pnpm --filter "@recueil/desktop..." run build                  # web client + shell pages → apps/desktop/dist
pnpm --filter @recueil/desktop test                             # unit tests: probe, wording, host contract
pnpm --filter @recueil/desktop typecheck
(cd apps/desktop/src-tauri && cargo test --locked)              # address, navigation and settings rules
pnpm --filter @recueil/desktop exec tauri dev                   # a debug window
pnpm --filter @recueil/desktop exec tauri build --bundles deb   # or appimage, msi, dmg
```

`tauri build` and `tauri dev` run the frontend build themselves (`beforeBuildCommand`,
`beforeDevCommand`). `tauri dev` serves the assembled bundle from its own development server, so the
debug window's origin is `http://127.0.0.1:1430` and a server it talks to has to list that origin
too; the connection page names it.

Packages land in `src-tauri/target/release/bundle/`. `.github/workflows/desktop.yml` builds the
`.deb` and AppImage on Ubuntu 24.04, the MSI on Windows and the DMG on macOS, and uploads them as
workflow artifacts; none is signed.

## Layout

```
shell/            the connection page, the host script and the logic both use
  connect.html    the page the window opens on
  connect.ts      checks the server, hands over, edits the settings
  probe.ts        "is this a Recueil server this window can use?"
  diagnosis.ts    what the page says about each outcome
  bridge.ts       the four shell commands, typed
  host.ts         installs globalThis.recueilHost for the web client
scripts/
  assemble.mjs    copies apps/web/dist, builds shell/ into dist/shell, loads host.js in index.html
src-tauri/        the Rust shell
  src/lib.rs          window, menu, commands, navigation policy
  src/connection.rs   which addresses are accepted, where the window may navigate
  src/settings.rs     the settings file
  src/credentials.rs  the system credential store
  capabilities/       the window's permissions
  linux/              the desktop entry template and the Debian copyright file
test/             unit tests (Vitest)
```

## Verified

On Linux only, on 2026-11-08, with the packaged binary: the `.deb` (`etabli-recueil_0.1.0_amd64.deb`)
and the AppImage built and inspected; headless launches under `xvfb-run`, with an isolated D-Bus
session, showed the first-run page with no server, the `RECUEIL_CORS_ORIGIN` diagnosis against a
server that refused the origin, the library against a local server, an off-loopback `http://`
address refused, and a token typed into the page stored in an isolated Secret Service and used on
the next launch without being written to any file. Windows and macOS are built by CI only and have
not been run.

Known limit: the reader loads a PDF by URL without the bearer token, so against a server that
requires a token the library works and the reader does not — the browser client has the same limit
until it has a sign-in.
