# Pipeline Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject `DbAdapter` and `WsAdapter` into `LapDetector` and `Pipeline` so the telemetry pipeline can run in test contexts without a real database or WebSocket server, enabling a `parseDump(gameId, path)` test helper.

**Architecture:** Define two interfaces (`DbAdapter`, `WsAdapter`) in a new `server/pipeline-adapters.ts` file with four concrete implementations (Real, Capturing, Null). `LapDetector` gains a required `DbAdapter` constructor parameter. `Pipeline` class encapsulates the current module-level singletons in `pipeline.ts`. Backward-compatible exports (`processPacket`, `lapDetector`) preserve all existing call sites unchanged.

**Tech Stack:** Bun, TypeScript, Drizzle ORM types (`LapMeta`, `GameId`), `bun:test`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `server/pipeline-adapters.ts` | Create | `DbAdapter` + `WsAdapter` interfaces; `CapturedLap` type; all 4 concrete implementations |
| `server/lap-detector.ts` | Modify | Accept `DbAdapter` via constructor; remove direct `./db/queries` and `./db/tune-queries` imports; export the class |
| `server/pipeline.ts` | Modify | Extract `Pipeline` class; keep `processPacket` + `lapDetector` exports for backward compat |
| `server/games/acc/recorder.ts` | Modify | Export `readAccFrames(path)` — reads ACCREC format into frame array |
| `test/helpers/parse-dump.ts` | Create | `parseDump(gameId, dumpPath)` test helper |

---

### Task 1: Create `server/pipeline-adapters.ts`

**Files:**
- Create: `server/pipeline-adapters.ts`
- Test: `test/pipeline-adapters.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/pipeline-adapters.test.ts
import { describe, test, expect } from "bun:test";
import { CapturingDbAdapter, NullWsAdapter } from "../server/pipeline-adapters";

describe("CapturingDbAdapter", () => {
  test("insertSession captures data and returns incrementing IDs", async () => {
    const db = new CapturingDbAdapter();
    const id1 = await db.insertSession(100, 200, "f1-2025", "race");
    const id2 = await db.insertSession(101, 201, "acc");
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(db.sessions).toHaveLength(2);
    expect(db.sessions[0]).toMatchObject({
      carOrdinal: 100,
      trackOrdinal: 200,
      gameId: "f1-2025",
      sessionType: "race",
    });
  });

  test("insertLap captures data and returns incrementing IDs", async () => {
    const db = new CapturingDbAdapter();
    await db.insertSession(1, 1, "f1-2025");
    const id = await db.insertLap(1, 1, 90000, true, [], null, null, null, null);
    expect(id).toBe(1);
    expect(db.laps).toHaveLength(1);
    expect(db.laps[0]).toMatchObject({
      sessionId: 1,
      lapNumber: 1,
      lapTime: 90000,
      isValid: true,
    });
  });

  test("getLaps returns empty array", async () => {
    const db = new CapturingDbAdapter();
    expect(await db.getLaps("f1-2025", 100)).toEqual([]);
  });

  test("getTrackOutlineSectors returns null", async () => {
    const db = new CapturingDbAdapter();
    expect(await db.getTrackOutlineSectors(1, "f1-2025")).toBeNull();
  });

  test("getTuneAssignment returns null", async () => {
    const db = new CapturingDbAdapter();
    expect(await db.getTuneAssignment(1, 1)).toBeNull();
  });
});

describe("NullWsAdapter", () => {
  test("all methods are no-ops and do not throw", () => {
    const ws = new NullWsAdapter();
    expect(() => ws.broadcast({} as any, null, null)).not.toThrow();
    expect(() => ws.broadcastNotification({ type: "test" })).not.toThrow();
    expect(() => ws.broadcastDevState({ key: "value" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test test/pipeline-adapters.test.ts
```
Expected: error `Cannot find module '../server/pipeline-adapters'`

- [ ] **Step 3: Create `server/pipeline-adapters.ts`**

