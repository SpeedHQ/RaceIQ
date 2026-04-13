# AC Evo Game Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Assetto Corsa Evo as a fully supported game in RaceIQ, using the same shared memory infrastructure as ACC with its own car/track catalogue and client routes.

**Architecture:** AC Evo reuses all ACC shared memory plumbing (`BufferedAccMemoryReader`, `TripletAssembler`, `TripletPipeline`, `parseAccBuffers`) with a minimal change to pass `gameId: "ac-evo"` through the parser. A new process checker watches for `AssettoCorsa.exe`, and a new `AcEvoSharedMemoryReader` wires it all together. The client mirrors the ACC route structure under `/ac-evo/`.

**Tech Stack:** Bun, Hono, TypeScript, React 19, TanStack Router (file-based), Zustand, TanStack Query, Tailwind CSS v4, shadcn.

---

## File Map

**Modified files:**
- `shared/types.ts` — add `"ac-evo"` to `KNOWN_GAME_IDS`
- `shared/games/init.ts` — register `acEvoAdapter`
- `server/games/acc/parser.ts` — add optional `gameId` to `overrides`
- `server/games/acc/triplet-pipeline.ts` — `ParsingProcessor` passes `gameId`
- `server/games/init.ts` — register `acEvoServerAdapter`
- `server/routes.ts` — mount `acEvoRoutes`
- `server/index.ts` — create and start `acEvoReader`
- `client/src/components/acc/AccLiveDashboard.tsx` — accept optional `gameId` prop

**New files:**
- `shared/games/ac-evo/index.ts` — shared `GameAdapter`
- `shared/games/ac-evo/cars.csv` — AC Evo car catalogue
- `shared/games/ac-evo/tracks.csv` — AC Evo track catalogue
- `shared/ac-evo-car-data.ts` — CSV-backed car lookup
- `shared/ac-evo-track-data.ts` — CSV-backed track lookup
- `server/games/ac-evo/index.ts` — `ServerGameAdapter`
- `server/games/ac-evo/process-checker.ts` — watches for `AssettoCorsa.exe`
- `server/games/ac-evo/shared-memory.ts` — `AcEvoSharedMemoryReader`
- `server/routes/ac-evo-routes.ts` — `/api/ac-evo/cars`, `/api/ac-evo/cars/:ordinal/class`, `/api/ac-evo/debug/raw`
- `client/src/components/ac-evo/AcEvoCars.tsx` — car catalogue page
- `client/src/routes/ac-evo.tsx` — layout route
- `client/src/routes/ac-evo/index.tsx`
- `client/src/routes/ac-evo/live.tsx`
- `client/src/routes/ac-evo/analyse.tsx`
- `client/src/routes/ac-evo/sessions.tsx`
- `client/src/routes/ac-evo/compare.tsx`
- `client/src/routes/ac-evo/tracks.tsx`
- `client/src/routes/ac-evo/cars.tsx`
- `client/src/routes/ac-evo/raw.tsx`
- `client/src/routes/ac-evo/chats.tsx`

---

### Task 1: Add "ac-evo" to KNOWN_GAME_IDS

**Files:**
- Modify: `shared/types.ts:3`

- [ ] **Step 1: Edit `KNOWN_GAME_IDS`**

In `shared/types.ts`, change line 3:

```typescript
export const KNOWN_GAME_IDS = ["fm-2023", "f1-2025", "acc", "ac-evo"] as const;
```

- [ ] **Step 2: Run tests to confirm nothing breaks**

```bash
bun test
```

Expected: all existing tests pass (this change is additive — no test should break).

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat(ac-evo): add ac-evo to KNOWN_GAME_IDS"
```

---

### Task 2: Create shared GameAdapter + CSV catalogues

**Files:**
- Create: `shared/games/ac-evo/index.ts`
- Create: `shared/games/ac-evo/cars.csv`
- Create: `shared/games/ac-evo/tracks.csv`

- [ ] **Step 1: Create `shared/games/ac-evo/index.ts`**

```typescript
import type { GameAdapter } from "../types";

