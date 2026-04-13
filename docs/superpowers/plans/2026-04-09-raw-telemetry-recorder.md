# Raw Telemetry Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone `bun run dev:record <gameId>` entry point that records raw telemetry to disk without running any server pipeline, for use in writing tests and developing parsers offline.

**Architecture:** `server/record.ts` is a completely standalone Bun entry (no HTTP, no WebSocket, no lap detector) that opens a UDP socket or ACC shared memory reader, writes raw packets/frames to disk, and resolves game metadata (track/car) from the first few packets. ACC reuses the existing `AccRecorder` class; UDP games get a new `UdpRecorder` class. Each recording session writes a `meta.json` alongside the binary dump.

**Tech Stack:** Bun, dgram (Node.js UDP), Bun FFI (kernel32.dll for ACC shared memory), existing `AccRecorder` from `server/games/acc/recorder.ts`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/udp-recorder.ts` | Create | Appends length-prefixed raw UDP packets to a binary file |
| `server/record-meta.ts` | Create | Atomic `meta.json` writer shared by UDP and ACC paths |
| `server/record.ts` | Create | Standalone entry: arg parsing, UDP or ACC recording dispatch |
| `test/helpers/recording.ts` | Create | `readUdpDump()` test helper — reads length-prefixed dump back into `Buffer[]` |
| `package.json` | Modify | Add `dev:record` script |

**Existing files used (do not modify):**
- `server/games/acc/recorder.ts` — `AccRecorder`, `accRecorder` singleton, `replayRecording()`
- `server/games/acc/structs.ts` — `PHYSICS`, `GRAPHICS`, `STATIC` struct definitions
- `server/games/acc/utils.ts` — `readWString`, `toWideString`
- `server/settings.ts` — `loadSettings()` for UDP port
- `shared/games/init.ts` — `initGameAdapters()`
- `server/games/init.ts` — `initServerGameAdapters()`
- `shared/games/registry.ts` — `tryGetGame()`
- `server/games/registry.ts` — `getAllServerGames()`
- `shared/acc-car-data.ts` — `getAccCarByModel()`
- `shared/acc-track-data.ts` — `getAccTrackByName()`

---

## Task 1: `UdpRecorder` class

**Files:**
- Create: `server/udp-recorder.ts`

- [ ] **Step 1: Create `server/udp-recorder.ts`**

```typescript
import { existsSync, mkdirSync, writeFileSync, renameSync } from "fs";
import { resolve } from "path";

/**
 * Appends raw UDP packets to a binary dump file.
 *
 * Format: repeated [uint32 LE byte-length][N raw bytes]
 *
 * Append-only writes mean a hard kill truncates at most the last in-flight
 * write — all prior records remain intact. A reader detects truncation by
 * reading the declared length and checking if enough bytes follow.
 */
export class UdpRecorder {
  private _file: Bun.FileSink | null = null;
  private _path: string | null = null;
  private _packetCount = 0;

  get recording(): boolean {
    return this._file !== null;
  }

  get packetCount(): number {
    return this._packetCount;
  }

  get path(): string | null {
    return this._path;
  }

  /** Open dump.bin inside the given session directory. Returns the file path. */
  start(sessionDir: string): string {
    if (this._file) this.stop();
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    this._path = resolve(sessionDir, "dump.bin");
    this._file = Bun.file(this._path).writer();
    this._packetCount = 0;
    console.log(`[UdpRecorder] Recording to ${this._path}`);
    return this._path;
  }

  /** Append one raw UDP packet. */
  writePacket(buf: Buffer): void {
    if (!this._file) return;
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32LE(buf.length, 0);
    this._file.write(lenBuf);
    this._file.write(buf);
    this._packetCount++;
  }

