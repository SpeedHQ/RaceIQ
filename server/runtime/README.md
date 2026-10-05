# Runtime

## Purpose

`server/runtime` owns process orchestration: configuration and filesystem locations, logging, HTTP/WebSocket and UDP listeners, native telemetry-source supervision, desktop integration, update scheduling, and graceful shutdown. `bootServer()` is the server entry point; `apps/backend/src/index.ts` installs console capture before calling it.

## Structure

- `boot.ts`, `startup-jobs.ts`, and `shutdown.ts` define lifecycle ownership and ordering.
- `http-server.ts`, `websocket-manager.ts`, and `udp-listener.ts` own network transport contracts.
- `native-sources.ts`, `source-supervisor.ts`, and `live-readers.ts` supervise Windows-native telemetry readers and expose active readers to diagnostics routes.
- `apps/backend/src/runtime/recording-runtime.ts` owns serialized Bun/Rust authority handoffs; `recorder-client.ts` supervises the bundled Rust child over private framed stdio.
- `config/` resolves environment, persisted settings, and development-versus-compiled paths.
- `platform/` contains desktop, credential-store, launch-on-login, tray, and PowerShell integration.
- `update/` owns release discovery, update state, tray/browser notification, download, and installer launch.
- `logger.ts`, `desktop.ts`, `options.ts`, and `dev-studio.ts` provide process-wide runtime facilities.

## Boundaries and invariants

- Boot ordering is intentional: adapters and database state initialize before listeners; HTTP starts before UDP and background jobs; native sources and desktop integration start before maintenance jobs; the ready message is last.
- HTTP port precedence is explicit option, then `SERVER_PORT`, then `3117`. UDP port precedence is explicit option, then `RACEIQ_DEV_UDP_PORT`, persisted setting, `UDP_PORT`, and `5301`. `DATA_DIR` overrides the derived user-data path, while tests refuse an implicit real user-data path.
- HTTP paths remain partitioned: `/ws` is the WebSocket upgrade, `/api` and `/studio-api` dispatch to Hono, production serves bundled assets with SPA fallback, and development may serve public files.
- UDP binds IPv4 on `0.0.0.0` by default, preserves raw recording frames before parsing, and owns its one-second status/flush interval across restarts.
- Native process detection is Windows-only and polls every two seconds. Reader references are cleared before asynchronous stops so one source instance has clear ownership.
- Shutdown stops the compressor, stops acquisition and finalizes captures, waits for recorder event subscribers and database work, and drains recording jobs before exiting. Update installation waits for this same shutdown before launching the installer.
- Runtime orchestrates game, database, telemetry, session-capture, tune-sync, route, and shared-data domains; those domains retain their own parsing, persistence, and policy. Cross-domain moves or new shared layers require a separate dependency-cycle pass.
- Update checks preserve `LOCAL_INSTALLER` and development override behavior, GitHub release metadata, browser/tray notification payloads, four-hour scheduling, Windows-only installation, and the delayed exit after installer launch.

## Recording engines

The bundled recorder supports Forza Motorsport 2023, F1 2025, ACC, AC Evo, iRacing, and LMU. Bun remains the default. Select **Bun** or **Rust** in **Settings → Connection → Recording engine**; `recordingEngine` is saved only after a successful handoff.

The backend pauses new recording jobs, drains existing jobs, finalizes the active capture and database events, releases the old UDP/native sources, starts the selected authority, and resumes jobs. HTTP and existing WebSocket connections remain running. Only one engine owns acquisition at a time. A switch ends the current capture; uninterrupted frame delivery across the handoff is not guaranteed.

Rust owns acquisition, source decoding, session/lap detection, capture encoding, imports, and historical capture/lap decoding when selected. Bun retains HTTP uploads, database persistence, dashboard presentation, derived analysis, comparisons, and AI. A failed handoff reports an error without silently falling back; an explicit subsequent selection can recover it without restarting HTTP.

Rust uses UDP on all supported hosts. ACC, AC Evo, iRacing, and LMU live shared-memory acquisition requires Windows. macOS/Linux builds can import and replay their captures but do not acquire Windows mappings. Native Windows game/mapping and installer execution must be verified on Windows.

Development requires Rust 1.90.0: `bun run build:recorder` builds the checkout-local child. Production builds stage `raceiq-recorder` (`raceiq-recorder.exe` on Windows) beside the backend. Missing or failed selected children are errors, not a request to use Bun.

## Testing

Focused coverage lives in `test/runtime-options.test.ts`, `test/settings.test.ts`, `test/source-supervisor.test.ts`, `test/update-check.test.ts`, and `apps/backend/test/e2e/udp-recording.test.ts`. Network or lifecycle changes also require exercising startup, listener restart, WebSocket connect/disconnect, platform guards, update scheduling, and signal-driven shutdown without changing their order or external contracts.

`apps/backend/test/runtime/recorder-parity.test.ts` compares original, imported, and replayed captures against source decoders for all six games, and checks that ordinary MoTeC ZIP imports produce replayable lap recipes. `apps/backend/test/runtime/recorder-client.test.ts` exercises the real child's shutdown and finalization contract.

Backend typecheck stores incremental metadata in `apps/backend/node_modules/.tmp/tsconfig.tsbuildinfo`, isolated from build output.