```typescript
import type { TelemetryPacket, LapMeta, LiveSectorData, LivePitData, GameId } from "../shared/types";
import { insertSession, insertLap, getLaps, getTrackOutlineSectors } from "./db/queries";
import { getTuneAssignment } from "./db/tune-queries";
import { wsManager } from "./ws";

/** Shape captured per insertLap call in CapturingDbAdapter. Packet array is not stored. */
export interface CapturedLap {
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  profileId: number | null;
  tuneId: number | null;
  invalidReason: string | null;
  sectors: { s1: number; s2: number; s3: number } | null;
}

export interface DbAdapter {
  insertSession(
    carOrdinal: number,
    trackOrdinal: number,
    gameId: GameId,
    sessionType?: string
  ): Promise<number>;
  insertLap(
    sessionId: number,
    lapNumber: number,
    lapTime: number,
    isValid: boolean,
    packets: TelemetryPacket[],
    profileId: number | null,
    tuneId: number | null,
    invalidReason: string | null,
    sectors: { s1: number; s2: number; s3: number } | null
  ): Promise<number>;
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]>;
  getTrackOutlineSectors(
    trackOrdinal: number,
    gameId: GameId
  ): Promise<{ s1End: number; s2End: number } | null>;
  getTuneAssignment(
    carOrdinal: number,
    trackOrdinal: number
  ): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null>;
}

export interface WsAdapter {
  broadcast(
    packet: TelemetryPacket,
    sectors: LiveSectorData | null,
    pit: LivePitData | null
  ): void;
  broadcastNotification(event: Record<string, unknown>): void;
  broadcastDevState(state: Record<string, unknown>): void;
}

/** Delegates to the real query functions. Used in production. */
export class RealDbAdapter implements DbAdapter {
  insertSession(carOrdinal: number, trackOrdinal: number, gameId: GameId, sessionType?: string): Promise<number> {
    return insertSession(carOrdinal, trackOrdinal, gameId, sessionType);
  }
  insertLap(sessionId: number, lapNumber: number, lapTime: number, isValid: boolean, packets: TelemetryPacket[], profileId: number | null, tuneId: number | null, invalidReason: string | null, sectors: { s1: number; s2: number; s3: number } | null): Promise<number> {
    return insertLap(sessionId, lapNumber, lapTime, isValid, packets, profileId, tuneId, invalidReason, sectors);
  }
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]> {
    return getLaps(gameId, limit);
  }
  getTrackOutlineSectors(trackOrdinal: number, gameId: GameId): Promise<{ s1End: number; s2End: number } | null> {
    return getTrackOutlineSectors(trackOrdinal, gameId);
  }
  getTuneAssignment(carOrdinal: number, trackOrdinal: number) {
    return getTuneAssignment(carOrdinal, trackOrdinal);
  }
}

/** Delegates to wsManager singleton. Used in production. */
export class RealWsAdapter implements WsAdapter {
  broadcast(packet: TelemetryPacket, sectors: LiveSectorData | null, pit: LivePitData | null): void {
    wsManager.broadcast(packet, sectors, pit);
  }
  broadcastNotification(event: Record<string, unknown>): void {
    wsManager.broadcastNotification(event);
  }
  broadcastDevState(state: Record<string, unknown>): void {
    wsManager.broadcastDevState(state);
  }
}

/** Captures insertSession/insertLap calls in-memory. Used in tests via parseDump. */
export class CapturingDbAdapter implements DbAdapter {
  readonly sessions: { carOrdinal: number; trackOrdinal: number; gameId: GameId; sessionType?: string }[] = [];
  readonly laps: CapturedLap[] = [];
  private _sessionId = 0;
  private _lapId = 0;

  insertSession(carOrdinal: number, trackOrdinal: number, gameId: GameId, sessionType?: string): Promise<number> {
    this.sessions.push({ carOrdinal, trackOrdinal, gameId, sessionType });
    return Promise.resolve(++this._sessionId);
  }

  insertLap(sessionId: number, lapNumber: number, lapTime: number, isValid: boolean, _packets: TelemetryPacket[], profileId: number | null, tuneId: number | null, invalidReason: string | null, sectors: { s1: number; s2: number; s3: number } | null): Promise<number> {
    this.laps.push({ sessionId, lapNumber, lapTime, isValid, profileId, tuneId, invalidReason, sectors });
    return Promise.resolve(++this._lapId);
  }

  getLaps(_gameId: GameId, _limit: number): Promise<LapMeta[]> {
    return Promise.resolve([]);
  }

  getTrackOutlineSectors(_trackOrdinal: number, _gameId: GameId): Promise<{ s1End: number; s2End: number } | null> {
    return Promise.resolve(null);
  }

  getTuneAssignment(_carOrdinal: number, _trackOrdinal: number): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null> {
    return Promise.resolve(null);
  }
}

/** No-op WebSocket adapter. Used in tests. */
export class NullWsAdapter implements WsAdapter {
  broadcast(_packet: TelemetryPacket, _sectors: LiveSectorData | null, _pit: LivePitData | null): void {}
  broadcastNotification(_event: Record<string, unknown>): void {}
  broadcastDevState(_state: Record<string, unknown>): void {}
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
bun test test/pipeline-adapters.test.ts
```
Expected: 8 tests passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add server/pipeline-adapters.ts test/pipeline-adapters.test.ts
git commit -m "feat: add DbAdapter + WsAdapter interfaces with 4 concrete implementations"
```

---

### Task 2: Modify `server/lap-detector.ts` to accept `DbAdapter`

**Files:**
- Modify: `server/lap-detector.ts`

LapDetector is currently a non-exported class with no constructor. The module-level singleton is at line 900: `export const lapDetector = new LapDetector();`

DB imports are at lines 14 and 16:
```typescript
import { insertSession, insertLap, getTrackOutlineSectors } from "./db/queries";
import { getTuneAssignment } from "./db/tune-queries";
```

DB call sites:
- Line 231: `await insertSession(packet.CarOrdinal, trackOrd, gameId, sessionType)`
- Lines 328, 404, 456: `await getTuneAssignment(this.currentSession.carOrdinal, this.currentSession.trackOrdinal)`
- Lines 359, 408, 462: `insertLap(this.currentSession.sessionId, lapNum, ...)`
- Line 521: `await getTrackOutlineSectors(trackOrdinal, gameId)`

- [ ] **Step 1: Replace the DB imports (lines 14 and 16) with the adapter import**

Find and replace:
```typescript
import { insertSession, insertLap, getTrackOutlineSectors } from "./db/queries";
```
With:
```typescript
import type { DbAdapter } from "./pipeline-adapters";
```

Find and remove (delete the entire line):
```typescript
import { getTuneAssignment } from "./db/tune-queries";
```

- [ ] **Step 2: Export the class and add the constructor**

Change line 62 from:
```typescript
class LapDetector {
```
To:
```typescript
export class LapDetector {
  constructor(private db: DbAdapter) {}
```

- [ ] **Step 3: Replace `insertSession` call at line 231**

Change:
```typescript
sessionId = await insertSession(packet.CarOrdinal, trackOrd, gameId, sessionType);
```
To:
```typescript
sessionId = await this.db.insertSession(packet.CarOrdinal, trackOrd, gameId, sessionType);
```

- [ ] **Step 4: Replace all `getTuneAssignment` calls (3 occurrences at lines ~328, ~404, ~456)**

Each occurrence follows the same pattern. Change all three from:
```typescript
const tuneAssignment = await getTuneAssignment(
  this.currentSession.carOrdinal,
  this.currentSession.trackOrdinal
);
```
To:
```typescript
const tuneAssignment = await this.db.getTuneAssignment(
  this.currentSession.carOrdinal,
  this.currentSession.trackOrdinal
);
```

- [ ] **Step 5: Replace all `insertLap` calls (3 occurrences at lines ~359, ~408, ~462)**

Each `insertLap(` call becomes `this.db.insertLap(`. The argument list is unchanged. For example:
```typescript
// BEFORE:
insertLap(
  this.currentSession.sessionId,
  lapNum,
  lapTime,
  valid,
  this.lapBuffer,
  null,
  tuneId,
  invalidReason,
  sectors
)
// AFTER:
this.db.insertLap(
  this.currentSession.sessionId,
  lapNum,
  lapTime,
  valid,
  this.lapBuffer,
  null,
  tuneId,
  invalidReason,
  sectors
)
```

Apply the same `this.db.` prefix to all three `insertLap` call sites.

- [ ] **Step 6: Replace `getTrackOutlineSectors` call at line ~521**

Change:
```typescript
const dbSectors = await getTrackOutlineSectors(trackOrdinal, gameId);
```
To:
```typescript
const dbSectors = await this.db.getTrackOutlineSectors(trackOrdinal, gameId);
```

- [ ] **Step 7: Update the module-level singleton export (line 900)**

Add the import for `RealDbAdapter` at the top of the file (alongside the existing imports):
```typescript
import { RealDbAdapter } from "./pipeline-adapters";
```

Change line 900 from:
```typescript
export const lapDetector = new LapDetector();
```
To:
```typescript
export const lapDetector = new LapDetector(new RealDbAdapter());
```

- [ ] **Step 8: Run the full test suite**

```bash
bun test
```
Expected: all existing tests pass. The `lapDetector` singleton export still works via `new LapDetector(new RealDbAdapter())`.

- [ ] **Step 9: Commit**

```bash
git add server/lap-detector.ts
git commit -m "refactor(lap-detector): accept DbAdapter via constructor, remove direct db imports"
```

---

### Task 3: Extract `Pipeline` class from `server/pipeline.ts`

**Files:**
- Modify: `server/pipeline.ts`

Current `pipeline.ts` structure:
- Lines 1-9: imports (includes `wsManager`, `lapDetector` singleton, `getLaps`)
- Lines 11-12: `const sectorTracker`, `const pitTracker`
- Lines 15-21: `broadcastSessionLaps` helper function
- Lines 23-50: callback assignments on the imported `lapDetector`
- Line 52: `let _totalProcessed = 0`
- Lines 60-114: `export async function processPacket(...)`

After refactoring, all of this becomes a `Pipeline` class. Two backward-compat exports at the bottom create the singleton and re-export `processPacket` and `lapDetector`.

- [ ] **Step 1: Replace the imports at the top of `server/pipeline.ts`**

Replace the existing import block entirely with:
```typescript
import type { TelemetryPacket, GameId } from "../shared/types";
import type { DbAdapter, WsAdapter } from "./pipeline-adapters";
import { RealDbAdapter, RealWsAdapter } from "./pipeline-adapters";
import { LapDetector } from "./lap-detector";
import { SectorTracker, PitTracker } from "./sector-tracker";
import { feedPosition } from "./track-calibration";
import { getTrackOutlineByOrdinal } from "../shared/track-data";
import { tryGetGame } from "../shared/games/registry";
import { fillNormSuspension } from "./telemetry-utils";
```

- [ ] **Step 2: Replace all module-level code with the `Pipeline` class**

Remove everything from line 11 to end of file and replace with:

```typescript
export class Pipeline {
  private sectorTracker = new SectorTracker();
  private pitTracker = new PitTracker();
  readonly lapDetector: LapDetector;
  private _totalProcessed = 0;

  constructor(private db: DbAdapter, private ws: WsAdapter) {
    this.lapDetector = new LapDetector(db);

    this.lapDetector.onSessionStart = async (session) => {
      await this.sectorTracker.reset(session.trackOrdinal, session.gameId, session.carOrdinal);
      this.pitTracker.reset();
      const adapter = tryGetGame(session.gameId);
      if (adapter) this.pitTracker.setTireThresholds(adapter.tireHealthThresholds.yellow);
      await this.pitTracker.seedFromHistory(session.trackOrdinal, session.carOrdinal, session.carPI, session.gameId);
      await this._broadcastSessionLaps(session.sessionId, session.trackOrdinal, session.carOrdinal, session.gameId);
    };

    this.lapDetector.onLapComplete_ = (event) => {
      if (event.isValid) {
        this.sectorTracker.updateRefLap(event.packets, event.lapTime, event.sectors);
        const session = this.lapDetector.session;
        if (session && PitTracker.shouldUseCurves(session.gameId)) {
          this.pitTracker.updateWearCurves(event.packets, event.lapDistStart);
        }
      }
    };

    this.lapDetector.onLapSaved = (event) => {
      ws.broadcastNotification({ type: "lap-saved", ...event });
      const session = this.lapDetector.session;
      if (session) this._broadcastSessionLaps(session.sessionId, session.trackOrdinal, session.carOrdinal, session.gameId);
    };
  }

  private async _broadcastSessionLaps(
    sessionId: number,
    trackOrdinal: number,
    carOrdinal: number,
    gameId: GameId
  ): Promise<void> {
    try {
      const allLaps = await this.db.getLaps(gameId, 200);
      const laps = allLaps.filter(
        (l) => l.sessionId === sessionId && l.trackOrdinal === trackOrdinal && l.carOrdinal === carOrdinal
      );
      this.ws.broadcastNotification({ type: "session-laps", laps });
    } catch {}
  }

  async processPacket(packet: TelemetryPacket): Promise<void> {
    this._totalProcessed++;

    const adapter = tryGetGame(packet.gameId);
    if (adapter && adapter.coordSystem === "standard-xyz") {
      packet.PositionX = -packet.PositionX;
      packet.VelocityX = -packet.VelocityX;
      packet.AccelerationX = -packet.AccelerationX;
    }

    fillNormSuspension(packet);

    await this.lapDetector.feed(packet);

    const sectors = this.sectorTracker.feed(packet);

    const sessionBest = this.lapDetector.session?.bestLapTime ?? 0;
    if (packet.gameId === "acc" && sessionBest > 0) {
      packet.BestLap = sessionBest;
    }

    const pit = this.pitTracker.feed(
      packet,
      this.sectorTracker.getTrackLength(),
      this.sectorTracker.getLapDistStart()
    );

    if (this._totalProcessed % 6 === 0) {
      const session = this.lapDetector.session;
      if (session && session.trackOrdinal) {
        const outline = getTrackOutlineByOrdinal(session.trackOrdinal, session.gameId);
        if (outline) {
          feedPosition(
            session.trackOrdinal,
            { x: packet.PositionX, z: packet.PositionZ },
            packet.LapNumber,
            outline
          );
        }
      }
    }

    this.ws.broadcast(packet, sectors, pit);

    this.ws.broadcastDevState({
      lapDetector: this.lapDetector.getDebugState(),
      sectorTracker: this.sectorTracker.getDebugState(),
      pitTracker: this.pitTracker.getDebugState(),
    });
  }
}

// Backward-compatible singleton exports — all existing callers unchanged
const _default = new Pipeline(new RealDbAdapter(), new RealWsAdapter());
export const processPacket = (p: TelemetryPacket) => _default.processPacket(p);
export const lapDetector = _default.lapDetector;
```

- [ ] **Step 3: Run the full test suite**

```bash
bun test
```
Expected: all existing tests pass

- [ ] **Step 4: Commit**

```bash
git add server/pipeline.ts
git commit -m "refactor(pipeline): extract Pipeline class with injected adapters, keep backward-compat exports"
```

---

### Task 4: Export `readAccFrames` from `server/games/acc/recorder.ts`

**Files:**
- Modify: `server/games/acc/recorder.ts`
- Test: `test/acc-recorder.test.ts`

The ACCREC file format (from recorder.ts header comment):
- Header: `[8 bytes magic][u32le version][u32le physicsSize][u32le graphicsSize][u32le staticSize]` = 24 bytes (`HEADER_SIZE`)
- Frames: `[f64le timestamp (8 bytes)][physics buf][graphics buf][static buf]`

Constants already defined in recorder.ts:
- `HEADER_SIZE = 24` (8+4+4+4+4)
- `FRAME_HEADER = 8` (f64le timestamp)
- `readHeader(buf)` returns `{ physicsSize, graphicsSize, staticSize }` or null

- [ ] **Step 1: Write the failing test**

```typescript
// test/acc-recorder.test.ts
import { describe, test, expect } from "bun:test";
import { AccRecorder, readAccFrames } from "../server/games/acc/recorder";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import os from "os";

describe("readAccFrames", () => {
  test("reads frames written by AccRecorder", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new AccRecorder();
      const filePath = recorder.start(dir);

      const physics = Buffer.alloc(800, 0x01);
      const graphics = Buffer.alloc(1200, 0x02);
      const staticData = Buffer.alloc(1000, 0x03);

      recorder.writeFrame(physics, graphics, staticData);
      recorder.writeFrame(physics, graphics, staticData);
      await recorder.stop();

      const frames = readAccFrames(filePath);
      expect(frames).toHaveLength(2);
      expect(frames[0].physics).toEqual(physics);
      expect(frames[0].graphics).toEqual(graphics);
      expect(frames[0].staticData).toEqual(staticData);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns empty array for file with no frames", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new AccRecorder();
      const filePath = recorder.start(dir);
      await recorder.stop();
      const frames = readAccFrames(filePath);
      expect(frames).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
```

Note: the `AccRecorder` constructor uses `PHYSICS.SIZE`, `GRAPHICS.SIZE`, `STATIC.SIZE` from `./structs` for the header. The test allocates fixed-size buffers that won't match those sizes, so this test will fail once `readAccFrames` is exported — it will fail with a wrong buffer size. See Step 3 for the correct test.

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun test test/acc-recorder.test.ts
```
Expected: error `readAccFrames is not a function` or `readAccFrames is not exported`

- [ ] **Step 3: Verify correct buffer sizes from structs and update the test**

Check the actual sizes:
```bash
grep -n "SIZE\b" server/games/acc/structs.ts | head -10
```

The `AccRecorder` header encodes the sizes it was compiled with (from `PHYSICS.SIZE`, `GRAPHICS.SIZE`, `STATIC.SIZE`). `readAccFrames` reads those sizes from the header, so the test buffers must match. Update the test to use the actual sizes:

```typescript
// Read the actual sizes used by AccRecorder
import { PHYSICS, GRAPHICS, STATIC } from "../server/games/acc/structs";

// In the test:
const physics = Buffer.alloc(PHYSICS.SIZE, 0x01);
const graphics = Buffer.alloc(GRAPHICS.SIZE, 0x02);
const staticData = Buffer.alloc(STATIC.SIZE, 0x03);
```

Full corrected test file:
```typescript
// test/acc-recorder.test.ts
import { describe, test, expect } from "bun:test";
import { AccRecorder, readAccFrames } from "../server/games/acc/recorder";
import { PHYSICS, GRAPHICS, STATIC } from "../server/games/acc/structs";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import os from "os";

describe("readAccFrames", () => {
  test("reads frames written by AccRecorder", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new AccRecorder();
      const filePath = recorder.start(dir);

      const physics = Buffer.alloc(PHYSICS.SIZE, 0x01);
      const graphics = Buffer.alloc(GRAPHICS.SIZE, 0x02);
      const staticData = Buffer.alloc(STATIC.SIZE, 0x03);

      recorder.writeFrame(physics, graphics, staticData);
      recorder.writeFrame(physics, graphics, staticData);
      await recorder.stop();

      const frames = readAccFrames(filePath);
      expect(frames).toHaveLength(2);
      expect(frames[0].physics).toEqual(physics);
      expect(frames[0].graphics).toEqual(graphics);
      expect(frames[0].staticData).toEqual(staticData);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns empty array for file with no frames", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "acc-test-"));
    try {
      const recorder = new AccRecorder();
      const filePath = recorder.start(dir);
      await recorder.stop();
      const frames = readAccFrames(filePath);
      expect(frames).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
```

- [ ] **Step 4: Add `readAccFrames` to `server/games/acc/recorder.ts`**

Add this function after the `readHeader` function (after line 127, before `replayRecording`):

```typescript
/**
 * Read all frames from an ACC recording file.
 * Returns an array of {physics, graphics, staticData} buffer tuples.
 * A truncated final frame is silently skipped (safe after hard kill).
 */
export function readAccFrames(
  filePath: string
): { physics: Buffer; graphics: Buffer; staticData: Buffer }[] {
  const data = Buffer.from(require("fs").readFileSync(filePath));
  const header = readHeader(data);
  if (!header) return [];

  const { physicsSize, graphicsSize, staticSize } = header;
  const frameSize = FRAME_HEADER + physicsSize + graphicsSize + staticSize;
  const frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[] = [];

  let offset = HEADER_SIZE;
  while (offset + frameSize <= data.length) {
    const physicsStart = offset + FRAME_HEADER;
    const graphicsStart = physicsStart + physicsSize;
    const staticStart = graphicsStart + graphicsSize;

    frames.push({
      physics: Buffer.from(data.subarray(physicsStart, graphicsStart)),
      graphics: Buffer.from(data.subarray(graphicsStart, staticStart)),
      staticData: Buffer.from(data.subarray(staticStart, staticStart + staticSize)),
    });
    offset += frameSize;
  }

  return frames;
}
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
bun test test/acc-recorder.test.ts
```
Expected: 2 tests passing

- [ ] **Step 6: Run the full test suite**

```bash
bun test
```
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add server/games/acc/recorder.ts test/acc-recorder.test.ts
git commit -m "feat(acc): export readAccFrames for reading ACCREC files in tests"
```

---

### Task 5: Create `test/helpers/parse-dump.ts`

**Files:**
- Create: `test/helpers/parse-dump.ts`
- Test: `test/parse-dump.test.ts`

`parseDump` feeds a dump file through a `Pipeline` instance backed by `CapturingDbAdapter` and `NullWsAdapter`, then returns the captured laps.

For UDP games (f1-2025, fm-2023): reads `Buffer[]` from `readUdpDump`, finds the correct server adapter via `canHandle`, creates a `parserState`, calls `tryParse` per buffer, feeds packets into `pipeline.processPacket`.

For ACC: reads `{ physics, graphics, staticData }[]` from `readAccFrames`, calls `parseAccBuffers` per frame, feeds packets into `pipeline.processPacket`.

`insertLap` in `lap-detector.ts` is called via `setTimeout(..., 0)` — a single `await new Promise(r => setTimeout(r, 0))` after the loop flushes all pending lap writes.

- [ ] **Step 1: Write the failing test**

```typescript
// test/parse-dump.test.ts
import { describe, test, expect } from "bun:test";
import { parseDump } from "./helpers/parse-dump";

describe("parseDump", () => {
  test("returns empty array for a missing dump file (UDP game)", async () => {
    const laps = await parseDump("f1-2025", "/nonexistent/dump.bin");
    expect(laps).toEqual([]);
  });

  test("returns empty array for a missing dump file (ACC)", async () => {
    const laps = await parseDump("acc", "/nonexistent/dump.bin");
    expect(laps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun test test/parse-dump.test.ts
```
Expected: error `Cannot find module './helpers/parse-dump'`

- [ ] **Step 3: Create `test/helpers/parse-dump.ts`**

```typescript
import type { GameId } from "../../shared/types";
import type { CapturedLap } from "../../server/pipeline-adapters";
import { CapturingDbAdapter, NullWsAdapter } from "../../server/pipeline-adapters";
import { Pipeline } from "../../server/pipeline";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getAllServerGames } from "../../server/games/registry";
import { readUdpDump } from "./recording";
import { readAccFrames } from "../../server/games/acc/recorder";
import { parseAccBuffers } from "../../server/games/acc/parser";

let _initialized = false;
function ensureInit(): void {
  if (_initialized) return;
  initGameAdapters();
  initServerGameAdapters();
  _initialized = true;
}

/**
 * Feed a recorded dump through the full server pipeline and return all captured laps.
 * Uses CapturingDbAdapter (no real DB writes) and NullWsAdapter (no WebSocket).
 *
 * @param gameId   The game the dump was recorded for
 * @param dumpPath Path to the dump.bin file
 */
export async function parseDump(
  gameId: GameId,
  dumpPath: string
): Promise<CapturedLap[]> {
  ensureInit();

  const db = new CapturingDbAdapter();
  const ws = new NullWsAdapter();
  const pipeline = new Pipeline(db, ws);

  if (gameId === "acc") {
    let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
    try {
      frames = readAccFrames(dumpPath);
    } catch {
      return [];
    }
    for (const frame of frames) {
      const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {});
      if (packet) await pipeline.processPacket(packet);
    }
  } else {
    let buffers: Buffer[];
    try {
      buffers = readUdpDump(dumpPath);
    } catch {
      return [];
    }

    if (buffers.length === 0) return [];

    const serverAdapter = getAllServerGames().find((a) => a.canHandle(buffers[0]));
    if (!serverAdapter) return [];

    const parserState = serverAdapter.createParserState?.() ?? null;
    for (const buf of buffers) {
      const packet = serverAdapter.tryParse(buf, parserState);
      if (packet) await pipeline.processPacket(packet);
    }
  }

  // Flush deferred insertLap calls (lap-detector uses setTimeout(..., 0))
  await new Promise<void>((r) => setTimeout(r, 0));

  return db.laps;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
bun test test/parse-dump.test.ts
```
Expected: 2 tests passing

- [ ] **Step 5: Run the full test suite**

```bash
bun test
```
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add test/helpers/parse-dump.ts test/parse-dump.test.ts
git commit -m "feat: add parseDump test helper for feeding recordings through the pipeline"
```

---

## Self-Review

**Spec coverage:**
- `DbAdapter` + `WsAdapter` interfaces: ✅ Task 1
- `CapturedLap` type: ✅ Task 1 (replaces spec's `NewLap` — avoids storing the raw telemetry blob in tests)
- `RealDbAdapter`, `RealWsAdapter`, `CapturingDbAdapter`, `NullWsAdapter`: ✅ Task 1
- `LapDetector` constructor `DbAdapter` param, remove direct DB imports: ✅ Task 2
- `Pipeline` class with injected adapters: ✅ Task 3
- Backward-compat `processPacket` and `lapDetector` exports: ✅ Task 3
- `readAccFrames` exported from `recorder.ts`: ✅ Task 4
- `parseDump(gameId, dumpPath)` helper: ✅ Task 5
- `server/index.ts`, `server/udp.ts`, `server/games/acc/shared-memory.ts` — zero changes: ✅ none of these files are touched

**Note — `broadcastStatus` omitted from `WsAdapter`:** The spec listed `broadcastStatus` in `WsAdapter` but `pipeline.ts` never calls it. Omitted per YAGNI. If needed later, it can be added to the interface and all four implementations.

**Note — `SectorTracker` and `PitTracker` still use the real DB:** `sector-tracker.ts` imports `getLaps`/`getLapById`/`getTrackOutlineSectors` directly (not through the adapter). This is intentional — the spec says zero changes to `sector-tracker.ts`. In `parseDump`, these reads hit a real SQLite DB (Bun creates `data/forza-telemetry.db` if missing) and return empty results, which is fine for test correctness.

**Placeholder scan:** No TBDs, no "similar to above", no vague requirements. All code is complete.

**Type consistency:**
- `CapturedLap` defined in Task 1, imported in Task 5 ✅
- `DbAdapter`/`WsAdapter` defined in Task 1, used in Tasks 2, 3 ✅
- `readAccFrames` return shape `{ physics, graphics, staticData }` matches Task 4 and Task 5 usage ✅
- `Pipeline` class exported in Task 3, imported in Task 5 ✅
- `LapDetector` class exported in Task 2, imported in Task 3 ✅
