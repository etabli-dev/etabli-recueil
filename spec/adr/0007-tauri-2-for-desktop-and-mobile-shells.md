# 0007 — Tauri 2 for desktop and mobile shells

- **Status:** Accepted
- **Date:** 2026-08-22
- **Phase:** Phase 0

## Context

Desktop needs watched folders, a tray, a URI scheme and open-in-external-app. Mobile needs a
camera. Both should reuse the web UI rather than fork it.

## Decision

Tauri 2 for macOS, Windows, Linux, iOS and Android, with the server compiled in as a sidecar in
desktop local mode. Capacitor is the documented fallback if Tauri mobile proves immature.

## Consequences

One UI codebase and no Electron-sized binaries. Linux renders in WebKitGTK, where PDF.js
performance is unproven — this is an explicit Phase 4 test with the browser UI as the fallback.