export const acEvoAdapter: GameAdapter = {
  id: "ac-evo",
  displayName: "Assetto Corsa Evo",
  shortName: "AC Evo",
  routePrefix: "ac-evo",
  coordSystem: "standard-xyz",
  steeringCenter: 0,
  steeringRange: 1,
  tireHealthThresholds: { green: 0.85, yellow: 0.70 },
  tireTempThresholds: { cold: 70, warm: 100, hot: 120 },
  brakeTempThresholds: {
    front: { warm: 650, hot: 700 },
    rear:  { warm: 450, hot: 500 },
  },

  // Stubs — server adapter overrides with real CSV-backed lookups
  getCarName(ordinal: number): string {
    return `Car #${ordinal}`;
  },

  getTrackName(ordinal: number): string {
    return `Track #${ordinal}`;
  },

  getSharedTrackName(_ordinal: number): string | undefined {
    return undefined;
  },

  carForwardOffset(yaw) { return [Math.sin(yaw), Math.cos(yaw)]; },
  followViewRotation(yaw) { return Math.PI - yaw; },
};
```

- [ ] **Step 2: Create `shared/games/ac-evo/cars.csv`**

```csv
id,model,name,class
0,ferrari_sf90_stradale,Ferrari SF90 Stradale,Road
1,ferrari_488_pista,Ferrari 488 Pista,Road
2,lamborghini_huracan_evo,Lamborghini Huracan EVO,Road
3,lamborghini_huracan_sto,Lamborghini Huracan STO,Road
4,bmw_m4_competition,BMW M4 Competition,Road
5,bmw_m4_csl,BMW M4 CSL,Road
6,alfa_romeo_giulia_gta,Alfa Romeo Giulia GTA,Road
7,abarth_695,Abarth 695,Road
8,lotus_emira_v6,Lotus Emira V6,Road
9,toyota_gr86,Toyota GR86,Road
10,porsche_911_gt3_rs,Porsche 911 GT3 RS,Road
11,lamborghini_revuelto,Lamborghini Revuelto,Road
50,ferrari_296_gt3,Ferrari 296 GT3,GT3
51,bmw_m4_gt3,BMW M4 GT3,GT3
52,mclaren_720s_gt3_evo,McLaren 720S GT3 EVO,GT3
53,porsche_992_gt3_r,Porsche 992 GT3 R,GT3
54,lamborghini_huracan_gt3_evo2,Lamborghini Huracan GT3 EVO2,GT3
55,mercedes_amg_gt3_2024,Mercedes-AMG GT3 2024,GT3
56,audi_r8_lms_evo2,Audi R8 LMS EVO II,GT3
57,honda_nsx_gt3_evo,Honda NSX GT3 Evo,GT3
```

- [ ] **Step 3: Create `shared/games/ac-evo/tracks.csv`**

`commonTrackName` resolves to ACC track outline folders so track maps work immediately.

```csv
id,name,variant,commonTrackName
0,Monza,GP,monza
1,Nurburgring,GP,nurburgring
2,Brands Hatch,GP,brands-hatch
3,Mount Panorama,GP,mount-panorama
4,Misano,GP,misano
5,Spa-Francorchamps,GP,spa
6,Silverstone,GP,silverstone
7,Imola,GP,imola
8,Paul Ricard,GP,paul-ricard
9,Laguna Seca,GP,laguna-seca
```

- [ ] **Step 4: Commit**

```bash
git add shared/games/ac-evo/
git commit -m "feat(ac-evo): shared GameAdapter + car/track CSV catalogues"
```

---

### Task 3: Create shared CSV-backed data lookups

**Files:**
- Create: `shared/ac-evo-car-data.ts`
- Create: `shared/ac-evo-track-data.ts`

- [ ] **Step 1: Create `shared/ac-evo-car-data.ts`**

```typescript
import { readFileSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "./resolve-data";

interface AcEvoCar {
  id: number;
  model: string;
  name: string;
  class: string;
}

let carMap: Map<number, AcEvoCar> | null = null;
let modelMap: Map<string, AcEvoCar> | null = null;

function ensureLoaded(): void {
  if (carMap) return;
  carMap = new Map();
  modelMap = new Map();
  const csv = readFileSync(resolve(SHARED_DIR, "games/ac-evo/cars.csv"), "utf-8");
  const lines = csv.trim().split("\n").slice(1); // skip header
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",");
    if (parts.length < 4) continue;
    const id = parseInt(parts[0], 10);
    const model = parts[1].trim();
    const carClass = parts[parts.length - 1].trim();
    const name = parts.slice(2, parts.length - 1).join(",").trim();
    if (!isNaN(id)) {
      const car: AcEvoCar = { id, model, name, class: carClass };
      carMap.set(id, car);
      modelMap!.set(model, car);
    }
  }
}

export function getAcEvoCarName(ordinal: number): string {
  ensureLoaded();
  const car = carMap!.get(ordinal);
  return car ? car.name : `Car #${ordinal}`;
}

export function getAcEvoCarNameByModel(model: string): string {
  ensureLoaded();
  const car = modelMap!.get(model);
  return car ? car.name : model;
}

export function getAcEvoCarClass(ordinal: number): string | undefined {
  ensureLoaded();
  return carMap!.get(ordinal)?.class;
}

export function getAllAcEvoCars(): AcEvoCar[] {
  ensureLoaded();
  return Array.from(carMap!.values());
}
```

- [ ] **Step 2: Create `shared/ac-evo-track-data.ts`**

```typescript
import { readFileSync } from "fs";
import { resolve } from "path";
import { SHARED_DIR } from "./resolve-data";

interface AcEvoTrack {
  id: number;
  name: string;
  variant: string;
  commonTrackName: string;
}

let trackMap: Map<number, AcEvoTrack> | null = null;

function ensureLoaded(): Map<number, AcEvoTrack> {
  if (trackMap) return trackMap;
  trackMap = new Map();
  const csv = readFileSync(resolve(SHARED_DIR, "games/ac-evo/tracks.csv"), "utf-8");
  const lines = csv.trim().split("\n").slice(1); // skip header
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",");
    if (parts.length < 3) continue;
    const id = parseInt(parts[0], 10);
    const name = parts[1];
    const variant = parts[2];
    const commonTrackName = parts[3]?.trim() ?? "";
    if (!isNaN(id) && name) {
      trackMap.set(id, { id, name: name.trim(), variant: variant.trim(), commonTrackName });
    }
  }
  return trackMap;
}

export function getAcEvoTrackName(ordinal: number): string {
  const track = ensureLoaded().get(ordinal);
  return track ? `${track.name} - ${track.variant}` : `Track #${ordinal}`;
}

export function getAcEvoSharedTrackName(ordinal: number): string | undefined {
  const track = ensureLoaded().get(ordinal);
  if (!track) return undefined;
  return track.commonTrackName || undefined;
}

export function getAcEvoTracks(): Map<number, AcEvoTrack> {
  return ensureLoaded();
}
```

- [ ] **Step 3: Commit**

```bash
git add shared/ac-evo-car-data.ts shared/ac-evo-track-data.ts
git commit -m "feat(ac-evo): CSV-backed car/track data lookups"
```

---

### Task 4: Register acEvoAdapter in shared init

**Files:**
- Modify: `shared/games/init.ts`

- [ ] **Step 1: Edit `shared/games/init.ts`**

```typescript
import { registerGame } from "./registry";
import { forzaAdapter } from "./fm-2023";
import { f1Adapter } from "./f1-2025";
import { accAdapter } from "./acc";
import { acEvoAdapter } from "./ac-evo";

