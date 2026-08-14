# Runtime

## Purpose

`server/runtime` owns process orchestration: configuration and filesystem locations, logging, HTTP/WebSocket and UDP listeners, native telemetry-source supervision, desktop integration, update scheduling, and graceful shutdown. `bootServer()` is the server entry point; `server/index.ts` installs console capture before calling it.

## Structure

- `boot.ts`, `startup-jobs.ts`, and `shutdown.ts` define lifecycle ownership and ordering.
- `http-server.ts`, `websocket-manager.ts`, and `udp-listener.ts` own network transport contracts.
- `native-sources.ts`, `source-supervisor.ts`, and `live-readers.ts` supervise Windows-native telemetry readers and expose active readers to diagnostics routes.
- `config/` resolves environment, persisted settings, and development-versus-compiled paths.
- `platform/` contains desktop, credential-store, launch-on-login, tray, and PowerShell integration.
- `update/` owns release discovery, update state, tray/browser notification, download, and installer launch.
- `logger.ts`, `desktop.ts`, `options.ts`, and `dev-studio.ts` provide process-wide runtime facilities.

## Boundaries and invariants

- Boot ordering is intentional: adapters and database state initialize before listeners; HTTP starts before UDP and background jobs; native sources and desktop integration start before maintenance jobs; the ready message is last.
- HTTP port precedence is explicit option, then `SERVER_PORT`, then `3117`. UDP port precedence is explicit option, persisted setting, then `UDP_PORT`, then `5301`. `DATA_DIR` overrides the derived user-data path, while tests refuse an implicit real user-data path.
- HTTP paths remain partitioned: `/ws` is the WebSocket upgrade, `/api` and `/studio-api` dispatch to Hono, production serves bundled assets with SPA fallback, and development may serve public files.
- UDP binds IPv4 on `0.0.0.0` by default, records length-valid raw UDP datagrams before parsing—including parser-skipped packets—and owns its one-second status/flush interval across restarts. Timeout and reconnect evidence is emitted only for accepted telemetry from the matching UDP source.
- Native process detection is Windows-only and polls every two seconds. Reader references are cleared before asynchronous stops so one source instance has clear ownership.
- Shutdown stops the compressor first, then settles recorder flush, native-source stop, and recording-mode source stops before exiting. Signal registration and task ordering must not move casually.
- Runtime orchestrates game, database, telemetry, session-capture, tune-sync, route, and shared-data domains; those domains retain their own parsing, persistence, and policy. Cross-domain moves or new shared layers require a separate dependency-cycle pass.
- Update checks preserve `LOCAL_INSTALLER` and development override behavior, GitHub release metadata, browser/tray notification payloads, four-hour scheduling, Windows-only installation, and the delayed exit after installer launch.

## Testing

Focused coverage lives in `test/runtime-options.test.ts`, `test/settings.test.ts`, `test/source-supervisor.test.ts`, `test/update-check.test.ts`, and `test/e2e/udp-recording.test.ts`. Network or lifecycle changes also require exercising startup, listener restart, WebSocket connect/disconnect, platform guards, update scheduling, and signal-driven shutdown without changing their order or external contracts.
