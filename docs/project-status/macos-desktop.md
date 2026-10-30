# macOS desktop direction

## Baseline and scope

Fork branch: `codex/macos-tauri-e2e`. Upstream baseline: `SpeedHQ/RaceIQ`
`e429369be` (v0.20.0), synchronized on 2026-10-29. Keep upstream fetch-only;
publish this work only to `dedeco-carrera/RaceIQ` after fork access is available.

Use the `packageManager` version in the root manifest (currently Bun 1.4.3).
The older global Bun 1.3.14 is not the verification baseline.

First supported live source: F1 25 UDP from a console or Windows gaming machine
on the same network. macOS runs RaceIQ, not the Windows game. Windows shared
memory for ACC, AC Evo, iRacing and LMU cannot be read across the network;
support there requires an explicit Windows sender/bridge in a later milestone.
Saved recording import and browser dashboards remain useful independently.

## Shared desktop contract (proposed)

- Bun remains authoritative for UDP parsing, recording, SQLite, API and WebSocket
  transport. React keeps its existing same-origin Hono RPC and WS interfaces.
- Tauri owns the native window, app lifecycle and one supervised Bun sidecar.
  It starts the backend, waits for readiness, then opens its loopback URL.
- Desktop HTTP binds only to loopback. UDP binds to the selected network
  interface and configured telemetry port (5301 by default).
- The shell uses a private allocated HTTP port; it must never kill another
  RaceIQ instance to claim a port. Single-instance behavior needs an explicit
  policy. Backend crashes produce an actionable startup/restart state.
- macOS data lives under `~/Library/Application Support/RaceIQ`; logs and
  recordings remain outside the signed, read-only `.app`. Existing data must
  be detected and migrated without overwriting either location.
- Closing/quitting the app flushes recordings and stops its own sidecar and
  workers. No orphan backend or sleep-prevention process may remain.
- Rust owns native privileges; the loaded page receives no generic shell
  execution capability. Keep current dashboard authentication; do not treat
  loopback or a WebView as authentication.
- Bundle the compiled Bun backend, its workers, catalogs/static assets and
  platform-specific native addons. Installed apps must not need Bun, Node,
  Homebrew or repository paths on PATH.
- Desktop builds disable the Windows binary updater. Signing/notarization and
  a fork-owned Tauri update feed are separate release work.

This contract must be finalized before UI and backend implementation diverge.
Both implementation tracks below depend on it.

## Milestone 1: real UDP browser gate

Run from `playwright/`:

```sh
bunx playwright install chromium webkit
# First run `bun run build:browser` from the repository root.
bunx playwright test --config=udp.config.ts --project=udp-chromium
bunx playwright test --config=udp.config.ts --project=udp-webkit
```

The suite uses a dedicated unseeded server, disposable `test-data-udp`, HTTP
3132, Vite 4132 and UDP 15332. It replays the committed real F1 25 wire capture
through a UDP socket; no API/WS telemetry injection or prepopulated laps.
Assertions cover live timing, pit view navigation, changing raw speed, and
navigation from captured session laps into Replay. Failure traces/screenshots
stay under ignored `playwright/test-results/udp`.
Compiled mode is the default; `E2E_SERVER_MODE=dev` selects Bun/Vite diagnostics.

Acceptance: both browser engines pass on macOS, then the same behavior passes
against a compiled backend. WebKit browser coverage does not prove native
Tauri lifecycle, entitlements or WKWebView behavior.

Local baseline checks: the Apple Silicon compiled build, root `bun run typecheck`,
repository lint, focused UDP typecheck and changelog tests pass with Bun 1.4.3.
The real-UDP acceptance scenario passes against the compiled backend in both
Chromium and WebKit on macOS. Each run sends 197,511 datagrams and captures
five valid laps; listener diagnostics report zero malformed drops.
The wider `playwright/tsconfig.json` check separately reports 22 existing errors
in LMU/session E2E files; the focused UDP check excludes those unrelated specs.

## Milestone 2: backend implementation plan

Depends on milestone 1 and the shared contract above.

1. Verify `bun run build` on Apple Silicon; smoke-test compiled startup, data
   persistence and UDP capture outside the repo. Inventory native addon and
   worker resources using the current build output.
2. Introduce explicit desktop runtime options: loopback binding, allocated
   HTTP port, data directory, no browser launch/tray/Windows updater, and
   readiness signaling. Keep CLI/server behavior explicit and compatible.
3. Replace any port-clearing behavior in desktop mode with bind failure or
   allocation. Test startup collision and source bind failures.
4. Add macOS data-directory resolution and safe legacy migration; test paths
   containing spaces, read-only bundles, restarts and existing databases.
5. Exercise graceful shutdown during capture and worker processing. Require
   a fully readable saved capture after app exit and no remaining processes.

Acceptance: compiled sidecar starts from app-like resource layout without
external runtime installs; repeated start/stop preserves settings and laps.

## Milestone 3: native/UI implementation plan

Depends on milestone 2 and the same shared contract above.

1. Add a small Tauri 2 workspace with a Rust-owned sidecar supervisor and
   bundled resources. Use target-specific sidecar names for arm64 and x64.
2. Add a native startup window and readiness/error handoff to the existing
   React application. Keep server-state logic in Bun.
3. Add macOS menu, quit, file-open/import and external-link behavior; verify
   keyboard navigation, title bar, resizing and Retina layouts in WKWebView.
4. Add native lifecycle smoke coverage separately from the UDP browser suite.
   Verify available Tauri WebDriver tooling on macOS rather than assuming
   Playwright controls WKWebView.

Acceptance: a local `.app` launches by double-click, records F1 UDP, opens a
saved lap, restarts with history intact, and exits cleanly without a terminal.

## Milestone 4: distribution

Build on native arm64 and x64 runners, sign nested binaries/addons and the app,
notarize, and test quarantine/Gatekeeper on a clean Mac. Publish only through
the fork. Apple signing credentials and a release/update policy are required
before distributing signed builds.

## Upstream references

- [Tauri external binaries](https://v2.tauri.app/develop/sidecar/)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri test support](https://v2.tauri.app/develop/tests/)
