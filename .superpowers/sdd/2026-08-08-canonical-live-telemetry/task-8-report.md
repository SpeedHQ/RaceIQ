# Task 8 report

Implemented canonical client dispatch and isolated native dev telemetry lifecycle.

- Added pure `handleWebSocketMessage` router: canonical schema/frame update production semantic store; tagged dev subscription/packet update isolated dev store; legacy untagged packets ignored.
- Updated `useWebSocket` to send dev subscribe/unsubscribe controls, replay only wanted intent after reconnect, clear dev ack/error/packet on close while preserving intent.
- Added `/dev` Native Telemetry tab and `DevTelemetryPanel` with RawTelemetry, status and toggle.
- Removed `/iracing/raw`; regenerated `client/src/routeTree.gen.ts` through Vite route generation.
- Added focused router tests.

Evidence:
- `bun test ./test/websocket-messages.test.ts ./test/live-telemetry-view.test.ts` — 5 pass, 0 fail.
- `bun run build` — Vite production bundle succeeds and route generation succeeds; tsc exits nonzero on pre-existing unrelated repository errors in telemetry consumers/server files (see command output).