/** Register all known game adapters. Call once at app startup. */
export function initGameAdapters(): void {
  registerGame(forzaAdapter);
  registerGame(f1Adapter);
  registerGame(accAdapter);
  registerGame(acEvoAdapter);
}
```

- [ ] **Step 2: Run tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add shared/games/init.ts
git commit -m "feat(ac-evo): register acEvoAdapter in shared init"
```

---

### Task 5: Patch ACC parser and pipeline to support gameId override

**Files:**
- Modify: `server/games/acc/parser.ts`
- Modify: `server/games/acc/triplet-pipeline.ts`

- [ ] **Step 1: Patch `server/games/acc/parser.ts`**

Change the function signature at line 15 to add `gameId` to overrides:

```typescript
export function parseAccBuffers(
  physicsBuf: Buffer,
  graphicsBuf: Buffer,
  staticBuf: Buffer,
  overrides?: { carOrdinal?: number; trackOrdinal?: number; gameId?: import("../../../shared/types").GameId }
): TelemetryPacket | null {
```

Then at the packet construction (line 295), change the `gameId` field:

```typescript
  const packet: TelemetryPacket = {
    gameId: overrides?.gameId ?? "acc",
    // ... rest unchanged
```

- [ ] **Step 2: Patch `server/games/acc/triplet-pipeline.ts` — `ParsingProcessor`**

Change the `ParsingProcessor` class to accept and pass `gameId`:

```typescript
export class ParsingProcessor implements TripletProcessor {
  private carOrdinal: number;
  private trackOrdinal: number;
  private gameId: import("../../../shared/types").GameId;

  constructor(
    carOrdinal: number,
    trackOrdinal: number,
    _accRecorder?: any,
    gameId: import("../../../shared/types").GameId = "acc",
  ) {
    this.carOrdinal = carOrdinal;
    this.trackOrdinal = trackOrdinal;
    this.gameId = gameId;
  }

  async process(triplet: { physics: Buffer; graphics: Buffer; staticData: Buffer }): Promise<void> {
    try {
      const { parseAccBuffers } = require("./parser") as typeof import("./parser");
      const { processPacket } = require("../../pipeline");

      const packet = parseAccBuffers(triplet.physics, triplet.graphics, triplet.staticData, {
        carOrdinal: this.carOrdinal,
        trackOrdinal: this.trackOrdinal,
        gameId: this.gameId,
      });
      if (packet) {
        await processPacket(packet);
      }
    } catch (err) {
      console.error("[ACC ParsingProcessor] Error:", err instanceof Error ? err.message : err);
      throw err;
    }
  }
}
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

Expected: all tests pass. The change is backward-compatible — existing code passes no `gameId` so `"acc"` is used.

- [ ] **Step 4: Commit**

```bash
git add server/games/acc/parser.ts server/games/acc/triplet-pipeline.ts
git commit -m "feat(ac-evo): add optional gameId override to ACC parser/pipeline"
```

---

### Task 6: Create AC Evo server adapter, process checker, shared memory reader

**Files:**
- Create: `server/games/ac-evo/process-checker.ts`
- Create: `server/games/ac-evo/shared-memory.ts`
- Create: `server/games/ac-evo/index.ts`

- [ ] **Step 1: Create `server/games/ac-evo/process-checker.ts`**

```typescript
/**
 * AC Evo Process Checker
 *
 * Monitors system for AC Evo process.
 * Emits events when AC Evo is detected or lost.
 */

import { isGameRunning } from "../registry";
import { EventEmitter } from "events";

export class AcEvoProcessChecker extends EventEmitter {
  private _checkTimer: ReturnType<typeof setInterval> | null = null;
  private _isRunning = false;

  start(): void {
    if (this._checkTimer) return;

    console.log("[AC Evo ProcessChecker] Started");

    this._checkTimer = setInterval(() => {
      const running = isGameRunning("ac-evo");

      if (running && !this._isRunning) {
        this._isRunning = true;
        this.emit("ac-evo-detected");
        console.log("[AC Evo ProcessChecker] AC Evo process detected");
      } else if (!running && this._isRunning) {
        this._isRunning = false;
        this.emit("ac-evo-lost");
        console.log("[AC Evo ProcessChecker] AC Evo process lost");
      }
    }, 2000);
  }

  stop(): void {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
    console.log("[AC Evo ProcessChecker] Stopped");
  }

  isRunning(): boolean {
    return this._isRunning;
  }
}

export const acEvoProcessChecker = new AcEvoProcessChecker();
```

- [ ] **Step 2: Create `server/games/ac-evo/shared-memory.ts`**

```typescript
/**
 * AC Evo Shared Memory Reader.
 *
 * Reuses ACC's BufferedAccMemoryReader + TripletAssembler + TripletPipeline
 * infrastructure (same shared memory format). Only differences:
 *   - Uses acEvoProcessChecker (watches AssettoCorsa.exe / AC2.exe)
 *   - Passes gameId: "ac-evo" to ParsingProcessor
 */
import { BufferedAccMemoryReader } from "../acc/buffered-memory-reader";
import { TripletAssembler } from "../acc/triplet-assembler";
import { TripletPipeline, StatusCheckProcessor, ParsingProcessor } from "../acc/triplet-pipeline";
import { acEvoProcessChecker } from "./process-checker";

export class AcEvoSharedMemoryReader {
  private _bufferedReader: BufferedAccMemoryReader;
  private _tripletAssembler: TripletAssembler;
  private _pipeline: TripletPipeline;
  private _running = false;
  private _connected = false;

