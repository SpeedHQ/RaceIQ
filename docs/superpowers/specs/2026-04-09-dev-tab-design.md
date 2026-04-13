# Dev Tab Design

**Date:** 2026-04-09

## Overview

A developer-only tab visible in each game's sub-navigation that streams raw server internals and Zustand store state in real time via WebSocket, with a pause button to freeze the snapshot.

## Visibility Gate

- Only rendered when `import.meta.env.DEV === true`
- `"Dev"` is appended to `GAME_SUB_TABS` at runtime conditionally: `const DEV_TABS = import.meta.env.DEV ? ["Dev"] : []`
- The tab and its routes never exist in production builds — Vite's dead-code elimination removes them entirely

## Server Changes

### New WS message type: `dev-state`

Broadcast on every telemetry tick (inside `pipeline.ts`, after the existing packet broadcast). Payload is a plain object with raw state serialized directly from:

- `lapDetector` — all public fields as-is
- `sectorTracker` — all public fields as-is
- `pitTracker` — all public fields as-is
- `serverStatus` — the same object already in the `status` WS message

No transformation. No formatting. Raw field values only.

Message shape:
```ts
{ type: "dev-state", lapDetector: {...}, sectorTracker: {...}, pitTracker: {...}, serverStatus: {...} }
```

The shared `NotificationMessage` union type gains a `dev-state` variant.

## Client Changes

### WebSocket handler (`useWebSocket.ts`)

Handle the new `dev-state` message type and call `setDevState(msg)` on the telemetry store.

### Telemetry store (`stores/telemetry.ts`)

Add two fields:
- `devState: unknown | null` — last received dev-state payload
- `devStatePaused: boolean` — when true, `setDevState` is a no-op (freeze)

Add actions:
- `setDevState(state: unknown): void`
- `toggleDevStatePause(): void`

### Route files (dev-only)

One new route file per game, created only if the game already has a `raw.tsx`:
- `client/src/routes/acc/dev.tsx`
- `client/src/routes/f125/dev.tsx`
- `client/src/routes/fm23/dev.tsx`

Each is identical — import and render `<DevStateViewer />`.

### Component: `DevStateViewer`

Located at `client/src/components/DevStateViewer.tsx`.

- Reads `devState` and `devStatePaused` from telemetry store
- Reads all three Zustand stores (`useTelemetryStore`, `useGameStore`, `useUiStore`) via `getState()` snapshot on each render
- Layout: pause button top-right, then two `<pre>` blocks side by side:
  - Left: `JSON.stringify(devState, null, 2)` — server state
  - Right: `JSON.stringify({ telemetry: telemetrySnapshot, game: gameSnapshot, ui: uiSnapshot }, null, 2)` — Zustand state
- `<pre>` blocks are scrollable, monospace, small font
- No filtering, no highlighting, no collapsing — raw JSON only

## No Changes Needed

- Navigation tab rendering already works — `GAME_SUB_TABS` drives it, conditional append handles the rest
- No new API endpoints
- No database changes
- No test changes required (pure dev tooling)
