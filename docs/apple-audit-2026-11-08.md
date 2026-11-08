# Recueil desktop audit, 2026-11-08

## Credential isolation

The shell now captures the server address before looking up its token. Previously, changing connection settings while a credential-store read was in progress could pair the first server's token with the replacement server's address. Connection responses and status responses now use one address snapshot throughout. The regression uses two synthetic hosts and tokens and never accesses the user's credential store. Forgetting a saved token now reports a credential-store deletion failure instead of silently claiming success; session copies are still cleared. A separate injected-operation regression covers a locked store without contacting the real Keychain.

## Review queue

Undo now changes the selected review entry outside React's state updater. The former updater notified its parent while React was rendering, producing a cross-component update warning. The existing keyboard-undo regression also checks that this warning is absent.

## CLI process checks

CLI tests can opt into the final production build with `RECUEIL_TEST_COMPILED=1 pnpm --filter @recueil/cli run test --maxWorkers=1` after `pnpm build`. The default still runs source through tsx. Test teardown now kills and reaps only children created by its CLI helper before deleting temporary libraries, including after test failure or timeout. A real temporary-server regression verifies cleanup. Test budgets remain unchanged.

## Verification

Frozen dependency installation, final-source ESLint, full workspace typechecking and production builds, specification validation, and the 10 desktop TypeScript tests passed locally on macOS. The final keyboard-undo suite passed all 23 tests. The final Rust suite passed 14 tests, including both credential regressions. Production Tauri DMG packaging passed twice; the final disk image passed `hdiutil verify`.

The serial workspace round passed 2,355 non-CLI tests. The source CLI round had two 30-second timeouts on the heavily loaded local host. After adding child cleanup, the production-CLI round passed 156 of 157 tests; its one remaining dry-run timeout passed an isolated repeat in 2.3 seconds. Both source and compiled cleanup regressions passed. These are results across scoped repeats, not a claim that the initial complete run was green. Default test budgets were not increased.

Final artifact: `apps/desktop/src-tauri/target/release/bundle/dmg/Recueil_0.1.0_aarch64.dmg` (2,240,625 bytes, arm64). SHA-256: `20137091a14b1d5eb21b105f518aa20e5ce892866fb17296ba7bd3f761bd0e89`.

The pre-refinement source already has a successful [desktop package workflow](https://github.com/etabli-dev/etabli-recueil/actions/runs/42527324842) and [full CI workflow](https://github.com/etabli-dev/etabli-recueil/actions/runs/42527324818). Those runs precede this credential fix and do not validate it.

Production dependency audit found no known advisories (191 dependencies). The all-dependency audit has two moderate development-tool advisories: [esbuild](https://github.com/advisories/GHSA-67mh-4wv8-2f99) through drizzle-kit's older loader, and [minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249) through typescript-eslint. The esbuild issue concerns its development server; this old copy is reached through Drizzle's TypeScript configuration loader, not Recueil's HTTP server. The minimatch issue affects glob processing in the lint toolchain. Registry inspection found no fixed stable upstream path: typescript-eslint 8.72.1 remains latest stable, and drizzle-kit 0.31.11 still depends on the old loader whose latest core-utils 3.3.2 pins esbuild 0.18.20. These remain tracked pending maintained upstream fixes; no cross-major transitive override was forced. The high-severity audit gate passed.

No live library was used. macOS signing, notarization, credential-store acceptance and representative-library acceptance remain distinct gates. The iOS/Android native shell and desktop bundled-server mode remain unimplemented roadmap work.