  constructor() {
    this._bufferedReader = new BufferedAccMemoryReader();
    const enableMetrics = process.env.NODE_ENV !== "production" || process.env.ACC_METRICS === "1";
    this._tripletAssembler = new TripletAssembler(this._bufferedReader, enableMetrics);
    this._pipeline = new TripletPipeline();
  }

  get connected(): boolean {
    return this._connected;
  }

  get running(): boolean {
    return this._running;
  }

  /** Read current raw buffers for debugging. Returns null if not connected. */
  getDebugBuffers(): { physics: Buffer; graphics: Buffer; staticData: Buffer } | null {
    return this._bufferedReader.getDebugBuffers();
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    console.log("[AC Evo] Starting shared memory reader...");

    acEvoProcessChecker.on("ac-evo-detected", () => this._onDetected());
    acEvoProcessChecker.on("ac-evo-lost", () => this._onLost());

    acEvoProcessChecker.start();
  }

  async stop(): Promise<void> {
    this._running = false;
    await this._tripletAssembler.stop();
    await this._bufferedReader.stop();
    this._connected = false;
    console.log("[AC Evo] Shared memory reader stopped");
  }

  private _onDetected(): void {
    if (this._connected) return;

    console.log("[AC Evo] AC Evo process detected, starting buffered reader...");

    this._bufferedReader.start();
    this._connected = true;

    this._pipeline.register(new StatusCheckProcessor(this._disconnect.bind(this)));
    this._pipeline.register(new ParsingProcessor(0, 0, undefined, "ac-evo"));

    console.log("[AC Evo] Triplet pipeline: StatusCheckProcessor → ParsingProcessor (gameId: ac-evo)");

    this._tripletAssembler.start(this._pipeline.process.bind(this._pipeline));

    console.log("[AC Evo] Connected - buffers reading and pipeline active");
  }

  private async _disconnect(): Promise<void> {
    if (this._connected) {
      this._connected = false;
      await this._tripletAssembler.stop();
      await this._bufferedReader.stop();
      console.log("[AC Evo] Disconnected from shared memory");
    }
  }

  private _onLost(): void {
    console.log("[AC Evo] AC Evo process lost, disconnecting...");
    this._disconnect();
  }
}
```

- [ ] **Step 3: Create `server/games/ac-evo/index.ts`**

```typescript
import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/types";
import { acEvoAdapter } from "../../../shared/games/ac-evo";
import { getAcEvoCarName } from "../../../shared/ac-evo-car-data";
import { getAcEvoTrackName, getAcEvoSharedTrackName } from "../../../shared/ac-evo-track-data";
import { LapDetectorV2 } from "../../lap-detector-v2";

const AC_EVO_SYSTEM_PROMPT = `You are an expert motorsport engineer and data analyst specializing in Assetto Corsa Evo.

You are analyzing telemetry data from a lap in AC Evo. Your role is to provide specific, actionable advice to improve lap time.

Key areas of expertise:
- Mixed car class characteristics (road cars, GT3, touring cars)
- Tire management across different compounds and temperature windows
- Electronics management (TC, ABS, engine map optimization)
- Brake bias and brake fade management
- Corner-by-corner analysis with specific techniques
- Driving technique adaptation for different car types (road car vs GT3)

When analyzing data:
- Reference specific corners by name when possible
- Compare tire temperatures (inner/outer/core) to identify setup issues
- Flag any electronics settings that seem suboptimal for conditions
- Identify braking points, trail braking opportunities, and throttle application
- Note differences in driving technique required for road vs race cars
- Consider tire type (road, slick, semi-slick) in all recommendations

Be concise and prioritize the highest-impact improvements first.`;

export const acEvoServerAdapter: ServerGameAdapter = {
  ...acEvoAdapter,

  processNames: ["AssettoCorsa.exe", "AC2.exe"],

  getCarName(ordinal: number): string {
    return getAcEvoCarName(ordinal);
  },

  getTrackName(ordinal: number): string {
    return getAcEvoTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getAcEvoSharedTrackName(ordinal);
  },

  // AC Evo uses shared memory, not UDP
  canHandle(_buf: Buffer): boolean {
    return false;
  },

  tryParse(_buf: Buffer, _state: unknown): TelemetryPacket | null {
    return null;
  },

  createParserState(): null {
    return null;
  },

  createLapDetector: (opts) => new LapDetectorV2(opts),

  aiSystemPrompt: AC_EVO_SYSTEM_PROMPT,

  buildAiContext(packets: TelemetryPacket[]): string {
    if (packets.length === 0) return "";

    const first = packets[0];
    const last = packets[packets.length - 1];
    const accFirst = first.acc;
    const accLast = last.acc;

    const lines: string[] = [];

    if (accFirst) {
      lines.push(`Tire compound: ${accFirst.tireCompound}`);
      lines.push(`Electronics — TC: ${accFirst.tc}, TC Cut: ${accFirst.tcCut}, ABS: ${accFirst.abs}, Engine Map: ${accFirst.engineMap}`);
      lines.push(`Brake bias: ${(accFirst.brakeBias * 100).toFixed(1)}% front`);
    }

    if (accLast) {
      lines.push(`Fuel per lap: ${accLast.fuelPerLap.toFixed(2)}L`);
      lines.push(`Tire core temps (end) — FL: ${accLast.tireCoreTemp[0].toFixed(1)}°C, FR: ${accLast.tireCoreTemp[1].toFixed(1)}°C, RL: ${accLast.tireCoreTemp[2].toFixed(1)}°C, RR: ${accLast.tireCoreTemp[3].toFixed(1)}°C`);
      lines.push(`Brake pad wear — FL: ${(accLast.brakePadWear[0] * 100).toFixed(1)}%, FR: ${(accLast.brakePadWear[1] * 100).toFixed(1)}%, RL: ${(accLast.brakePadWear[2] * 100).toFixed(1)}%, RR: ${(accLast.brakePadWear[3] * 100).toFixed(1)}%`);

      const hasDamage = Object.values(accLast.carDamage).some((v) => v > 0);
      if (hasDamage) {
        lines.push(`Car damage — Front: ${accLast.carDamage.front.toFixed(2)}, Rear: ${accLast.carDamage.rear.toFixed(2)}, Left: ${accLast.carDamage.left.toFixed(2)}, Right: ${accLast.carDamage.right.toFixed(2)}`);
      }
    }

    const speeds = packets.map((p) => p.Speed * 3.6);
    const maxSpeed = Math.max(...speeds);
    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    lines.push(`Speed — Max: ${maxSpeed.toFixed(1)} km/h, Avg: ${avgSpeed.toFixed(1)} km/h`);

    return lines.join("\n");
  },
};
```

- [ ] **Step 4: Commit**

```bash
git add server/games/ac-evo/
git commit -m "feat(ac-evo): server adapter, process checker, shared memory reader"
```

---

### Task 7: Register acEvoServerAdapter + wire server

**Files:**
- Modify: `server/games/init.ts`
- Create: `server/routes/ac-evo-routes.ts`
- Modify: `server/routes.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Register in `server/games/init.ts`**