  /** Flush and close. */
  async stop(): Promise<void> {
    if (!this._file) return;
    await this._file.end();
    console.log(`[UdpRecorder] Stopped. ${this._packetCount} packets written to ${this._path}`);
    this._file = null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/udp-recorder.ts
git commit -m "feat(record): add UdpRecorder for raw packet capture"
```

---

## Task 2: `readUdpDump` test helper

**Files:**
- Create: `test/helpers/recording.ts`
- Test: `test/helpers/recording.ts` (self-contained, exercised directly in the test step)

- [ ] **Step 1: Create `test/helpers/recording.ts`**

```typescript
import { readFileSync } from "fs";

/**
 * Read a UDP dump file written by UdpRecorder.
 *
 * Format: repeated [uint32 LE length][N raw bytes]
 * A truncated final record (declared length > remaining bytes) is silently skipped.
 *
 * @returns Array of raw packet Buffers in recording order.
 */
export function readUdpDump(filePath: string): Buffer[] {
  const data = readFileSync(filePath);
  const packets: Buffer[] = [];
  let offset = 0;

  while (offset + 4 <= data.length) {
    const len = data.readUInt32LE(offset);
    offset += 4;
    if (offset + len > data.length) break; // truncated final record
    packets.push(data.slice(offset, offset + len));
    offset += len;
  }

  return packets;
}
```

- [ ] **Step 2: Write a test that verifies round-trip correctness**

Create `test/udp-recorder.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { UdpRecorder } from "../server/udp-recorder";
import { readUdpDump } from "./helpers/recording";

describe("UdpRecorder + readUdpDump", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("round-trips packets through dump file", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new UdpRecorder();
    recorder.start(tmpDir);

    const pkt1 = Buffer.from([0x01, 0x02, 0x03]);
    const pkt2 = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
    recorder.writePacket(pkt1);
    recorder.writePacket(pkt2);
    await recorder.stop();

    const packets = readUdpDump(recorder.path!);
    expect(packets).toHaveLength(2);
    expect(packets[0]).toEqual(pkt1);
    expect(packets[1]).toEqual(pkt2);
  });

  test("readUdpDump handles truncated final record gracefully", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    // Construct a valid record followed by a truncated one
    const valid = Buffer.from([0x03, 0x00, 0x00, 0x00, 0xAA, 0xBB, 0xCC]); // len=3, 3 bytes
    const truncated = Buffer.from([0x05, 0x00, 0x00, 0x00, 0xFF]); // declares 5 bytes, only 1 present
    const dumpPath = join(tmpDir, "dump.bin");
    require("fs").writeFileSync(dumpPath, Buffer.concat([valid, truncated]));

    const packets = readUdpDump(dumpPath);
    expect(packets).toHaveLength(1);
    expect(packets[0]).toEqual(Buffer.from([0xAA, 0xBB, 0xCC]));
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
bun test test/udp-recorder.test.ts
```

Expected: 2 passing tests.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/recording.ts test/udp-recorder.test.ts
git commit -m "feat(record): add readUdpDump test helper and UdpRecorder tests"
```

---

## Task 3: `RecordingMeta` atomic writer

**Files:**
- Create: `server/record-meta.ts`

- [ ] **Step 1: Create `server/record-meta.ts`**

```typescript
import { writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import type { GameId } from "../shared/types";

export interface RecordingMeta {
  gameId: GameId;
  trackOrdinal: number | null;
  trackName: string | null;
  carOrdinal: number | null;
  carName: string | null;
  startedAt: string;
}

/**
 * Write meta.json atomically to sessionDir using write-to-tmp + rename.
 * Safe to call multiple times as metadata is resolved; each call overwrites.
 */
export function writeRecordingMeta(sessionDir: string, meta: RecordingMeta): void {
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  const tmpPath = resolve(sessionDir, "meta.tmp");
  const finalPath = resolve(sessionDir, "meta.json");
  writeFileSync(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
  renameSync(tmpPath, finalPath);
}
```

- [ ] **Step 2: Commit**

```bash
git add server/record-meta.ts
git commit -m "feat(record): add atomic RecordingMeta writer"
```

---

## Task 4: `server/record.ts` — UDP path

**Files:**
- Create: `server/record.ts`

This task implements the UDP recording path (f1-2025, fm-2023). ACC is added in Task 5.

Read `server/udp.ts` before writing — match the same dgram socket setup (64MB receive buffer, `0.0.0.0` bind). Read `server/settings.ts` to see how `loadSettings()` works and what shape `settings.udpPort` has.

- [ ] **Step 1: Create `server/record.ts` with UDP path**

```typescript
/**
 * Standalone raw telemetry recorder.
 *
 * Usage: bun run server/record.ts <gameId>
 *   e.g. bun run server/record.ts f1-2025
 *        bun run server/record.ts fm-2023
 *        bun run server/record.ts acc
 *
 * Records raw packets/frames to data/recordings/<timestamp>/ (UDP)
 * or data/acc-recordings/ (ACC, using existing AccRecorder format).
 * Does NOT start HTTP, WebSocket, lap detector, or pipeline.
 */
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "./games/init";
import { getAllServerGames, tryGetServerGame } from "./games/registry";
import { tryGetGame } from "../shared/games/registry";
import { loadSettings } from "./settings";
import { UdpRecorder } from "./udp-recorder";
import { writeRecordingMeta, type RecordingMeta } from "./record-meta";
import { resolve } from "path";

// Register all game adapters (needed for canHandle + parsing)
initGameAdapters();
initServerGameAdapters();

const gameId = process.argv[2];
if (!gameId) {
  console.error("Usage: bun run server/record.ts <gameId>");
  console.error("  Known games:", getAllServerGames().map((g) => g.id).join(", "));
  process.exit(1);
}

const serverAdapter = tryGetServerGame(gameId);
const sharedAdapter = tryGetGame(gameId);
if (!serverAdapter || !sharedAdapter) {
  console.error(`Unknown game: ${gameId}`);
  console.error("  Known games:", getAllServerGames().map((g) => g.id).join(", "));
  process.exit(1);
}

// --- Session directory ---
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "T").slice(0, 19);
const sessionDir = resolve(process.cwd(), "data", "recordings", timestamp);

const meta: RecordingMeta = {
  gameId: gameId as import("../shared/types").GameId,
  trackOrdinal: null,
  trackName: null,
  carOrdinal: null,
  carName: null,
  startedAt: new Date().toISOString(),
};

// Write initial meta immediately so the directory + file exists
writeRecordingMeta(sessionDir, meta);

if (gameId === "acc") {
  await recordAcc(sessionDir, meta);
} else {
  await recordUdp(serverAdapter, sharedAdapter, sessionDir, meta);
}

// ─── UDP recording ────────────────────────────────────────────────────────────

async function recordUdp(
  serverAdapter: NonNullable<ReturnType<typeof tryGetServerGame>>,
  sharedAdapter: NonNullable<ReturnType<typeof tryGetGame>>,
  sessionDir: string,
  meta: RecordingMeta
): Promise<void> {
  const settings = loadSettings();
  const udpPort = settings.udpPort ?? (Number(process.env.UDP_PORT) || 5301);

  const recorder = new UdpRecorder();
  recorder.start(sessionDir);

  // Parser state for metadata extraction (first ~100 packets only)
  const parserState = serverAdapter!.createParserState();
  let metaResolved = false;
  let parsedCount = 0;
  const META_RESOLVE_LIMIT = 100;

  const dgram = require("dgram");
  const sock = dgram.createSocket("udp4");

  sock.on("message", (buf: Buffer) => {
    recorder.writePacket(buf);

    // Resolve track/car from first few packets
    if (!metaResolved && parsedCount < META_RESOLVE_LIMIT) {
      parsedCount++;
      try {
        const packet = serverAdapter.tryParse(buf, parserState);
        if (packet && packet.TrackOrdinal && packet.CarOrdinal) {
          meta.trackOrdinal = packet.TrackOrdinal;
          meta.carOrdinal = packet.CarOrdinal;
          meta.trackName = sharedAdapter.getTrackName(packet.TrackOrdinal) ?? null;
          meta.carName = sharedAdapter.getCarName(packet.CarOrdinal) ?? null;
          metaResolved = true;
          writeRecordingMeta(sessionDir, meta);
          console.log(`[Record] Resolved: track=${meta.trackName} car=${meta.carName}`);
        }
      } catch {
        // Ignore parse errors during metadata resolution
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    sock.bind(udpPort, "0.0.0.0", () => {
      try {
        sock.setRecvBufferSize(64 * 1024 * 1024);
      } catch {}
      resolve();
    });
    sock.on("error", reject);
  });

  console.log(`[Record] Listening on UDP :${udpPort} — game=${gameId}`);
  console.log(`[Record] Writing to ${sessionDir}`);
  console.log(`[Record] Press Ctrl+C to stop`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[Record] Stopping...");
    sock.close();
    await recorder.stop();
    // Write final meta (in case meta was never resolved, null fields stay null)
    writeRecordingMeta(sessionDir, meta);
    console.log(`[Record] Done. ${recorder.packetCount} packets recorded.`);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ─── ACC recording (stub — implemented in Task 5) ────────────────────────────

async function recordAcc(_sessionDir: string, _meta: RecordingMeta): Promise<never> {
  console.error("[Record] ACC recording not yet implemented");
  process.exit(1);
}
```

- [ ] **Step 2: Add `dev:record` to `package.json`**

Open `package.json`. In the `scripts` object, add after the existing `dev:server` line:

```json
"dev:record": "bun run server/record.ts",
```

- [ ] **Step 3: Smoke-test (manual)**

```bash
bun run dev:record f1-2025
```

Expected console output:
```
[Record] Listening on UDP :5301 — game=f1-2025
[Record] Writing to data/recordings/2026-04-09T...
[Record] Press Ctrl+C to stop
```

Press Ctrl+C. Verify `data/recordings/<timestamp>/meta.json` exists and contains valid JSON. Verify `dump.bin` exists (may be 0 bytes if no game was running — that's fine).

- [ ] **Step 4: Commit**

```bash
git add server/record.ts package.json
git commit -m "feat(record): add standalone recorder entry with UDP path"
```

---

## Task 5: `server/record.ts` — ACC path

**Files:**
- Modify: `server/record.ts` (replace the `recordAcc` stub)

Read `server/games/acc/shared-memory.ts` in full before implementing — specifically `_loadFfi()`, `openSharedMemory()`, `_readMapped()`, `_tryConnect()`, and `_poll()`. The ACC path in `record.ts` is a stripped-down version of those methods that calls `accRecorder.writeFrame()` but never calls `processPacket()`.

Read `server/games/acc/recorder.ts` — understand `accRecorder.start()` and `accRecorder.writeFrame()`.

- [ ] **Step 1: Replace the `recordAcc` stub in `server/record.ts`**

Add these imports at the top of `server/record.ts` (after the existing imports):

```typescript
import { accRecorder } from "./games/acc/recorder";
import { PHYSICS, GRAPHICS, STATIC, AC_STATUS } from "./games/acc/structs";
import { readWString, toWideString } from "./games/acc/utils";
import { getAccCarByModel } from "../shared/acc-car-data";
import { getAccTrackByName } from "../shared/acc-track-data";
```

Replace the `recordAcc` stub function with:

```typescript
async function recordAcc(sessionDir: string, meta: RecordingMeta): Promise<void> {
  const FILE_MAP_READ = 0x0004;

  // Load kernel32.dll FFI — same calls as AccSharedMemoryReader._loadFfi()
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  let kernel32: {
    symbols: {
      OpenFileMappingW(access: number, inherit: boolean, name: unknown): unknown;
      MapViewOfFile(handle: unknown, access: number, offHigh: number, offLow: number, size: number): unknown;
      UnmapViewOfFile(view: unknown): boolean;
      CloseHandle(handle: unknown): boolean;
      RtlCopyMemory(dest: unknown, src: unknown, length: number): void;
    };
  };
  try {
    kernel32 = dlopen("kernel32.dll", {
      OpenFileMappingW: { args: [FFIType.u32, FFIType.bool, FFIType.ptr], returns: FFIType.ptr },
      MapViewOfFile: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      UnmapViewOfFile: { args: [FFIType.ptr], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
      RtlCopyMemory: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.void },
    }) as typeof kernel32;
  } catch (err) {
    console.error("[Record] Failed to load kernel32.dll — ACC recording requires Windows:", err);
    process.exit(1);
  }

  const ffiPtr = ptr as (buf: Buffer) => unknown;

  function openMem(name: string, size: number): { handle: number; view: number; size: number } | null {
    const wideName = toWideString(name);
    const handle = kernel32.symbols.OpenFileMappingW(FILE_MAP_READ, false, ffiPtr(wideName));
    if (!handle || handle === 0) return null;
    const view = kernel32.symbols.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
    if (!view || view === 0) { kernel32.symbols.CloseHandle(handle); return null; }
    return { handle: Number(handle), view: Number(view), size };
  }

  function closeMem(mapped: { handle: number; view: number }): void {
    kernel32.symbols.UnmapViewOfFile(mapped.view);
    kernel32.symbols.CloseHandle(mapped.handle);
  }

  function readMem(mapped: { view: number; size: number }): Buffer {
    const dest = Buffer.alloc(mapped.size);
    kernel32.symbols.RtlCopyMemory(ffiPtr(dest), mapped.view, mapped.size);
    return dest;
  }

  // Wait for ACC to be reachable
  console.log("[Record] Waiting for ACC shared memory...");
  let physics: ReturnType<typeof openMem> = null;
  let graphics: ReturnType<typeof openMem> = null;
  let staticMem: ReturnType<typeof openMem> = null;

  await new Promise<void>((resolve) => {
    const tryConnect = setInterval(() => {
      physics = openMem("Local\\acpmf_physics", PHYSICS.SIZE);
      graphics = openMem("Local\\acpmf_graphics", GRAPHICS.SIZE);
      staticMem = openMem("Local\\acpmf_static", STATIC.SIZE);
      if (physics && graphics && staticMem) {
        clearInterval(tryConnect);
        resolve();
      } else {
        if (physics) closeMem(physics);
        if (graphics) closeMem(graphics);
        if (staticMem) closeMem(staticMem);
        physics = null; graphics = null; staticMem = null;
      }
    }, 2000);
  });

  console.log("[Record] ACC shared memory connected");

  // Resolve track/car from static buffer
  const staticBuf = readMem(staticMem!);
  const carModel = readWString(staticBuf, STATIC.carModel.offset, STATIC.carModel.size);
  const trackStr = readWString(staticBuf, STATIC.track.offset, STATIC.track.size);
  const car = getAccCarByModel(carModel);
  const track = getAccTrackByName(trackStr);
  if (car) { meta.carOrdinal = car.id; meta.carName = carModel; }
  if (track) { meta.trackOrdinal = track.id; meta.trackName = trackStr; }
  writeRecordingMeta(sessionDir, meta);
  console.log(`[Record] Resolved: track=${meta.trackName ?? "unknown"} car=${meta.carName ?? "unknown"}`);

  // Start recording using existing AccRecorder (writes to data/acc-recordings/)
  const accDir = resolve(process.cwd(), "data", "acc-recordings");
  accRecorder.start(accDir);
  console.log(`[Record] ACC recording started`);
  console.log(`[Record] Meta written to ${sessionDir}`);
  console.log(`[Record] Press Ctrl+C to stop`);

  // Poll at 60Hz — write raw frames, no pipeline
  const pollTimer = setInterval(() => {
    if (!physics || !graphics || !staticMem) return;
    try {
      const physicsBuf = readMem(physics!);
      const graphicsBuf = readMem(graphics!);
      const graphicsStatus = graphicsBuf.readInt32LE(GRAPHICS.status.offset);
      if (graphicsStatus !== AC_STATUS.AC_LIVE) return;
      const staticBuf = readMem(staticMem!);
      accRecorder.writeFrame(physicsBuf, graphicsBuf, staticBuf);
    } catch (err) {
      console.error("[Record] Error reading shared memory:", err);
    }
  }, 1000 / 60);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[Record] Stopping...");
    clearInterval(pollTimer);
    if (physics) closeMem(physics);
    if (graphics) closeMem(graphics);
    if (staticMem) closeMem(staticMem);
    await accRecorder.stop();
    writeRecordingMeta(sessionDir, meta);
    console.log(`[Record] Done. ${accRecorder.frameCount} frames recorded.`);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
```

- [ ] **Step 2: Smoke-test (manual, requires Windows)**

```bash
bun run dev:record acc
```

Expected: prints "Waiting for ACC shared memory..." and retries every 2s. If ACC is running and AC_LIVE: "ACC shared memory connected", meta.json written, frames start accumulating. Ctrl+C stops cleanly.

- [ ] **Step 3: Commit**

```bash
git add server/record.ts
git commit -m "feat(record): add ACC path to standalone recorder"
```

---

## Task 6: Verify build passes

- [ ] **Step 1: Run tests**

```bash
bun test
```

Expected: all tests pass including new `test/udp-recorder.test.ts`.

- [ ] **Step 2: Run client build**

```bash
cd client && bun run build
```

Expected: no TypeScript errors, build succeeds.

- [ ] **Step 3: Commit if any fixes were needed, then done**

```bash
git add -A
git commit -m "fix(record): build fixes"
```

---

## Notes for the implementer

- `server/record.ts` must NOT import `./db/index`, `./lap-detector`, `./ws`, `./pipeline`, or any route file — these are the pipeline components we're intentionally bypassing.
- `loadSettings()` reads `data/settings.json` if it exists, returns defaults if not. It does not start the DB or any other subsystem.
- The `tryGetServerGame()` function throws if the game ID isn't registered — always call `initServerGameAdapters()` first (Task 4 does this).
- The ACC path doesn't use `isGameRunning()` (which polls `tasklist` via exec) because the standalone recorder should be able to connect directly without that overhead — it just retries shared memory open every 2s.
- `STATIC.carModel` and `STATIC.track` are `{ offset, size, type: "wstring" }` — pass `.offset` and `.size` to `readWString`.
- The existing `AccRecorder.start()` already creates the output directory. The `sessionDir` in ACC mode holds only `meta.json`; the binary dump goes to `data/acc-recordings/` per existing convention.
