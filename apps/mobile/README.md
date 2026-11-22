# apps/mobile

The iOS, iPadOS and Android shell (CONCEPT.md Phase 8, [ADR-0024](../../spec/adr/0024-capacitor-for-the-mobile-shell.md)):
the web client in Capacitor 8, connected to the user's own Recueil server, for capture first.

- **Capture** opens on the web client's *Capture* screen: scan a document (ML Kit on Android,
  VisionKit through the app's `RecueilScanner` plugin on iOS), photograph one, pick files, scan or
  type an ISBN, or share a PDF into the app from another one. Every capture is kept in an
  on-device queue (`apps/web/src/capture/queue.ts`) and uploaded to `POST /api/v1/ingestion/upload`
  when the server answers; one the server refuses stays in the queue with its reason.
- **Settings.** The server address is kept in Capacitor Preferences; the token in the Keychain or
  Android's Keystore-backed storage, never in Preferences. HTTPS only, except loopback and the
  Android emulator's host during development.
- **Server.** `RECUEIL_CORS_ORIGIN` must list `capacitor://localhost` (iOS) and `https://localhost`
  (Android).

## Build

```sh
pnpm --filter "@recueil/mobile..." run build        # web client, then www/
pnpm --filter @recueil/mobile exec cap sync         # copy www/ and plugins into ios/ and android/
cd apps/mobile/android && ./gradlew assembleDebug   # JDK 21 and the Android SDK
cd apps/mobile/ios/App && pod install && xcodebuild -workspace App.xcworkspace -scheme App -sdk iphonesimulator -configuration Debug build
```

`.github/workflows/mobile.yml` runs both builds on every change to `apps/mobile` or `apps/web`.
Signed builds need the owner's keys (`docs/platform-roadmap.md` §4.4–4.5, §6) and are not set up.

## Status

Built in CI, **not yet run on a phone**: the Phase 8 exit (a three-page document from camera to a
searchable item in under thirty seconds) is the owner's to measure on a real device. Not yet: an
iOS share extension (Android receives shares already; iOS needs an extension target in Xcode),
and cached reading offline.