```typescript
import { registerServerGame } from "./registry";
import { registerGame } from "../../shared/games/registry";
import { forzaServerAdapter } from "./fm-2023";
import { f1ServerAdapter } from "./f1-2025";
import { accServerAdapter } from "./acc";
import { acEvoServerAdapter } from "./ac-evo";

/** Register all server game adapters. Call once at server startup. */
export function initServerGameAdapters(): void {
  registerServerGame(f1ServerAdapter);
  registerServerGame(forzaServerAdapter);
  registerServerGame(accServerAdapter);
  registerServerGame(acEvoServerAdapter);

  registerGame(f1ServerAdapter);
  registerGame(forzaServerAdapter);
  registerGame(accServerAdapter);
  registerGame(acEvoServerAdapter);
}
```

- [ ] **Step 2: Create `server/routes/ac-evo-routes.ts`**

```typescript
import { Hono } from "hono";
import { getAllAcEvoCars, getAcEvoCarClass } from "../../shared/ac-evo-car-data";
import { PHYSICS, GRAPHICS, STATIC } from "../games/acc/structs";
import { readWString } from "../games/acc/utils";

export const acEvoRoutes = new Hono()

  .get("/api/ac-evo/cars", (c) => {
    const cars = getAllAcEvoCars().map((car) => ({ ...car }));
    cars.sort((a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name));
    return c.json(cars);
  })

  .get("/api/ac-evo/cars/:ordinal/class", (c) => {
    const ord = Number(c.req.param("ordinal"));
    if (!Number.isFinite(ord)) return c.json({ class: null });
    return c.json({ class: getAcEvoCarClass(ord) ?? null });
  })

  .get("/api/ac-evo/debug/raw", (c) => {
    // Lazily import acEvoReader to avoid circular deps
    const { acEvoReader } = require("../index") as typeof import("../index");
    const bufs = acEvoReader.getDebugBuffers?.();
    if (!bufs) {
      return c.json({ error: "AC Evo not connected or getDebugBuffers not available" }, 503);
    }
    const { physics, graphics, staticData } = bufs;

    const p: Record<string, number> = {};
    for (const [key, def] of Object.entries(PHYSICS)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      const { offset, type } = def as { offset: number; type: string };
      if (offset + 4 > physics.length) { p[key] = -999; continue; }
      p[key] = type === "f32" ? physics.readFloatLE(offset) : physics.readInt32LE(offset);
    }

    const g: Record<string, number | string> = {};
    for (const [key, def] of Object.entries(GRAPHICS)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      const d = def as { offset: number; type: string; size?: number };
      if (d.type === "wstring") {
        g[key] = readWString(graphics, d.offset, d.size!);
      } else {
        if (d.offset + 4 > graphics.length) { g[key] = -999; continue; }
        g[key] = d.type === "f32" ? graphics.readFloatLE(d.offset) : graphics.readInt32LE(d.offset);
      }
    }

    const s: Record<string, number | string> = {};
    for (const [key, def] of Object.entries(STATIC)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      const d = def as { offset: number; type: string; size?: number };
      if (d.type === "wstring") {
        s[key] = readWString(staticData, d.offset, d.size!);
      } else {
        if (d.offset + 4 > staticData.length) { s[key] = -999; continue; }
        s[key] = d.type === "f32" ? staticData.readFloatLE(d.offset) : staticData.readInt32LE(d.offset);
      }
    }

    return c.json({ physics: p, graphics: g, static: s });
  });
```

- [ ] **Step 3: Mount routes in `server/routes.ts`**

Add after the existing `accRoutes` import and mount:

```typescript
import { acEvoRoutes } from "./routes/ac-evo-routes";
```

And in the chain:

```typescript
  .route("/", accRoutes)
  .route("/", acEvoRoutes)
  .route("/", f125Routes)
```

- [ ] **Step 4: Wire `acEvoReader` in `server/index.ts`**

Below the existing `accReader` block (around line 167), add:

```typescript
import { AcEvoSharedMemoryReader } from "./games/ac-evo/shared-memory";

// Create AC Evo reader alongside ACC reader
export const acEvoReader = new AcEvoSharedMemoryReader();

// Start AC Evo shared memory reader (Windows only, same as ACC)
if (process.platform === "win32") {
  acEvoReader.start();
  console.log("[Server] AC Evo shared memory reader started (will connect when AC Evo is running)");
}
```

