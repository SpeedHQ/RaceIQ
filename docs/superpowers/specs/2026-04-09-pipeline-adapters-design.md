# Pipeline Adapters Design Spec

**Date:** 2026-04-09  
**Status:** Approved

## Overview

Introduce two injectable adapter interfaces (`DbAdapter`, `WsAdapter`) so the telemetry processing pipeline can run in test contexts without a real database or WebSocket server. The primary use case is `parseDump()` — a test helper that feeds a recorded dump through the full pipeline and returns the detected laps without writing to SQLite or broadcasting to clients.

## Motivation

`LapDetector` currently imports `insertSession`/`insertLap` directly from `./db/queries`, making it impossible to instantiate in tests without a live DB. `processPacket()` uses the `wsManager` singleton directly. Injecting these two dependencies allows tests to swap in capturing/null implementations and get full pipeline coverage from recorded dump files.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/pipeline-adapters.ts` | Create | `DbAdapter` + `WsAdapter` interfaces; all 4 concrete implementations |
| `server/lap-detector.ts` | Modify | Accept `DbAdapter` via constructor; remove all direct `./db/*` imports |
| `server/pipeline.ts` | Modify | Extract `Pipeline` class; keep `processPacket` + `lapDetector` exports for backward compatibility |
| `server/games/acc/recorder.ts` | Modify | Export `readAccFrames(path)` — reads ACCREC format into frame array |
| `test/helpers/parse-dump.ts` | Create | `parseDump(gameId, dumpPath)` test helper |

---

## `server/pipeline-adapters.ts`

### `DbAdapter` interface

Covers all DB interactions used by `LapDetector` and `Pipeline`:

```ts
interface DbAdapter {
  // Writes
  insertSession(data: NewSession): Promise<number>;
  insertLap(data: NewLap): Promise<number>;
  // Reads
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]>;
  getTrackOutlineSectors(trackOrdinal: number, gameId: GameId): Promise<TrackSector[] | null>;
  getTuneAssignment(carOrdinal: number, carPI: number, gameId: GameId): Promise<TuneAssignment | null>;
}
```

### `WsAdapter` interface

Covers all WebSocket calls made by `Pipeline`:

```ts
interface WsAdapter {
  broadcast(packet: TelemetryPacket, sectors: LiveSectorData | null, pit: LivePitData | null): void;
  broadcastNotification(event: NotificationEvent): void;
  broadcastStatus(status: ServerStatus): void;
  broadcastDevState(state: DevState): void;
}
```

### Concrete implementations

**`RealDbAdapter`** — wraps the actual query functions from `server/db/queries.ts`. One-liner delegations; no logic.

**`RealWsAdapter`** — wraps `wsManager` from `server/ws.ts`. One-liner delegations.

**`CapturingDbAdapter`** — for tests:
- `insertSession`: pushes data to `this.sessions[]`, returns incrementing mock ID
- `insertLap`: pushes data to `this.laps[]`, returns incrementing mock ID
- `getLaps`: returns `this.laps` mapped to `LapMeta` shape (fields already match)
- `getTrackOutlineSectors`: returns `null` (sector detection skipped in parse mode)
- `getTuneAssignment`: returns `null` (tune lookup skipped in parse mode)

**`NullWsAdapter`** — all methods are no-ops. No state.

---

## `server/lap-detector.ts` changes

Constructor gains a required `DbAdapter` parameter:

```ts
class LapDetector {
  constructor(private db: DbAdapter) {}
  // ...
}
```

All direct calls to `insertSession`, `insertLap`, `getLaps`, `getTrackOutlineSectors`, `getTuneAssignment` are replaced with `this.db.insertSession(...)`, etc.

The import block loses all `./db/queries` and `./db/tune-queries` entries. The module becomes DB-free.

The module-level singleton export changes to:

```ts
export const lapDetector = new LapDetector(new RealDbAdapter());
```

`onSessionStart`, `onLapComplete_`, `onLapSaved` callbacks remain on the class unchanged — they are wired by whoever creates the `LapDetector` instance.

---

## `server/pipeline.ts` changes

Current module-level code (singletons, callback assignments, `processPacket` function) is moved into a `Pipeline` class:

```ts
export class Pipeline {
  private sectorTracker = new SectorTracker();
  private pitTracker = new PitTracker();
  readonly lapDetector: LapDetector;

  constructor(private db: DbAdapter, private ws: WsAdapter) {
    this.lapDetector = new LapDetector(db);
    // Wire callbacks — same logic as today's module-level assignments
    this.lapDetector.onSessionStart = async (session) => { ... };
    this.lapDetector.onLapComplete_ = (event) => { ... };
    this.lapDetector.onLapSaved = (event) => {
      ws.broadcastNotification({ type: "lap-saved", ...event });
      // re-push session laps
    };
  }

  async processPacket(packet: TelemetryPacket): Promise<void> {
    // same logic as today — uses this.lapDetector, this.sectorTracker,
    // this.pitTracker, this.ws
  }
}
```

Backward-compatible exports (unchanged for all callers):

```ts
const _default = new Pipeline(new RealDbAdapter(), new RealWsAdapter());
export const processPacket = (p: TelemetryPacket) => _default.processPacket(p);
export const lapDetector = _default.lapDetector; // udp.ts, ws.ts still import this
```

`server/index.ts`, `server/udp.ts`, `server/games/acc/shared-memory.ts` — **zero changes**.

---

## `test/helpers/parse-dump.ts`

```ts
export async function parseDump(
  gameId: GameId,
  dumpPath: string
): Promise<NewLap[]>
```

Implementation:

1. `initGameAdapters()` + `initServerGameAdapters()` (idempotent — safe to call multiple times)
2. Create `db = new CapturingDbAdapter()`, `ws = new NullWsAdapter()`
3. Create `pipeline = new Pipeline(db, ws)`
4. **UDP games** (f1-2025, fm-2023):
   - `readUdpDump(dumpPath)` → `Buffer[]`
   - For each buffer: `serverAdapter.tryParse(buf, parserState)` → if packet, `await pipeline.processPacket(packet)`
5. **ACC**:
   - `readAccFrames(dumpPath)` → `{ physics: Buffer, graphics: Buffer, static: Buffer }[]`
     (reads ACCREC format produced by `AccRecorder`; exported from `server/games/acc/recorder.ts`)
   - For each frame: `parseAccBuffers(physics, graphics, static, {})` → if packet, `await pipeline.processPacket(packet)`
6. Return `db.laps` — the raw `NewLap[]` captured by `CapturingDbAdapter`

Returns `NewLap[]` — the Drizzle insert type, already has all lap fields. Tests assert directly on those fields. If deserialized packets are needed, callers use the existing CSV deserializer.

### Usage in tests

```ts
import { parseDump } from "./helpers/parse-dump";

test("detects 3 laps from F1 dump", async () => {
  const laps = await parseDump("f1-2025", "data/recordings/2026-04-09T14-32-11/dump.bin");
  expect(laps).toHaveLength(3);
  expect(laps[0].lapTime).toBeCloseTo(92340, -2);
  expect(laps[0].isValid).toBe(true);
});
```

---

## Backward Compatibility

No existing callers change. The refactor is purely additive — `processPacket` and `lapDetector` exports remain at the same paths with the same signatures. All existing tests continue to pass.
