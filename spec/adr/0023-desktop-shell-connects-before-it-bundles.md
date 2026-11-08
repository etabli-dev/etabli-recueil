# 0023 — The desktop shell connects to a server before it bundles one

- **Status:** Proposed
- **Date:** 2026-11-08
- **Phase:** Phase 2 (governs Phase 4)

## Context

ADR-0001 and ADR-0007 settle that the desktop application is a Tauri 2 shell around the web client
and that, in local mode, it runs the same server as a sidecar on `localhost`. CONCEPT.md §7 puts
"Tauri desktop v1" in Phase 4, with watched folders, a tray, the URI scheme and open-in-external-app.

Two facts make it worth splitting that into two steps.

- **The sidecar is not small.** The server is Node with a native addon (`better-sqlite3`), so
  shipping it inside an installer means bundling a Node runtime or a single executable per target,
  choosing a per-user data directory on each OS, picking a free port and telling the window about it,
  minting a credential the window can use without a person typing one (there is no bootstrap token
  yet — `deploy/README.md`), and shutting the process down cleanly on three operating systems, one of
  which has no `SIGTERM`. Each of those is a decision, and half-building them would leave a sidecar
  that loses data on the first unclean exit.
- **A shell that connects is useful now.** The author already runs a server — from source, in
  Docker, or on a home server — and the desktop window is wanted for screening and analysis work at
  the desk. A window that opens the web client against that server delivers the desktop role today
  and exercises everything the sidecar will later need from the window side.

The window's origin is the shell's own (`tauri://localhost` on Linux and macOS, `http://tauri.localhost`
on Windows), not the server's, so the web client's relative paths, which work in a browser because a
deployment serves the bundle and the API on one origin, do not work in the window.

## Decision

The desktop shell ships in two phases, recorded in `docs/platform-roadmap.md`.

**Phase A — connect (now).** `apps/desktop` is a Tauri 2 shell that serves a copy of the built web
client and talks to a Recueil server at a configured address.

1. The web client learns the server's address from its embedding host through one documented
   contract, `globalThis.recueilHost.connection()` (`apps/web/src/host.ts`), answered with a base URL
   and an optional bearer token. In a browser there is no host and nothing changes.
2. Requests are ordinary cross-origin requests from the window. The server must list the shell's
   origin in `RECUEIL_CORS_ORIGIN`, the variable that already exists for a separately served
   frontend. The shell does not proxy the API and does not relax the web view's CORS rules.
3. An address is either `https://`, or plain `http://` on the loopback interface. Anything else is
   refused when typed, not after a request has been made, because it would carry the library and
   the token across a network in clear text — and the web view would block it as mixed content
   anyway.
4. The settings file holds the address and nothing else. A token, when the server requires one, is
   kept in the operating system's credential store (Keychain, Credential Manager, Secret Service),
   one entry per server address. Where no store answers, it is held in memory for the session and
   the window says so. An address carrying a user name or password is refused.
5. The window opens on a connection page that checks the server before handing over: it
   distinguishes "nothing answered" from "something answered but refused this origin", says which
   variable to set, and asks for a token only when the API refuses without one.
6. The shell grants the window four commands of its own and nothing from Tauri's core or any
   plugin. The content security policy loads scripts, styles and workers from the bundle only; only
   the network directives are open, to loopback HTTP and to HTTPS, because the address is the
   user's. The window navigates only within the bundle and the configured server; other web and
   mail links go to the system browser, and everything else is blocked.

**Phase B — bundle (with Phase 4).** The shell supervises the server as a sidecar, as ADR-0001 and
ADR-0007 require: a per-user data directory, an ephemeral loopback port, a per-launch credential,
supervised restart and shutdown that drains. Phase A's connection page becomes the place where a
user chooses between the built-in server and another one. The steps are in the platform roadmap.

## Consequences

The desktop role is served before Phase 4, against servers people already run, and the window-side
half of local mode — host contract, credential storage, connection page, packaging and CI on three
operating systems — is built and exercised before the server-side half.

The cost is one more thing to configure: a server the desktop application talks to has to allow the
shell's origin, and until the connection page explains that, a refusal looks like a dead server.
The page explains it, with the exact value, and `docs/self-hosting.qmd` documents it. Two origins
have to be listed for Windows and the other two platforms.

The policy is wider than it will be in Phase B: `connect-src`, `img-src`, `object-src` and
`frame-src` admit any HTTPS origin, because the address is chosen at run time and Tauri's policy is
fixed at build time. Scripts are not covered by that and remain bundle-only.

A user who wants a purely local application without running a server is not served until Phase B,
which is the same position ADR-0001 accepts for a single-file application, held for a shorter time.

The web client's reader still fetches a PDF by URL, without the bearer token. Against a server that
requires a token the library works in the window and the reader does not; the browser client has
the same limit today, because it has no sign-in yet.