- [ ] **Step 5: Run tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/games/init.ts server/routes/ac-evo-routes.ts server/routes.ts server/index.ts
git commit -m "feat(ac-evo): register server adapter, API routes, reader startup"
```

---

### Task 8: Patch AccLiveDashboard to accept gameId prop

**Files:**
- Modify: `client/src/components/acc/AccLiveDashboard.tsx`

- [ ] **Step 1: Edit `AccLiveDashboard.tsx`**

Change the function signature and replace the three hardcoded `"acc"` strings:

```typescript
import type { GameId } from "@shared/types";

export function AccLiveDashboard({ gameId = "acc" }: { gameId?: GameId }) {
  const packet = useTelemetryStore((s) => s.packet);
  const { data: trackName } = useTrackName(packet?.TrackOrdinal);
  const { data: carName } = useCarName(packet?.CarOrdinal);
  const pressureOptimal = useTirePressureOptimal(gameId, packet?.CarOrdinal);

  if (!packet || packet.gameId !== gameId) {
    return (
      <div className="flex-1 flex flex-col">
        <NoDataView />
      </div>
    );
  }

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 h-full">
      {/* Left column: Tires + Pit Window */}
      <div className="border-r border-app-border overflow-auto">
        {/* Tires */}
        <div className="border-b border-app-border">
          <TireGrid
            fl={{ tempC: packet.TireTempFL, wear: packet.TireWearFL, brakeTemp: packet.BrakeTempFrontLeft ?? 0, brakePadMm: packet.acc?.brakePadWear[0], pressure: packet.TirePressureFrontLeft ?? 0 }}
            fr={{ tempC: packet.TireTempFR, wear: packet.TireWearFR, brakeTemp: packet.BrakeTempFrontRight ?? 0, brakePadMm: packet.acc?.brakePadWear[1], pressure: packet.TirePressureFrontRight ?? 0 }}
            rl={{ tempC: packet.TireTempRL, wear: packet.TireWearRL, brakeTemp: packet.BrakeTempRearLeft ?? 0, brakePadMm: packet.acc?.brakePadWear[2], pressure: packet.TirePressureRearLeft ?? 0 }}
            rr={{ tempC: packet.TireTempRR, wear: packet.TireWearRR, brakeTemp: packet.BrakeTempRearRight ?? 0, brakePadMm: packet.acc?.brakePadWear[3], pressure: packet.TirePressureRearRight ?? 0 }}
            healthThresholds={tryGetGame(gameId)?.tireHealthThresholds ?? { green: 0.85, yellow: 0.70 }}
            tempThresholds={{ blue: 70, orange: 100, red: 110 }}
            pressureOptimal={pressureOptimal}
            brakeTempThresholds={tryGetGame(gameId)?.brakeTempThresholds}
            compound={packet.acc?.tireCompound}
          />
        </div>

        {/* Pit Window */}
        <div className="border-b border-app-border">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Pit Window</h2>
          </div>
          <div className="p-3">
            <PitEstimate packet={packet} />
          </div>
        </div>
      </div>

      {/* Right column: Race (with sectors) + Charts + Recorded Laps */}
      <div className="overflow-auto flex flex-col">
        <RaceInfo packet={packet} trackName={trackName} carName={carName} showTrackMap={false} showSectors={true} />

        <LapTimeChart packet={packet} />

        <div className="flex-1">
          <RecordedLaps />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/acc/AccLiveDashboard.tsx
git commit -m "feat(ac-evo): AccLiveDashboard accepts optional gameId prop"
```

---

### Task 9: Create AcEvoCars component

**Files:**
- Create: `client/src/components/ac-evo/AcEvoCars.tsx`

- [ ] **Step 1: Create `client/src/components/ac-evo/AcEvoCars.tsx`**

This is a copy of `AccCars.tsx` that queries the AC Evo endpoint and uses AC Evo-appropriate class colours (Road cars are a new class).

```typescript
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { client } from "../../lib/rpc";

interface AcEvoCar {
  id: number;
  name: string;
  class: string;
}

const CLASS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  GT3:  { bg: "bg-blue-500/15",    text: "text-blue-400",    border: "border-blue-500/20" },
  Road: { bg: "bg-emerald-500/15", text: "text-emerald-400", border: "border-emerald-500/20" },
};

function classColor(cls: string) {
  return CLASS_COLORS[cls] ?? { bg: "bg-app-surface-alt/20", text: "text-app-text-dim", border: "border-app-border" };
}

const BRAND_COLORS: Record<string, string> = {
  "Ferrari":       "#dc0000",
  "Lamborghini":   "#ddb321",
  "BMW":           "#0066b1",
  "McLaren":       "#ff8000",
  "Porsche":       "#c4a035",
  "Mercedes-AMG":  "#00d2be",
  "Audi":          "#bb0a30",
  "Honda":         "#cc0000",
  "Alfa Romeo":    "#900000",
  "Abarth":        "#e04000",
  "Lotus":         "#b9cc00",
  "Toyota":        "#eb0a1e",
};

function getBrandColor(name: string): string {
  for (const [brand, color] of Object.entries(BRAND_COLORS)) {
    if (name.startsWith(brand)) return color;
  }
  return "#555";
}

function getManufacturer(name: string): string {
  return name.split(" ")[0];
}

export function AcEvoCars() {
  const { data: cars = [], isLoading } = useQuery<AcEvoCar[]>({
    queryKey: ["ac-evo-cars"],
    queryFn: () => client.api["ac-evo"].cars.$get().then((r) => r.json()),
  });

  const [filterClass, setFilterClass] = useState<string | null>(null);

  const classes = useMemo(() => {
    const set = new Set(cars.map((c) => c.class));
    return Array.from(set).sort();
  }, [cars]);

  const filtered = useMemo(() => {
    let result = cars;
    if (filterClass) result = result.filter((c) => c.class === filterClass);
    return [...result].sort((a, b) => a.name.localeCompare(b.name));
  }, [cars, filterClass]);

  const grouped = useMemo(() => {
    const map = new Map<string, AcEvoCar[]>();
    for (const car of filtered) {
      const list = map.get(car.class) ?? [];
      list.push(car);
      map.set(car.class, list);
    }
    return map;
  }, [filtered]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-app-text-dim">
        Loading cars...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          <button
            className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
              !filterClass ? "bg-app-accent/20 text-app-accent" : "text-app-text-muted hover:text-app-text-secondary"
            }`}
            onClick={() => setFilterClass(null)}
          >
            All
          </button>
          {classes.map((cls) => {
            const c = classColor(cls);
            const count = cars.filter((car) => car.class === cls).length;
            return (
              <button
                key={cls}
                className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
                  filterClass === cls ? `${c.bg} ${c.text}` : "text-app-text-muted hover:text-app-text-secondary"
                }`}
                onClick={() => setFilterClass(filterClass === cls ? null : cls)}
              >
                {cls} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Car grid by class */}
      {Array.from(grouped.entries()).map(([cls, classCars]) => {
        const c = classColor(cls);
        return (
          <div key={cls}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${c.bg} ${c.text}`}>{cls}</span>
              <span className="text-xs text-app-text-dim">{classCars.length} cars</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {classCars.map((car) => {
                const brandColor = getBrandColor(car.name);
                return (
                  <div
                    key={car.id}
                    className="group relative bg-app-surface-alt/20 rounded-lg border border-app-border/10 overflow-hidden hover:border-app-border/30 transition-all"
                  >
                    <div className="h-0.5" style={{ backgroundColor: brandColor }} />
                    <div className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-app-text-primary leading-tight">
                            {car.name}
                          </div>
                          <div className="text-xs text-app-text-muted mt-0.5">
                            {getManufacturer(car.name)}
                          </div>
                        </div>
                        <span className={`shrink-0 text-xs font-bold px-1.5 py-0.5 rounded ${c.bg} ${c.text}`}>
                          {cls}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/ac-evo/AcEvoCars.tsx
git commit -m "feat(ac-evo): AcEvoCars catalogue component"
```

---

### Task 10: Create client routes

**Files:**
- Create: `client/src/routes/ac-evo.tsx`
- Create: `client/src/routes/ac-evo/index.tsx`
- Create: `client/src/routes/ac-evo/live.tsx`
- Create: `client/src/routes/ac-evo/analyse.tsx`
- Create: `client/src/routes/ac-evo/sessions.tsx`
- Create: `client/src/routes/ac-evo/compare.tsx`
- Create: `client/src/routes/ac-evo/tracks.tsx`
- Create: `client/src/routes/ac-evo/cars.tsx`
- Create: `client/src/routes/ac-evo/raw.tsx`
- Create: `client/src/routes/ac-evo/chats.tsx`

- [ ] **Step 1: Create `client/src/routes/ac-evo.tsx`** (layout route)

```typescript
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useGameStore } from "../stores/game";

function AcEvoLayout() {
  const setGameId = useGameStore((s) => s.setGameId);
  useEffect(() => {
    setGameId("ac-evo");
    return () => setGameId(null);
  }, [setGameId]);
  return <Outlet />;
}

export const Route = createFileRoute("/ac-evo")({
  component: AcEvoLayout,
});
```

- [ ] **Step 2: Create `client/src/routes/ac-evo/index.tsx`**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "../../components/HomePage";

export const Route = createFileRoute("/ac-evo/")({
  component: HomePage,
});
```

- [ ] **Step 3: Create `client/src/routes/ac-evo/live.tsx`**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { AccLiveDashboard } from "../../components/acc/AccLiveDashboard";

export const Route = createFileRoute("/ac-evo/live")({
  component: () => <AccLiveDashboard gameId="ac-evo" />,
});
```

- [ ] **Step 4: Create `client/src/routes/ac-evo/analyse.tsx`**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { LapAnalyse } from "../../components/LapAnalyse";

type AnalyseSearch = {
  track?: number;
  car?: number;
  lap?: number;
};

export const Route = createFileRoute("/ac-evo/analyse")({
  component: () => (
    <div className="h-full overflow-hidden">
      <LapAnalyse />
    </div>
  ),
  validateSearch: (search: Record<string, unknown>): AnalyseSearch => ({
    track: search.track ? Number(search.track) : undefined,
    car: search.car ? Number(search.car) : undefined,
    lap: search.lap ? Number(search.lap) : undefined,
  }),
});
```

- [ ] **Step 5: Create `client/src/routes/ac-evo/sessions.tsx`**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { SessionsPage } from "../../components/SessionsPage";

export const Route = createFileRoute("/ac-evo/sessions")({
  component: SessionsPage,
});
```

- [ ] **Step 6: Create `client/src/routes/ac-evo/compare.tsx`**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { LapComparison } from "../../components/LapComparison";

type CompareSearch = {
  track?: number;
  carA?: number;
  carB?: number;
  lapA?: number;
  lapB?: number;
};

export const Route = createFileRoute("/ac-evo/compare")({
  component: () => (
    <div className="h-full overflow-hidden">
      <LapComparison />
    </div>
  ),
  validateSearch: (search: Record<string, unknown>): CompareSearch => ({
    track: search.track ? Number(search.track) : undefined,
    carA: search.carA ? Number(search.carA) : undefined,
    carB: search.carB ? Number(search.carB) : undefined,
    lapA: search.lapA ? Number(search.lapA) : undefined,
    lapB: search.lapB ? Number(search.lapB) : undefined,
  }),
});
```

- [ ] **Step 7: Create `client/src/routes/ac-evo/tracks.tsx`**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { TrackViewer } from "../../components/TrackViewer";

type TracksSearch = {
  track?: number;
  tab?: string;
};

export const Route = createFileRoute("/ac-evo/tracks")({
  component: () => (
    <div className="flex-1 overflow-auto">
      <TrackViewer />
    </div>
  ),
  validateSearch: (search: Record<string, unknown>): TracksSearch => ({
    track: search.track ? Number(search.track) : undefined,
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
});
```

- [ ] **Step 8: Create `client/src/routes/ac-evo/cars.tsx`**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { AcEvoCars } from "../../components/ac-evo/AcEvoCars";

export const Route = createFileRoute("/ac-evo/cars")({
  component: AcEvoCars,
});
```

- [ ] **Step 9: Create `client/src/routes/ac-evo/raw.tsx`**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { RawTelemetry } from "../../components/RawTelemetry";
import { useTelemetryStore } from "../../stores/telemetry";

function RawPage() {
  const { packet } = useTelemetryStore();
  return (
    <div className="flex-1 overflow-hidden">
      <RawTelemetry packet={packet} />
    </div>
  );
}

export const Route = createFileRoute("/ac-evo/raw")({
  component: RawPage,
});
```

- [ ] **Step 10: Create `client/src/routes/ac-evo/chats.tsx`**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { ChatsPage } from "../../components/ChatsPage";

export const Route = createFileRoute("/ac-evo/chats")({
  component: () => (
    <div className="h-full overflow-hidden">
      <ChatsPage />
    </div>
  ),
});
```

- [ ] **Step 11: Commit**

```bash
git add client/src/routes/ac-evo.tsx client/src/routes/ac-evo/
git commit -m "feat(ac-evo): client routes (live, analyse, sessions, compare, tracks, cars, raw, chats)"
```

---

### Task 11: Run client build + regenerate route tree

TanStack Router auto-generates `client/src/routeTree.gen.ts` during the Vite dev build. After adding new route files, the route tree must be regenerated.

**Files:**
- Modified by tooling: `client/src/routeTree.gen.ts`

- [ ] **Step 1: Run the client build (which regenerates the route tree)**

```bash
cd client && bun run build
```

Expected: build completes with no TypeScript errors. The `routeTree.gen.ts` will be updated to include all `/ac-evo/*` routes.

If TypeScript errors occur, fix them before proceeding. Common issues:
- `GameId` import path wrong in `AccLiveDashboard.tsx` — use `import type { GameId } from "@shared/types";`
- `client.api["ac-evo"]` not typed — this resolves once `acEvoRoutes` is mounted in `server/routes.ts` and the `AppType` is inferred correctly. The Hono RPC client derives types from the server router at compile time via `@/lib/rpc.ts`.

- [ ] **Step 2: Run all tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 3: Commit the regenerated route tree and any fixes**

```bash
git add client/src/routeTree.gen.ts
git commit -m "feat(ac-evo): regenerate route tree with ac-evo routes"
```

---

### Task 12: Final verification

- [ ] **Step 1: Start the dev server**

```bash
bun run dev
```

- [ ] **Step 2: Verify AC Evo routes render**

Open `http://localhost:5173/ac-evo` — should show the HomePage.  
Open `http://localhost:5173/ac-evo/cars` — should show the AC Evo car list (20 cars across Road + GT3 classes).  
Open `http://localhost:5173/ac-evo/live` — should show the live dashboard (NoDataView since AC Evo isn't running).

- [ ] **Step 3: Verify API routes**

```bash
curl http://localhost:3117/api/ac-evo/cars | head -c 500
```

Expected: JSON array of cars with `id`, `model`, `name`, `class` fields.

```bash
curl http://localhost:3117/api/ac-evo/cars/50/class
```

Expected: `{"class":"GT3"}`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(ac-evo): complete AC Evo game adapter integration"
```

---

## Self-Review Checklist

- ✅ **KNOWN_GAME_IDS** — Task 1 adds `"ac-evo"`
- ✅ **Shared GameAdapter** — Task 2 creates `shared/games/ac-evo/index.ts`
- ✅ **Car/track CSVs** — Task 2 creates both CSV files
- ✅ **CSV-backed lookups** — Task 3 creates `getAcEvoCarName`, `getAcEvoTrackName`, `getAcEvoSharedTrackName`
- ✅ **Shared registry** — Task 4 registers `acEvoAdapter`
- ✅ **Parser gameId override** — Task 5 adds `overrides?.gameId ?? "acc"` to packet construction
- ✅ **Pipeline gameId passthrough** — Task 5 extends `ParsingProcessor` constructor
- ✅ **Process checker** — Task 6 creates `AcEvoProcessChecker` watching `AssettoCorsa.exe`
- ✅ **Shared memory reader** — Task 6 creates `AcEvoSharedMemoryReader` (wraps ACC infra, passes `gameId: "ac-evo"`)
- ✅ **Server adapter** — Task 6 creates `acEvoServerAdapter` with AI prompt + buildAiContext
- ✅ **Server registry** — Task 7 registers in `server/games/init.ts`
- ✅ **API routes** — Task 7 creates `/api/ac-evo/cars`, `/api/ac-evo/cars/:ordinal/class`, `/api/ac-evo/debug/raw`
- ✅ **Reader startup** — Task 7 adds `acEvoReader` to `server/index.ts`
- ✅ **AccLiveDashboard** — Task 8 replaces 3× hardcoded `"acc"` with `gameId` prop
- ✅ **AcEvoCars component** — Task 9 creates cars page querying `/api/ac-evo/cars`
- ✅ **All 10 client routes** — Task 10 creates layout + all sub-routes
- ✅ **Route tree regen** — Task 11 runs client build to regenerate `routeTree.gen.ts`
- ✅ **Track outlines** — reused via `commonTrackName` in CSV (no new data files needed)
- ✅ **Navigation** — `routePrefix: "ac-evo"` enables automatic tab generation via game store
