# ACC (Assetto Corsa Competizione) Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Assetto Corsa Competizione as a fully supported game in RaceIQ, reading telemetry via Windows shared memory and achieving full feature parity with existing games.

**Architecture:** Follows the existing game adapter pattern — shared `GameAdapter` + server `ServerGameAdapter` registered in the adapter registry. ACC uses Windows shared memory (Bun FFI → kernel32.dll) instead of UDP for data input. A `processPacket()` function is extracted from `server/udp.ts` so both UDP and shared memory sources feed the same pipeline (lap detection → track calibration → WebSocket broadcast).

**Tech Stack:** Bun FFI (kernel32.dll interop), TypeScript, same stack as existing games.

**Spec:** `docs/superpowers/specs/2026-03-31-acc-support-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `shared/games/acc/index.ts` | Shared `GameAdapter` — identity, steering config, car/track name stubs |
| `server/games/acc/index.ts` | `ServerGameAdapter` — canHandle, tryParse, AI prompt, buildAiContext |
| `server/games/acc/shared-memory.ts` | `AccSharedMemoryReader` — Bun FFI to read Windows memory-mapped files |
| `server/games/acc/parser.ts` | Parse ACC shared memory struct buffers into `TelemetryPacket` |
| `server/games/acc/structs.ts` | ACC struct definitions (offsets, sizes, field types) |
| `server/pipeline.ts` | Extracted `processPacket()` function shared by UDP and shared memory inputs |
| `shared/acc-car-data.ts` | Car model ID → name lookup from CSV |
| `shared/acc-track-data.ts` | Track ID → name lookup from CSV |
| `shared/acc-cars.csv` | ACC car database (model ID, name, class) |
| `shared/acc-tracks.csv` | ACC track database (ID, name, variant) |
| `client/src/routes/acc.tsx` | Route layout — sets `gameId="acc"` |
| `client/src/routes/acc/index.tsx` | Redirects to `/acc/live` |
| `client/src/routes/acc/live.tsx` | Live telemetry page |
| `client/src/routes/acc/sessions.tsx` | Session history |
| `client/src/routes/acc/analyse.tsx` | Lap analysis |
| `client/src/routes/acc/compare.tsx` | Lap comparison |
| `client/src/routes/acc/tracks.tsx` | Track viewer |
| `client/src/routes/acc/cars.tsx` | Car database (placeholder) |
| `client/src/routes/acc/raw.tsx` | Raw telemetry |
| `client/src/routes/acc/tunes.tsx` | Tunes layout (placeholder) |
| `client/src/routes/acc/tunes/index.tsx` | Tunes page (placeholder) |
| `client/src/routes/acc/setup.tsx` | Setup layout (placeholder) |
| `client/src/routes/acc/setup/index.tsx` | Setup page (placeholder) |
| `test/acc-parser.test.ts` | Parser unit tests |
| `test/acc-shared-memory.test.ts` | Shared memory reader tests |

### Modified Files
| File | Change |
|------|--------|
| `shared/types.ts` | Add `"acc"` to `KNOWN_GAME_IDS`, add `AccExtendedData` interface, add `acc?` field to `TelemetryPacket` |
| `shared/games/init.ts` | Register `accAdapter` |
| `server/games/init.ts` | Register `accServerAdapter` |
| `server/udp.ts` | Extract pipeline logic into `server/pipeline.ts`, import and call `processPacket()` |
| `server/index.ts` | Start ACC shared memory reader on server startup |

---

## Task 1: Add ACC to Shared Types

**Files:**
- Modify: `shared/types.ts`

- [ ] **Step 1: Add "acc" to KNOWN_GAME_IDS**

In `shared/types.ts`, find the `KNOWN_GAME_IDS` array and add `"acc"`:

```typescript
export const KNOWN_GAME_IDS = ["fm-2023", "f1-2025", "acc"] as const;
```

- [ ] **Step 2: Add AccExtendedData interface**

Add after the `F1ExtendedData` interface in `shared/types.ts`:

```typescript
/** ACC-specific extended telemetry data from shared memory */
export interface AccExtendedData {
  // Tire detail
  tireCompound: string;
  tireCoreTemp: [number, number, number, number];
  tireInnerTemp: [number, number, number, number];
  tireOuterTemp: [number, number, number, number];

  // Brake detail
  brakePadCompound: number;
  brakePadWear: [number, number, number, number];

  // Electronics
  tc: number;
  tcCut: number;
  abs: number;
  engineMap: number;
  brakeBias: number;

  // Weather
  rainIntensity: number;
  trackGripStatus: string;
  windSpeed: number;
  windDirection: number;

  // Race state
  flagStatus: string;
  drsAvailable: boolean;
  drsEnabled: boolean;
  pitStatus: string;

  // Fuel
  fuelPerLap: number;

  // Damage
  carDamage: {
    front: number;
    rear: number;
    left: number;
    right: number;
    centre: number;
  };
}
```

- [ ] **Step 3: Add acc field to TelemetryPacket**

In the `TelemetryPacket` interface, add alongside the existing `f1?` field:

```typescript
  acc?: AccExtendedData;
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd client && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to AccExtendedData or GameId

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts
git commit -m "feat(acc): add ACC game ID and AccExtendedData type to shared types"
```

---

## Task 2: Create ACC Shared Adapter

**Files:**
- Create: `shared/games/acc/index.ts`
- Create: `shared/acc-car-data.ts`
- Create: `shared/acc-track-data.ts`
- Create: `shared/acc-cars.csv`
- Create: `shared/acc-tracks.csv`
- Modify: `shared/games/init.ts`

- [ ] **Step 1: Create ACC car CSV data**

Create `shared/acc-cars.csv`. This is a subset — include all cars from ACC 1.10 (latest version). Format matches existing CSVs:

```csv
id,name,class
0,Porsche 991 GT3 R,GT3
1,Mercedes-AMG GT3,GT3
2,Ferrari 488 GT3,GT3
3,Audi R8 LMS,GT3
4,Lamborghini Huracan GT3,GT3
5,McLaren 650S GT3,GT3
6,Nissan GT-R Nismo GT3 (2018),GT3
7,BMW M6 GT3,GT3
8,Bentley Continental GT3 (2018),GT3
9,Porsche 991 II GT3 Cup,GTC
10,Nissan GT-R Nismo GT3 (2017),GT3
11,Bentley Continental GT3 (2016),GT3
12,Aston Martin V12 Vantage GT3,GT3
13,Lamborghini Gallardo REX,GT3
14,Jaguar G3,GT3
15,Lexus RC F GT3,GT3
16,Lamborghini Huracan GT3 Evo,GT3
17,Honda NSX GT3,GT3
18,Lamborghini Huracan ST,GTC
19,BMW M4 GT4,GT4
20,Audi R8 LMS GT4,GT4
21,Chevrolet Camaro GT4.R,GT4
22,Ginetta G55 GT4,GT4
23,KTM X-Bow GT4,GT4
24,Maserati MC GT4,GT4
25,Mercedes-AMG GT4,GT4
26,Porsche 718 Cayman GT4 MR,GT4
27,Toyota GR Supra GT4,GT4
28,Aston Martin Vantage GT4,GT4
29,BMW M4 GT3,GT3
30,Audi R8 LMS GT3 Evo II,GT3
31,Ferrari 296 GT3,GT3
32,Lamborghini Huracan GT3 Evo 2,GT3
33,Porsche 992 GT3 R,GT3
34,McLaren 720S GT3 Evo,GT3
35,Ford Mustang GT3,GT3
50,Alpine A110 GT4,GT4
51,Aston Martin Vantage AMR GT3,GT3
52,Audi R8 LMS Evo,GT3
53,BMW M4 GT3 Evo,GT3
54,Ferrari 488 GT3 Evo,GT3
55,Honda NSX GT3 Evo,GT3
56,McLaren 720S GT3,GT3
57,Mercedes-AMG GT3 Evo,GT3
58,Porsche 991 II GT3 R,GT3
59,Reiter Engineering R-EX GT3,GT3
60,Emil Frey Jaguar G3,GT3
```

- [ ] **Step 2: Create ACC track CSV data**

Create `shared/acc-tracks.csv`:

```csv
id,name,variant
0,Monza,GP
1,Zolder,GP
2,Brands Hatch,GP
3,Silverstone,GP
4,Paul Ricard,GP
5,Misano,GP
6,Spa-Francorchamps,GP
7,Nurburgring,GP
8,Barcelona,GP
9,Hungaroring,GP
10,Zandvoort,GP
11,Monza 2019,GP
12,Zolder 2019,GP
13,Brands Hatch 2019,GP
14,Silverstone 2019,GP
15,Paul Ricard 2019,GP
16,Misano 2019,GP
17,Spa 2019,GP
18,Nurburgring 2019,GP
19,Barcelona 2019,GP
20,Hungaroring 2019,GP
21,Zandvoort 2019,GP
22,Kyalami,GP
23,Mount Panorama,GP
24,Suzuka,GP
25,Laguna Seca,GP
26,Oulton Park,GP
27,Donington Park,GP
28,Snetterton,GP
29,Imola,GP
30,Watkins Glen,GP
31,COTA,GP
32,Indianapolis,GP
33,Valencia,GP
34,Red Bull Ring,GP
```

- [ ] **Step 3: Create car data lookup**

Create `shared/acc-car-data.ts`:

```typescript
import { readFileSync } from "fs";
import { resolve, dirname } from "path";

interface AccCar {
  id: number;
  name: string;
  class: string;
}

let carMap: Map<number, AccCar> | null = null;

function ensureLoaded(): Map<number, AccCar> {
  if (carMap) return carMap;
  carMap = new Map();

  // Resolve relative to this file's location (shared/)
  const csvPath = resolve(dirname(import.meta.path.replace("file:///", "")), "acc-cars.csv");
  const csv = readFileSync(csvPath, "utf-8");
  const lines = csv.trim().split("\n").slice(1); // skip header

  for (const line of lines) {
    const [idStr, name, carClass] = line.split(",");
    const id = parseInt(idStr, 10);
    if (!isNaN(id)) {
      carMap.set(id, { id, name: name.trim(), class: carClass.trim() });
    }
  }

  return carMap;
}

export function getAccCarName(ordinal: number): string {
  const car = ensureLoaded().get(ordinal);
  return car ? car.name : `Car #${ordinal}`;
}

export function getAccCarClass(ordinal: number): string | undefined {
  return ensureLoaded().get(ordinal)?.class;
}
```

- [ ] **Step 4: Create track data lookup**

Create `shared/acc-track-data.ts`:

```typescript
import { readFileSync } from "fs";
import { resolve, dirname } from "path";

interface AccTrack {
  id: number;
  name: string;
  variant: string;
}

let trackMap: Map<number, AccTrack> | null = null;

function ensureLoaded(): Map<number, AccTrack> {
  if (trackMap) return trackMap;
  trackMap = new Map();

  const csvPath = resolve(dirname(import.meta.path.replace("file:///", "")), "acc-tracks.csv");
  const csv = readFileSync(csvPath, "utf-8");
  const lines = csv.trim().split("\n").slice(1);

  for (const line of lines) {
    const [idStr, name, variant] = line.split(",");
    const id = parseInt(idStr, 10);
    if (!isNaN(id)) {
      trackMap.set(id, { id, name: name.trim(), variant: variant.trim() });
    }
  }

  return trackMap;
}

export function getAccTrackName(ordinal: number): string {
  const track = ensureLoaded().get(ordinal);
  return track ? `${track.name} - ${track.variant}` : `Track #${ordinal}`;
}

export function getAccSharedTrackName(ordinal: number): string | undefined {
  const track = ensureLoaded().get(ordinal);
  return track ? track.name.toLowerCase().replace(/\s+/g, "-") : undefined;
}
```

- [ ] **Step 5: Create shared adapter**

Create `shared/games/acc/index.ts`:

```typescript
import type { GameAdapter } from "../types";

export const accAdapter: GameAdapter = {
  id: "acc",
  displayName: "Assetto Corsa Competizione",
  shortName: "ACC",
  routePrefix: "acc",
  coordSystem: "standard-xyz",
  steeringCenter: 0,
  steeringRange: 1,
  getCarName(ordinal: number): string {
    return `Car #${ordinal}`;
  },
  getTrackName(ordinal: number): string {
    return `Track #${ordinal}`;
  },
  getSharedTrackName(): string | undefined {
    return undefined;
  },
};
```

- [ ] **Step 6: Register shared adapter**

In `shared/games/init.ts`, add the import and registration:

```typescript
import { accAdapter } from "./acc";

// Inside initGameAdapters():
registerGame(accAdapter);
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `cd client && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add shared/games/acc/ shared/acc-car-data.ts shared/acc-track-data.ts shared/acc-cars.csv shared/acc-tracks.csv shared/games/init.ts
git commit -m "feat(acc): add shared adapter, car/track data files"
```

---

## Task 3: Extract Pipeline from UDP Listener

**Files:**
- Create: `server/pipeline.ts`
- Modify: `server/udp.ts`

- [ ] **Step 1: Create pipeline module**

Create `server/pipeline.ts`:

```typescript
import type { TelemetryPacket } from "../shared/types";
import { wsManager } from "./ws";
import { lapDetector } from "./lap-detector";
import { feedPosition } from "./track-calibration";
import { getTrackOutlineByOrdinal } from "../shared/track-outlines/index";

let _totalProcessed = 0;

/**
 * Shared telemetry processing pipeline.
 * Called by both UDP listener (Forza/F1) and ACC shared memory reader.
 *
 * Pipeline: lap detection → track calibration (~10Hz) → WebSocket broadcast (30Hz)
 */
export function processPacket(packet: TelemetryPacket): void {
  _totalProcessed++;

  lapDetector.feed(packet);

  // Track calibration only needs sparse position data (~10Hz)
  if (_totalProcessed % 6 === 0) {
    const session = lapDetector.session;
    if (session && session.trackOrdinal) {
      const outline = getTrackOutlineByOrdinal(
        session.trackOrdinal,
        session.gameId
      );
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

  // Broadcast to WebSocket clients (handles 30Hz throttle internally)
  wsManager.broadcast(packet);
}
```

- [ ] **Step 2: Update UDP listener to use pipeline**

In `server/udp.ts`, replace the inline pipeline logic in `handlePacket()`:

Remove these imports:
```typescript
import { wsManager } from "./ws";
import { lapDetector } from "./lap-detector";
import { feedPosition } from "./track-calibration";
import { getTrackOutlineByOrdinal } from "../shared/track-outlines/index";
```

Add this import:
```typescript
import { processPacket } from "./pipeline";
```

Replace the body of `handlePacket()` after the `parsePacket` call (lines ~110-131) with:

```typescript
    this._receiving = true;
    processPacket(packet);
```

- [ ] **Step 3: Verify the app still works**

Run: `bun run dev:server`
Expected: Server starts without errors. If a game is running and sending UDP, telemetry still flows through.

- [ ] **Step 4: Commit**

```bash
git add server/pipeline.ts server/udp.ts
git commit -m "refactor: extract processPacket pipeline from UDP listener"
```

---

## Task 4: ACC Shared Memory Struct Definitions

**Files:**
- Create: `server/games/acc/structs.ts`

- [ ] **Step 1: Define ACC struct layouts**

Create `server/games/acc/structs.ts`. These define the byte offsets for reading ACC's C structs from shared memory buffers. Based on ACC's official shared memory documentation (v1.10):

```typescript
/**
 * ACC shared memory struct definitions.
 * Byte offsets for reading flat C structs from memory-mapped file buffers.
 *
 * ACC exposes three structs via Windows shared memory:
 * - SPageFilePhysics: real-time physics (speed, inputs, tires, brakes, fuel)
 * - SPageFileGraphics: session state (laps, sectors, flags, weather, compounds)
 * - SPageFileStatic: per-session constants (car model, track, gear count, max RPM)
 *
 * Reference: ACC shared memory documentation v1.10
 */

// --- SPageFilePhysics ---
// Updated at physics tick rate (~300Hz)
export const PHYSICS = {
  SIZE: 712,
  // int packetId
  packetId: { offset: 0, type: "i32" },
  // float gas (0..1)
  gas: { offset: 4, type: "f32" },
  // float brake (0..1)
  brake: { offset: 8, type: "f32" },
  // float fuel (litres)
  fuel: { offset: 12, type: "f32" },
  // int gear (0=R, 1=N, 2=1st...)
  gear: { offset: 16, type: "i32" },
  // int rpms
  rpms: { offset: 20, type: "i32" },
  // float steerAngle (-1..1)
  steerAngle: { offset: 24, type: "f32" },
  // float speedKmh
  speedKmh: { offset: 28, type: "f32" },
  // float[3] velocity (m/s, world space)
  velocityX: { offset: 32, type: "f32" },
  velocityY: { offset: 36, type: "f32" },
  velocityZ: { offset: 40, type: "f32" },
  // float[3] accG (g-force)
  accGX: { offset: 44, type: "f32" },
  accGY: { offset: 48, type: "f32" },
  accGZ: { offset: 52, type: "f32" },
  // float[4] wheelSlip
  wheelSlipFL: { offset: 56, type: "f32" },
  wheelSlipFR: { offset: 60, type: "f32" },
  wheelSlipRL: { offset: 64, type: "f32" },
  wheelSlipRR: { offset: 68, type: "f32" },
  // float[4] tyreCoreTemperature
  tyreCoreFL: { offset: 100, type: "f32" },
  tyreCoreFR: { offset: 104, type: "f32" },
  tyreCoreRL: { offset: 108, type: "f32" },
  tyreCoreRR: { offset: 112, type: "f32" },
  // float[4] tyrePressure
  tyrePressureFL: { offset: 148, type: "f32" },
  tyrePressureFR: { offset: 152, type: "f32" },
  tyrePressureRL: { offset: 156, type: "f32" },
  tyrePressureRR: { offset: 160, type: "f32" },
  // float[4] suspensionTravel
  suspTravelFL: { offset: 164, type: "f32" },
  suspTravelFR: { offset: 168, type: "f32" },
  suspTravelRL: { offset: 172, type: "f32" },
  suspTravelRR: { offset: 176, type: "f32" },
  // float heading (radians)
  heading: { offset: 216, type: "f32" },
  // float pitch
  pitch: { offset: 220, type: "f32" },
  // float roll
  roll: { offset: 224, type: "f32" },
  // float[4] tyreContactPoint (just need y for surface detection)
  // float[4] tyreTempI (inner)
  tyreTempInnerFL: { offset: 300, type: "f32" },
  tyreTempInnerFR: { offset: 304, type: "f32" },
  tyreTempInnerRL: { offset: 308, type: "f32" },
  tyreTempInnerRR: { offset: 312, type: "f32" },
  // float[4] tyreTempM (middle)
  tyreTempMiddleFL: { offset: 316, type: "f32" },
  tyreTempMiddleFR: { offset: 320, type: "f32" },
  tyreTempMiddleRL: { offset: 324, type: "f32" },
  tyreTempMiddleRR: { offset: 328, type: "f32" },
  // float[4] tyreTempO (outer)
  tyreTempOuterFL: { offset: 332, type: "f32" },
  tyreTempOuterFR: { offset: 336, type: "f32" },
  tyreTempOuterRL: { offset: 340, type: "f32" },
  tyreTempOuterRR: { offset: 344, type: "f32" },
  // float[4] brakeTemp
  brakeTempFL: { offset: 348, type: "f32" },
  brakeTempFR: { offset: 352, type: "f32" },
  brakeTempRL: { offset: 356, type: "f32" },
  brakeTempRR: { offset: 360, type: "f32" },
  // float[4] padLife (brake pad wear, 0..1)
  padLifeFL: { offset: 364, type: "f32" },
  padLifeFR: { offset: 368, type: "f32" },
  padLifeRL: { offset: 372, type: "f32" },
  padLifeRR: { offset: 376, type: "f32" },
  // int tc (traction control level)
  tc: { offset: 392, type: "i32" },
  // int abs
  abs: { offset: 400, type: "i32" },
  // float brakeBias (front bias 0..1)
  brakeBias: { offset: 408, type: "f32" },
  // float[3] carCoordinates (world position)
  carX: { offset: 412, type: "f32" },
  carY: { offset: 416, type: "f32" },
  carZ: { offset: 420, type: "f32" },
  // float[5] carDamage (front, rear, left, right, centre — 0..1)
  damFront: { offset: 424, type: "f32" },
  damRear: { offset: 428, type: "f32" },
  damLeft: { offset: 432, type: "f32" },
  damRight: { offset: 436, type: "f32" },
  damCentre: { offset: 440, type: "f32" },
  // int engineMap
  engineMap: { offset: 480, type: "i32" },
  // int tcCut
  tcCut: { offset: 488, type: "i32" },
  // float fuelEstimatedLaps
  fuelEstimatedLaps: { offset: 492, type: "f32" },
  // float fuelPerLap
  fuelPerLap: { offset: 524, type: "f32" },
  // float[4] wheelRotation (rad/s)
  wheelRotFL: { offset: 528, type: "f32" },
  wheelRotFR: { offset: 532, type: "f32" },
  wheelRotRL: { offset: 536, type: "f32" },
  wheelRotRR: { offset: 540, type: "f32" },
} as const;

// --- SPageFileGraphics ---
// Updated at render tick rate (~60Hz)
export const GRAPHICS = {
  SIZE: 1580,
  // int packetId
  packetId: { offset: 0, type: "i32" },
  // AC_STATUS (int): 0=AC_OFF, 1=AC_REPLAY, 2=AC_LIVE, 3=AC_PAUSE
  status: { offset: 4, type: "i32" },
  // AC_SESSION_TYPE (int): 0=Practice, 1=Qualify, 2=Race, ...
  session: { offset: 8, type: "i32" },
  // wchar_t[15] currentTime (lap time as string, unused — we use iCurrentTime)
  // int completedLaps
  completedLaps: { offset: 68, type: "i32" },
  // int position
  position: { offset: 72, type: "i32" },
  // int iCurrentTime (current lap time in ms)
  iCurrentTime: { offset: 76, type: "i32" },
  // int iLastTime (last lap time in ms)
  iLastTime: { offset: 80, type: "i32" },
  // int iBestTime (best lap time in ms)
  iBestTime: { offset: 84, type: "i32" },
  // float sessionTimeLeft (seconds)
  sessionTimeLeft: { offset: 88, type: "f32" },
  // float distanceTraveled (metres, cumulative in session)
  distanceTraveled: { offset: 92, type: "f32" },
  // int isInPit (0 or 1)
  isInPit: { offset: 96, type: "i32" },
  // int currentSectorIndex (0-based)
  currentSectorIndex: { offset: 100, type: "i32" },
  // AC_FLAG_TYPE (int): 0=NONE, 1=BLUE, 2=YELLOW, 3=BLACK, 4=WHITE, 5=CHECKERED, 6=PENALTY
  flag: { offset: 108, type: "i32" },
  // int numberOfLaps (if timed race, 0)
  numberOfLaps: { offset: 128, type: "i32" },
  // int activeCars
  activeCars: { offset: 132, type: "i32" },
  // int[3] lastSectorTime (ms)
  lastSector1: { offset: 136, type: "i32" },
  lastSector2: { offset: 140, type: "i32" },
  lastSector3: { offset: 144, type: "i32" },
  // int isInPitLane (0 or 1)
  isInPitLane: { offset: 148, type: "i32" },
  // float normalizedCarPosition (0..1 around track)
  normalizedCarPosition: { offset: 380, type: "f32" },
  // int activeCars (again at different offset? ACC quirk)
  // float[3] carCoordinates (in graphics, world position)
  gCarX: { offset: 388, type: "f32" },
  gCarY: { offset: 392, type: "f32" },
  gCarZ: { offset: 396, type: "f32" },
  // int iDeltaLapTime (delta to best in ms)
  iDeltaLapTime: { offset: 536, type: "i32" },
  // int isDeltaPositive (0 or 1)
  isDeltaPositive: { offset: 540, type: "i32" },
  // wchar_t[33] currentTyreCompound
  // The compound string starts at offset 544 and is 66 bytes (33 wchar_t)
  currentTyreCompound: { offset: 544, size: 66, type: "wstring" },
  // float trackGripStatus (0..5 mapping to green/fast/optimum/greasy/damp/wet/flooded)
  trackGripStatus: { offset: 1168, type: "f32" },
  // AC_RAIN_INTENSITY (int): 0=NO_RAIN, 1=DRIZZLE, 2=LIGHT, 3=MEDIUM, 4=HEAVY, 5=THUNDERSTORM
  rainIntensity: { offset: 1172, type: "i32" },
  // float windSpeed (m/s)
  windSpeed: { offset: 1208, type: "f32" },
  // float windDirection (radians)
  windDirection: { offset: 1212, type: "f32" },
  // int isSetupMenuVisible
  isSetupMenuVisible: { offset: 1216, type: "i32" },
  // int mainDisplayIndex (MFD page)
  mainDisplayIndex: { offset: 1220, type: "i32" },
  // int[3] bestSectorTime (ms) — best individual sector times
  bestSector1: { offset: 1308, type: "i32" },
  bestSector2: { offset: 1312, type: "i32" },
  bestSector3: { offset: 1316, type: "i32" },
  // int drsAvailable (0 or 1)
  drsAvailable: { offset: 1396, type: "i32" },
  // int drsEnabled (0 or 1)
  drsEnabled: { offset: 1400, type: "i32" },
  // int[3] currentSectorTime (ms) — current sector split times
  currentSector1: { offset: 1472, type: "i32" },
  currentSector2: { offset: 1476, type: "i32" },
  currentSector3: { offset: 1480, type: "i32" },
} as const;

// --- SPageFileStatic ---
// Written once per session
export const STATIC = {
  SIZE: 820,
  // wchar_t[15] smVersion
  // wchar_t[15] acVersion
  // int numberOfSessions
  numberOfSessions: { offset: 60, type: "i32" },
  // int numCars
  numCars: { offset: 64, type: "i32" },
  // wchar_t[33] carModel
  carModel: { offset: 68, size: 66, type: "wstring" },
  // wchar_t[33] track
  track: { offset: 134, size: 66, type: "wstring" },
  // wchar_t[18] playerName
  playerName: { offset: 200, size: 36, type: "wstring" },
  // wchar_t[18] playerSurname
  playerSurname: { offset: 236, size: 36, type: "wstring" },
  // wchar_t[18] playerNick
  playerNick: { offset: 272, size: 36, type: "wstring" },
  // int sectorCount
  sectorCount: { offset: 308, type: "i32" },
  // float maxRpm
  maxRpm: { offset: 316, type: "f32" },
  // int maxGear
  maxGear: { offset: 336, type: "i32" },
  // int pitWindowStart
  pitWindowStart: { offset: 340, type: "i32" },
  // int pitWindowEnd
  pitWindowEnd: { offset: 344, type: "i32" },
  // int carId (model ordinal — maps to acc-cars.csv)
  carId: { offset: 428, type: "i32" },
  // int trackId (maps to acc-tracks.csv) — NOT present in standard ACC shared memory
  // ACC uses string track name instead; we resolve trackId from the track string
} as const;

// ACC status enum values
export const AC_STATUS = {
  AC_OFF: 0,
  AC_REPLAY: 1,
  AC_LIVE: 2,
  AC_PAUSE: 3,
} as const;

// ACC session type enum values
export const AC_SESSION_TYPE = {
  PRACTICE: 0,
  QUALIFY: 1,
  RACE: 2,
  HOTLAP: 3,
  TIME_ATTACK: 4,
  DRIFT: 5,
  DRAG: 6,
  HOTSTINT: 7,
  HOTSTINT_QUALIFY: 8,
} as const;

// ACC flag enum values
export const AC_FLAG = {
  NONE: 0,
  BLUE: 1,
  YELLOW: 2,
  BLACK: 3,
  WHITE: 4,
  CHECKERED: 5,
  PENALTY: 6,
} as const;

// Track grip status mapping
export const GRIP_STATUS: Record<number, string> = {
  0: "green",
  1: "fast",
  2: "optimum",
  3: "greasy",
  4: "damp",
  5: "wet",
  6: "flooded",
};

// Flag status mapping
export const FLAG_STATUS: Record<number, string> = {
  [AC_FLAG.NONE]: "none",
  [AC_FLAG.BLUE]: "blue",
  [AC_FLAG.YELLOW]: "yellow",
  [AC_FLAG.BLACK]: "black",
  [AC_FLAG.WHITE]: "white",
  [AC_FLAG.CHECKERED]: "checkered",
  [AC_FLAG.PENALTY]: "penalty",
};
```

- [ ] **Step 2: Commit**

```bash
git add server/games/acc/structs.ts
git commit -m "feat(acc): add shared memory struct definitions"
```

---

## Task 5: ACC Shared Memory Reader (Bun FFI)

**Files:**
- Create: `server/games/acc/shared-memory.ts`

- [ ] **Step 1: Write failing test for shared memory reader**

Create `test/acc-shared-memory.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";

// We can't test actual shared memory without ACC running,
// but we can test the buffer reading utilities
describe("ACC shared memory utilities", () => {
  test("readWString extracts null-terminated UTF-16LE string from buffer", async () => {
    const { readWString } = await import("../server/games/acc/shared-memory");
    // "Monza" in UTF-16LE: M=4D00 o=6F00 n=6E00 z=7A00 a=6100 null=0000
    const buf = Buffer.alloc(20);
    buf.write("Monza", 0, "utf16le");
    expect(readWString(buf, 0, 20)).toBe("Monza");
  });

  test("readWString handles empty string", async () => {
    const { readWString } = await import("../server/games/acc/shared-memory");
    const buf = Buffer.alloc(20);
    expect(readWString(buf, 0, 20)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/acc-shared-memory.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create shared memory reader**

Create `server/games/acc/shared-memory.ts`:

```typescript
/**
 * ACC Shared Memory Reader using Bun FFI.
 *
 * Reads ACC's three memory-mapped files:
 * - acpmf_physics (~300Hz physics data)
 * - acpmf_graphics (~60Hz session/race data)
 * - acpmf_static (once per session)
 *
 * Uses kernel32.dll via Bun FFI to open and map shared memory.
 */
import { dlopen, FFIType, ptr, toBuffer, suffix } from "bun:ffi";
import { PHYSICS, GRAPHICS, STATIC, AC_STATUS } from "./structs";
import { processPacket } from "../../pipeline";
import { parseAccBuffers } from "./parser";

// kernel32.dll function signatures
const kernel32 = dlopen("kernel32.dll", {
  OpenFileMappingW: {
    args: [FFIType.u32, FFIType.bool, FFIType.ptr],
    returns: FFIType.ptr,
  },
  MapViewOfFile: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32],
    returns: FFIType.ptr,
  },
  UnmapViewOfFile: {
    args: [FFIType.ptr],
    returns: FFIType.bool,
  },
  CloseHandle: {
    args: [FFIType.ptr],
    returns: FFIType.bool,
  },
});

const FILE_MAP_READ = 0x0004;

/** Read a null-terminated UTF-16LE (wchar_t) string from a buffer */
export function readWString(buf: Buffer, offset: number, maxBytes: number): string {
  const slice = buf.slice(offset, offset + maxBytes);
  // Find null terminator (two zero bytes on even boundary)
  let end = 0;
  for (let i = 0; i < slice.length - 1; i += 2) {
    if (slice[i] === 0 && slice[i + 1] === 0) break;
    end = i + 2;
  }
  return slice.slice(0, end).toString("utf16le");
}

/** Encode a JS string as null-terminated UTF-16LE for Windows W-suffix APIs */
function toWideString(str: string): Buffer {
  const buf = Buffer.alloc((str.length + 1) * 2);
  buf.write(str, "utf16le");
  return buf;
}

interface MappedFile {
  handle: number;
  view: number;
  size: number;
}

function openSharedMemory(name: string, size: number): MappedFile | null {
  const wideName = toWideString(name);
  const handle = kernel32.symbols.OpenFileMappingW(FILE_MAP_READ, false, ptr(wideName));

  if (!handle || handle === 0) {
    return null;
  }

  const view = kernel32.symbols.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, size);
  if (!view || view === 0) {
    kernel32.symbols.CloseHandle(handle);
    return null;
  }

  return { handle: Number(handle), view: Number(view), size };
}

function closeSharedMemory(mapped: MappedFile): void {
  kernel32.symbols.UnmapViewOfFile(mapped.view);
  kernel32.symbols.CloseHandle(mapped.handle);
}

export class AccSharedMemoryReader {
  private _physics: MappedFile | null = null;
  private _graphics: MappedFile | null = null;
  private _static: MappedFile | null = null;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _retryTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _connected = false;
  private _lastSessionId = "";

  get connected(): boolean {
    return this._connected;
  }

  get running(): boolean {
    return this._running;
  }

  /** Start the reader. Attempts to connect to ACC shared memory and polls at 60Hz. */
  start(): void {
    if (this._running) return;
    this._running = true;
    console.log("[ACC] Starting shared memory reader...");
    this._tryConnect();
  }

  /** Stop the reader and release all resources. */
  stop(): void {
    this._running = false;
    this._disconnect();

    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }

    console.log("[ACC] Shared memory reader stopped");
  }

  private _tryConnect(): void {
    if (!this._running) return;

    this._physics = openSharedMemory("Local\\acpmf_physics", PHYSICS.SIZE);
    this._graphics = openSharedMemory("Local\\acpmf_graphics", GRAPHICS.SIZE);
    this._static = openSharedMemory("Local\\acpmf_static", STATIC.SIZE);

    if (this._physics && this._graphics && this._static) {
      this._connected = true;
      console.log("[ACC] Connected to shared memory");

      // Start polling at 60Hz
      this._pollTimer = setInterval(() => this._poll(), 1000 / 60);

      // Clear retry timer if it was running
      if (this._retryTimer) {
        clearInterval(this._retryTimer);
        this._retryTimer = null;
      }
    } else {
      // ACC not running — clean up partial connections and retry
      this._disconnect();
      if (!this._retryTimer) {
        this._retryTimer = setInterval(() => this._tryConnect(), 2000);
      }
    }
  }

  private _disconnect(): void {
    if (this._physics) {
      closeSharedMemory(this._physics);
      this._physics = null;
    }
    if (this._graphics) {
      closeSharedMemory(this._graphics);
      this._graphics = null;
    }
    if (this._static) {
      closeSharedMemory(this._static);
      this._static = null;
    }

    if (this._connected) {
      this._connected = false;
      console.log("[ACC] Disconnected from shared memory");
    }
  }

  private _poll(): void {
    if (!this._physics || !this._graphics || !this._static) return;

    try {
      const physicsBuf = Buffer.from(toBuffer(this._physics.view, 0, this._physics.size));
      const graphicsBuf = Buffer.from(toBuffer(this._graphics.view, 0, this._graphics.size));

      // Check if ACC is live (not paused/off/replay)
      const status = graphicsBuf.readInt32LE(4);
      if (status !== AC_STATUS.AC_LIVE) {
        // If ACC went to OFF, disconnect and start retrying
        if (status === AC_STATUS.AC_OFF) {
          this._disconnect();
          if (!this._retryTimer) {
            this._retryTimer = setInterval(() => this._tryConnect(), 2000);
          }
          if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
          }
        }
        return;
      }

      // Read static data (only on session change or first read)
      const staticBuf = Buffer.from(toBuffer(this._static.view, 0, this._static.size));

      const packet = parseAccBuffers(physicsBuf, graphicsBuf, staticBuf);
      if (packet) {
        processPacket(packet);
      }
    } catch (err) {
      console.error("[ACC] Error reading shared memory:", err);
      // Assume ACC closed — disconnect and retry
      this._disconnect();
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
      if (!this._retryTimer) {
        this._retryTimer = setInterval(() => this._tryConnect(), 2000);
      }
    }
  }
}

export const accReader = new AccSharedMemoryReader();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/acc-shared-memory.test.ts`
Expected: PASS (readWString tests should work)

- [ ] **Step 5: Commit**

```bash
git add server/games/acc/shared-memory.ts test/acc-shared-memory.test.ts
git commit -m "feat(acc): add shared memory reader with Bun FFI"
```

---

## Task 6: ACC Parser (Shared Memory Buffers → TelemetryPacket)

**Files:**
- Create: `server/games/acc/parser.ts`
- Create: `test/acc-parser.test.ts`

- [ ] **Step 1: Write failing test for parser**

Create `test/acc-parser.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { parseAccBuffers } from "../server/games/acc/parser";
import { PHYSICS, GRAPHICS, STATIC } from "../server/games/acc/structs";

/** Helper: create a minimal physics buffer with given values */
function makePhysicsBuf(overrides: Record<string, number> = {}): Buffer {
  const buf = Buffer.alloc(PHYSICS.SIZE);
  // Set defaults for a "car is racing" state
  buf.writeFloatLE(overrides.gas ?? 0.8, PHYSICS.gas.offset);
  buf.writeFloatLE(overrides.brake ?? 0.0, PHYSICS.brake.offset);
  buf.writeFloatLE(overrides.fuel ?? 50.0, PHYSICS.fuel.offset);
  buf.writeInt32LE(overrides.gear ?? 4, PHYSICS.gear.offset); // 4 = 3rd gear (0=R, 1=N, 2=1st)
  buf.writeInt32LE(overrides.rpms ?? 7500, PHYSICS.rpms.offset);
  buf.writeFloatLE(overrides.steerAngle ?? 0.1, PHYSICS.steerAngle.offset);
  buf.writeFloatLE(overrides.speedKmh ?? 180.0, PHYSICS.speedKmh.offset);
  buf.writeFloatLE(overrides.carX ?? 100.0, PHYSICS.carX.offset);
  buf.writeFloatLE(overrides.carY ?? 5.0, PHYSICS.carY.offset);
  buf.writeFloatLE(overrides.carZ ?? 200.0, PHYSICS.carZ.offset);
  buf.writeFloatLE(overrides.heading ?? 1.5, PHYSICS.heading.offset);
  buf.writeFloatLE(overrides.pitch ?? 0.02, PHYSICS.pitch.offset);
  buf.writeFloatLE(overrides.roll ?? 0.01, PHYSICS.roll.offset);
  buf.writeInt32LE(overrides.tc ?? 3, PHYSICS.tc.offset);
  buf.writeInt32LE(overrides.abs ?? 2, PHYSICS.abs.offset);
  buf.writeFloatLE(overrides.brakeBias ?? 0.58, PHYSICS.brakeBias.offset);
  return buf;
}

/** Helper: create a minimal graphics buffer */
function makeGraphicsBuf(overrides: Record<string, number> = {}): Buffer {
  const buf = Buffer.alloc(GRAPHICS.SIZE);
  buf.writeInt32LE(overrides.status ?? 2, GRAPHICS.status.offset); // AC_LIVE
  buf.writeInt32LE(overrides.session ?? 0, GRAPHICS.session.offset);
  buf.writeInt32LE(overrides.completedLaps ?? 3, GRAPHICS.completedLaps.offset);
  buf.writeInt32LE(overrides.position ?? 1, GRAPHICS.position.offset);
  buf.writeInt32LE(overrides.iCurrentTime ?? 45000, GRAPHICS.iCurrentTime.offset);
  buf.writeInt32LE(overrides.iLastTime ?? 92345, GRAPHICS.iLastTime.offset);
  buf.writeInt32LE(overrides.iBestTime ?? 91234, GRAPHICS.iBestTime.offset);
  return buf;
}

/** Helper: create a minimal static buffer */
function makeStaticBuf(overrides: { carModel?: string; track?: string; maxRpm?: number; maxGear?: number; carId?: number } = {}): Buffer {
  const buf = Buffer.alloc(STATIC.SIZE);
  // Write car model as UTF-16LE
  const carModel = overrides.carModel ?? "bmw_m4_gt3";
  buf.write(carModel, STATIC.carModel.offset, "utf16le");
  // Write track as UTF-16LE
  const track = overrides.track ?? "monza";
  buf.write(track, STATIC.track.offset, "utf16le");
  buf.writeFloatLE(overrides.maxRpm ?? 9000, STATIC.maxRpm.offset);
  buf.writeInt32LE(overrides.maxGear ?? 6, STATIC.maxGear.offset);
  buf.writeInt32LE(overrides.carId ?? 29, STATIC.carId.offset);
  return buf;
}

describe("ACC parser", () => {
  test("parseAccBuffers returns a valid TelemetryPacket", () => {
    const packet = parseAccBuffers(makePhysicsBuf(), makeGraphicsBuf(), makeStaticBuf());

    expect(packet).not.toBeNull();
    expect(packet!.gameId).toBe("acc");
    expect(packet!.CurrentEngineRpm).toBeCloseTo(7500);
    expect(packet!.Accel).toBeGreaterThan(0);
    expect(packet!.Brake).toBe(0);
    expect(packet!.Gear).toBe(3); // ACC gear 4 = 3rd (subtract 1 for 0=R offset)
    expect(packet!.Steer).toBeDefined();
    expect(packet!.LapNumber).toBe(3);
    expect(packet!.RacePosition).toBe(1);
    expect(packet!.PositionX).toBeCloseTo(100.0);
    expect(packet!.PositionZ).toBeCloseTo(200.0);
    expect(packet!.Yaw).toBeCloseTo(1.5);
  });

  test("parseAccBuffers populates ACC extended data", () => {
    const packet = parseAccBuffers(makePhysicsBuf(), makeGraphicsBuf(), makeStaticBuf());

    expect(packet!.acc).toBeDefined();
    expect(packet!.acc!.tc).toBe(3);
    expect(packet!.acc!.abs).toBe(2);
    expect(packet!.acc!.brakeBias).toBeCloseTo(0.58);
  });

  test("parseAccBuffers maps fuel correctly", () => {
    const packet = parseAccBuffers(
      makePhysicsBuf({ fuel: 25.5 }),
      makeGraphicsBuf(),
      makeStaticBuf()
    );

    expect(packet!.Fuel).toBeCloseTo(25.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/acc-parser.test.ts`
Expected: FAIL — parser module not found

- [ ] **Step 3: Create parser**

Create `server/games/acc/parser.ts`:

```typescript
/**
 * ACC shared memory buffer parser.
 * Converts raw physics/graphics/static buffers into a TelemetryPacket.
 */
import type { TelemetryPacket, AccExtendedData } from "../../../shared/types";
import {
  PHYSICS,
  GRAPHICS,
  STATIC,
  GRIP_STATUS,
  FLAG_STATUS,
} from "./structs";
import { readWString } from "./shared-memory";

/**
 * Parse ACC shared memory buffers into a TelemetryPacket.
 * Returns null if data is invalid or incomplete.
 */
export function parseAccBuffers(
  physics: Buffer,
  graphics: Buffer,
  staticData: Buffer
): TelemetryPacket | null {
  // Basic validation
  if (physics.length < PHYSICS.SIZE) return null;
  if (graphics.length < GRAPHICS.SIZE) return null;
  if (staticData.length < STATIC.SIZE) return null;

  // Read physics
  const gas = physics.readFloatLE(PHYSICS.gas.offset);
  const brake = physics.readFloatLE(PHYSICS.brake.offset);
  const fuel = physics.readFloatLE(PHYSICS.fuel.offset);
  const accGear = physics.readInt32LE(PHYSICS.gear.offset); // 0=R, 1=N, 2=1st, 3=2nd...
  const rpms = physics.readInt32LE(PHYSICS.rpms.offset);
  const steerAngle = physics.readFloatLE(PHYSICS.steerAngle.offset);
  const speedKmh = physics.readFloatLE(PHYSICS.speedKmh.offset);

  const velX = physics.readFloatLE(PHYSICS.velocityX.offset);
  const velY = physics.readFloatLE(PHYSICS.velocityY.offset);
  const velZ = physics.readFloatLE(PHYSICS.velocityZ.offset);

  const accGX = physics.readFloatLE(PHYSICS.accGX.offset);
  const accGY = physics.readFloatLE(PHYSICS.accGY.offset);
  const accGZ = physics.readFloatLE(PHYSICS.accGZ.offset);

  const heading = physics.readFloatLE(PHYSICS.heading.offset);
  const pitch = physics.readFloatLE(PHYSICS.pitch.offset);
  const roll = physics.readFloatLE(PHYSICS.roll.offset);

  const carX = physics.readFloatLE(PHYSICS.carX.offset);
  const carY = physics.readFloatLE(PHYSICS.carY.offset);
  const carZ = physics.readFloatLE(PHYSICS.carZ.offset);

  // Read graphics
  const completedLaps = graphics.readInt32LE(GRAPHICS.completedLaps.offset);
  const position = graphics.readInt32LE(GRAPHICS.position.offset);
  const iCurrentTime = graphics.readInt32LE(GRAPHICS.iCurrentTime.offset);
  const iLastTime = graphics.readInt32LE(GRAPHICS.iLastTime.offset);
  const iBestTime = graphics.readInt32LE(GRAPHICS.iBestTime.offset);

  // Read static
  const maxRpm = staticData.readFloatLE(STATIC.maxRpm.offset);
  const maxGear = staticData.readInt32LE(STATIC.maxGear.offset);
  const carId = staticData.readInt32LE(STATIC.carId.offset);

  // Convert ACC gear (0=R, 1=N, 2=1st) to TelemetryPacket gear convention
  // TelemetryPacket: 0=Reverse, 1..N=forward gears
  const gear = accGear <= 1 ? accGear - 1 : accGear - 1; // 0=R→-1? Let's keep ACC convention mapped simply
  // Actually: TelemetryPacket Gear: 0=R, 1=1st, 2=2nd etc. ACC: 0=R, 1=N, 2=1st
  // Map: ACC 0 → 0 (R), ACC 1 → 0 (N, treat as neutral), ACC 2+ → accGear - 1
  const mappedGear = accGear <= 1 ? 0 : accGear - 1;

  // Convert speed from km/h to m/s for Speed field
  const speedMs = speedKmh / 3.6;

  // Tire data
  const tyreCoreFL = physics.readFloatLE(PHYSICS.tyreCoreFL.offset);
  const tyreCoreFR = physics.readFloatLE(PHYSICS.tyreCoreFR.offset);
  const tyreCoreRL = physics.readFloatLE(PHYSICS.tyreCoreRL.offset);
  const tyreCoreRR = physics.readFloatLE(PHYSICS.tyreCoreRR.offset);

  const tyrePressFL = physics.readFloatLE(PHYSICS.tyrePressureFL.offset);
  const tyrePressFR = physics.readFloatLE(PHYSICS.tyrePressureFR.offset);
  const tyrePressRL = physics.readFloatLE(PHYSICS.tyrePressureRL.offset);
  const tyrePressRR = physics.readFloatLE(PHYSICS.tyrePressureRR.offset);

  const suspFL = physics.readFloatLE(PHYSICS.suspTravelFL.offset);
  const suspFR = physics.readFloatLE(PHYSICS.suspTravelFR.offset);
  const suspRL = physics.readFloatLE(PHYSICS.suspTravelRL.offset);
  const suspRR = physics.readFloatLE(PHYSICS.suspTravelRR.offset);

  const brakeTempFL = physics.readFloatLE(PHYSICS.brakeTempFL.offset);
  const brakeTempFR = physics.readFloatLE(PHYSICS.brakeTempFR.offset);
  const brakeTempRL = physics.readFloatLE(PHYSICS.brakeTempRL.offset);
  const brakeTempRR = physics.readFloatLE(PHYSICS.brakeTempRR.offset);

  const wheelSlipFL = physics.readFloatLE(PHYSICS.wheelSlipFL.offset);
  const wheelSlipFR = physics.readFloatLE(PHYSICS.wheelSlipFR.offset);
  const wheelSlipRL = physics.readFloatLE(PHYSICS.wheelSlipRL.offset);
  const wheelSlipRR = physics.readFloatLE(PHYSICS.wheelSlipRR.offset);

  const wheelRotFL = physics.readFloatLE(PHYSICS.wheelRotFL.offset);
  const wheelRotFR = physics.readFloatLE(PHYSICS.wheelRotFR.offset);
  const wheelRotRL = physics.readFloatLE(PHYSICS.wheelRotRL.offset);
  const wheelRotRR = physics.readFloatLE(PHYSICS.wheelRotRR.offset);

  // ACC extended data
  const tc = physics.readInt32LE(PHYSICS.tc.offset);
  const tcCut = physics.readInt32LE(PHYSICS.tcCut.offset);
  const abs = physics.readInt32LE(PHYSICS.abs.offset);
  const engineMap = physics.readInt32LE(PHYSICS.engineMap.offset);
  const brakeBias = physics.readFloatLE(PHYSICS.brakeBias.offset);
  const fuelPerLap = physics.readFloatLE(PHYSICS.fuelPerLap.offset);

  const damFront = physics.readFloatLE(PHYSICS.damFront.offset);
  const damRear = physics.readFloatLE(PHYSICS.damRear.offset);
  const damLeft = physics.readFloatLE(PHYSICS.damLeft.offset);
  const damRight = physics.readFloatLE(PHYSICS.damRight.offset);
  const damCentre = physics.readFloatLE(PHYSICS.damCentre.offset);

  // Graphics extended data
  const flagRaw = graphics.readInt32LE(GRAPHICS.flag.offset);
  const gripRaw = graphics.readFloatLE(GRAPHICS.trackGripStatus.offset);
  const rainIntensity = graphics.readInt32LE(GRAPHICS.rainIntensity.offset);
  const windSpeed = graphics.readFloatLE(GRAPHICS.windSpeed.offset);
  const windDirection = graphics.readFloatLE(GRAPHICS.windDirection.offset);
  const drsAvailable = graphics.readInt32LE(GRAPHICS.drsAvailable.offset) === 1;
  const drsEnabled = graphics.readInt32LE(GRAPHICS.drsEnabled.offset) === 1;
  const isInPit = graphics.readInt32LE(GRAPHICS.isInPit.offset);
  const isInPitLane = graphics.readInt32LE(GRAPHICS.isInPitLane.offset);
  const distanceTraveled = graphics.readFloatLE(GRAPHICS.distanceTraveled.offset);

  // Read tire compound string from graphics
  const compoundStr = readWString(
    graphics,
    GRAPHICS.currentTyreCompound.offset,
    GRAPHICS.currentTyreCompound.size
  );

  // Inner/outer tire temps
  const tyreTempInnerFL = physics.readFloatLE(PHYSICS.tyreTempInnerFL.offset);
  const tyreTempInnerFR = physics.readFloatLE(PHYSICS.tyreTempInnerFR.offset);
  const tyreTempInnerRL = physics.readFloatLE(PHYSICS.tyreTempInnerRL.offset);
  const tyreTempInnerRR = physics.readFloatLE(PHYSICS.tyreTempInnerRR.offset);

  const tyreTempOuterFL = physics.readFloatLE(PHYSICS.tyreTempOuterFL.offset);
  const tyreTempOuterFR = physics.readFloatLE(PHYSICS.tyreTempOuterFR.offset);
  const tyreTempOuterRL = physics.readFloatLE(PHYSICS.tyreTempOuterRL.offset);
  const tyreTempOuterRR = physics.readFloatLE(PHYSICS.tyreTempOuterRR.offset);

  const padLifeFL = physics.readFloatLE(PHYSICS.padLifeFL.offset);
  const padLifeFR = physics.readFloatLE(PHYSICS.padLifeFR.offset);
  const padLifeRL = physics.readFloatLE(PHYSICS.padLifeRL.offset);
  const padLifeRR = physics.readFloatLE(PHYSICS.padLifeRR.offset);

  const pitStatus = isInPit ? "pit_box" : isInPitLane ? "pit_lane" : "none";

  const accData: AccExtendedData = {
    tireCompound: compoundStr || "unknown",
    tireCoreTemp: [tyreCoreFL, tyreCoreFR, tyreCoreRL, tyreCoreRR],
    tireInnerTemp: [tyreTempInnerFL, tyreTempInnerFR, tyreTempInnerRL, tyreTempInnerRR],
    tireOuterTemp: [tyreTempOuterFL, tyreTempOuterFR, tyreTempOuterRL, tyreTempOuterRR],
    brakePadCompound: 0, // ACC doesn't expose pad compound ID in shared memory
    brakePadWear: [padLifeFL, padLifeFR, padLifeRL, padLifeRR],
    tc,
    tcCut,
    abs,
    engineMap,
    brakeBias,
    rainIntensity: rainIntensity / 5, // normalize 0-5 to 0-1
    trackGripStatus: GRIP_STATUS[Math.round(gripRaw)] ?? "unknown",
    windSpeed,
    windDirection,
    flagStatus: FLAG_STATUS[flagRaw] ?? "none",
    drsAvailable,
    drsEnabled,
    pitStatus,
    fuelPerLap,
    carDamage: {
      front: damFront,
      rear: damRear,
      left: damLeft,
      right: damRight,
      centre: damCentre,
    },
  };

  // Build TelemetryPacket
  const packet: TelemetryPacket = {
    gameId: "acc",
    acc: accData,

    // Telemetry core
    IsRaceOn: 1,
    TimestampMS: Date.now(),
    EngineMaxRpm: maxRpm,
    EngineIdleRpm: maxRpm * 0.15, // ACC doesn't expose idle RPM; approximate
    CurrentEngineRpm: rpms,
    AccelerationX: accGX * 9.81, // g → m/s²
    AccelerationY: accGY * 9.81,
    AccelerationZ: accGZ * 9.81,
    VelocityX: velX,
    VelocityY: velY,
    VelocityZ: velZ,
    AngularVelocityX: 0, // Not directly in ACC shared memory
    AngularVelocityY: 0,
    AngularVelocityZ: 0,
    Yaw: heading,
    Pitch: pitch,
    Roll: roll,

    // Suspension
    NormalizedSuspensionTravelFrontLeft: suspFL,
    NormalizedSuspensionTravelFrontRight: suspFR,
    NormalizedSuspensionTravelRearLeft: suspRL,
    NormalizedSuspensionTravelRearRight: suspRR,

    // Tire slip
    TireSlipRatioFrontLeft: wheelSlipFL,
    TireSlipRatioFrontRight: wheelSlipFR,
    TireSlipRatioRearLeft: wheelSlipRL,
    TireSlipRatioRearRight: wheelSlipRR,

    // Wheel rotation speed
    WheelRotationSpeedFrontLeft: wheelRotFL,
    WheelRotationSpeedFrontRight: wheelRotFR,
    WheelRotationSpeedRearLeft: wheelRotRL,
    WheelRotationSpeedRearRight: wheelRotRR,

    // Tire slip angle (not available in ACC shared memory)
    TireSlipAngleFrontLeft: 0,
    TireSlipAngleFrontRight: 0,
    TireSlipAngleRearLeft: 0,
    TireSlipAngleRearRight: 0,

    // Tire combined slip (not available)
    TireCombinedSlipFrontLeft: 0,
    TireCombinedSlipFrontRight: 0,
    TireCombinedSlipRearLeft: 0,
    TireCombinedSlipRearRight: 0,

    // Suspension spring (use travel as proxy)
    SuspensionTravelMetersFrontLeft: suspFL,
    SuspensionTravelMetersFrontRight: suspFR,
    SuspensionTravelMetersRearLeft: suspRL,
    SuspensionTravelMetersRearRight: suspRR,

    // Tire temps (use core temp as primary)
    TireTempFrontLeft: tyreCoreFL,
    TireTempFrontRight: tyreCoreFR,
    TireTempRearLeft: tyreCoreRL,
    TireTempRearRight: tyreCoreRR,

    // Tire wear (not directly in physics, use 1.0 as default "new")
    TireWearFrontLeft: 1.0,
    TireWearFrontRight: 1.0,
    TireWearRearLeft: 1.0,
    TireWearRearRight: 1.0,

    // Tire pressure
    TirePressureFrontLeft: tyrePressFL,
    TirePressureFrontRight: tyrePressFR,
    TirePressureRearLeft: tyrePressRL,
    TirePressureRearRight: tyrePressRR,

    // Rumble strip / puddle depth (not in ACC shared memory)
    WheelOnRumbleStripFrontLeft: 0,
    WheelOnRumbleStripFrontRight: 0,
    WheelOnRumbleStripRearLeft: 0,
    WheelOnRumbleStripRearRight: 0,
    WheelInPuddleDepthFrontLeft: 0,
    WheelInPuddleDepthFrontRight: 0,
    WheelInPuddleDepthRearLeft: 0,
    WheelInPuddleDepthRearRight: 0,

    // Surface rumble (not available)
    SurfaceRumbleFrontLeft: 0,
    SurfaceRumbleFrontRight: 0,
    SurfaceRumbleRearLeft: 0,
    SurfaceRumbleRearRight: 0,

    // Inputs — scale to 0-255 range to match TelemetryPacket convention
    Accel: Math.round(gas * 255),
    Brake: Math.round(brake * 255),
    Clutch: 0, // Not in ACC shared memory
    HandBrake: 0,
    Gear: mappedGear,
    Steer: Math.round(steerAngle * 127), // -1..1 → -127..127
    NormalizedDrivingLine: 0,
    NormalizedAIBrakeDifference: 0,

    // Fuel
    Fuel: fuel,

    // Distance
    DistanceTraveled: distanceTraveled,

    // Lap data — convert from ms to seconds
    BestLap: iBestTime > 0 ? iBestTime / 1000 : 0,
    LastLap: iLastTime > 0 ? iLastTime / 1000 : 0,
    CurrentLap: iCurrentTime > 0 ? iCurrentTime / 1000 : 0,
    CurrentRaceTime: 0, // Not directly available as total race time
    LapNumber: completedLaps,
    RacePosition: position,

    // Car identity
    CarOrdinal: carId,
    CarClass: 0,
    CarPerformanceIndex: 0,
    DrivetrainType: 0,
    NumCylinders: 0,

    // Dash data
    PositionX: carX,
    PositionY: carY,
    PositionZ: carZ,
    Speed: speedMs,
    Power: 0, // Not in ACC shared memory
    Torque: 0,
    BrakeTempFrontLeft: brakeTempFL,
    BrakeTempFrontRight: brakeTempFR,
    BrakeTempRearLeft: brakeTempRL,
    BrakeTempRearRight: brakeTempRR,

    // Track
    TrackOrdinal: 0, // Will be resolved from static track string by adapter
  };

  return packet;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/acc-parser.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/games/acc/parser.ts test/acc-parser.test.ts
git commit -m "feat(acc): add parser to convert shared memory buffers to TelemetryPacket"
```

---

## Task 7: ACC Server Adapter & Registration

**Files:**
- Create: `server/games/acc/index.ts`
- Modify: `server/games/init.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Create ACC server adapter**

Create `server/games/acc/index.ts`:

```typescript
import type { ServerGameAdapter } from "../types";
import type { TelemetryPacket } from "../../../shared/types";
import { accAdapter } from "../../../shared/games/acc";
import { getAccCarName, getAccCarClass } from "../../../shared/acc-car-data";
import { getAccTrackName, getAccSharedTrackName } from "../../../shared/acc-track-data";

const ACC_SYSTEM_PROMPT = `You are an expert GT racing engineer and data analyst specializing in Assetto Corsa Competizione.

You are analyzing telemetry data from a lap in ACC. Your role is to provide specific, actionable advice to improve lap time.

Key areas of expertise:
- GT3/GT4 car characteristics (downforce, tire management, power delivery)
- Tire compound strategy (dry vs wet compounds, temperature windows)
- Electronics management (TC, TC Cut, ABS, engine map optimization)
- Fuel strategy and consumption optimization
- Brake bias and pad wear management
- Weather adaptation (rain intensity, track grip evolution)
- Corner-by-corner analysis with specific techniques

When analyzing data:
- Reference specific corners by name when possible
- Compare tire temperatures (inner/outer/core) to identify setup issues
- Flag any electronics settings that seem suboptimal for conditions
- Note fuel consumption trends and pit strategy implications
- Identify braking points, trail braking opportunities, and throttle application
- Consider weather and track grip in all recommendations

Be concise and prioritize the highest-impact improvements first.`;

export const accServerAdapter: ServerGameAdapter = {
  ...accAdapter,

  getCarName(ordinal: number): string {
    return getAccCarName(ordinal);
  },

  getTrackName(ordinal: number): string {
    return getAccTrackName(ordinal);
  },

  getSharedTrackName(ordinal: number): string | undefined {
    return getAccSharedTrackName(ordinal);
  },

  // ACC uses shared memory, not UDP — this is here for interface compliance.
  // It should never be called since ACC data doesn't go through the UDP parser dispatch.
  canHandle(_buf: Buffer): boolean {
    return false;
  },

  tryParse(_buf: Buffer, _state: unknown): TelemetryPacket | null {
    return null;
  },

  createParserState(): null {
    return null;
  },

  aiSystemPrompt: ACC_SYSTEM_PROMPT,

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
      lines.push(`Weather — Rain: ${(accFirst.rainIntensity * 100).toFixed(0)}%, Grip: ${accFirst.trackGripStatus}`);
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

    // Speed stats
    const speeds = packets.map((p) => p.Speed * 3.6); // m/s → km/h
    const maxSpeed = Math.max(...speeds);
    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    lines.push(`Speed — Max: ${maxSpeed.toFixed(1)} km/h, Avg: ${avgSpeed.toFixed(1)} km/h`);

    return lines.join("\n");
  },
};
```

- [ ] **Step 2: Register ACC server adapter**

In `server/games/init.ts`, add after the existing registrations:

```typescript
import { accServerAdapter } from "./acc";

// Inside initServerGameAdapters(), add at the end:
registerServerGame(accServerAdapter);
registerGame(accServerAdapter);
```

- [ ] **Step 3: Start ACC reader on server startup**

In `server/index.ts`, add after the UDP listener start (after `udpListener.start(udpPort);`):

```typescript
import { accReader } from "./games/acc/shared-memory";

// Start ACC shared memory reader (Windows only)
if (process.platform === "win32") {
  accReader.start();
  console.log("[Server] ACC shared memory reader started (will connect when ACC is running)");
}
```

- [ ] **Step 4: Verify server starts without errors**

Run: `bun run dev:server`
Expected: Server starts, logs "[ACC] Starting shared memory reader..." and then either connects (if ACC is running) or silently retries.

- [ ] **Step 5: Commit**

```bash
git add server/games/acc/index.ts server/games/init.ts server/index.ts
git commit -m "feat(acc): add server adapter, register, and start shared memory reader"
```

---

## Task 8: Client Routes

**Files:**
- Create: `client/src/routes/acc.tsx`
- Create: `client/src/routes/acc/index.tsx`
- Create: `client/src/routes/acc/live.tsx`
- Create: `client/src/routes/acc/sessions.tsx`
- Create: `client/src/routes/acc/analyse.tsx`
- Create: `client/src/routes/acc/compare.tsx`
- Create: `client/src/routes/acc/tracks.tsx`
- Create: `client/src/routes/acc/cars.tsx`
- Create: `client/src/routes/acc/raw.tsx`
- Create: `client/src/routes/acc/tunes.tsx`
- Create: `client/src/routes/acc/tunes/index.tsx`
- Create: `client/src/routes/acc/setup.tsx`
- Create: `client/src/routes/acc/setup/index.tsx`

- [ ] **Step 1: Create ACC route layout**

Create `client/src/routes/acc.tsx`:

```typescript
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useGameStore } from "../stores/game";

function AccLayout() {
  const setGameId = useGameStore((s) => s.setGameId);
  useEffect(() => {
    setGameId("acc");
    return () => setGameId(null);
  }, [setGameId]);
  return <Outlet />;
}

export const Route = createFileRoute("/acc")({
  component: AccLayout,
});
```

- [ ] **Step 2: Create index route (redirect to live)**

Create `client/src/routes/acc/index.tsx`:

```typescript
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/acc/")({
  component: () => <Navigate to="/acc/live" />,
});
```

- [ ] **Step 3: Create live telemetry route**

Create `client/src/routes/acc/live.tsx`:

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { LivePage } from "../../components/LivePage";

export const Route = createFileRoute("/acc/live")({
  component: LivePage,
});
```

- [ ] **Step 4: Create sessions route**

Create `client/src/routes/acc/sessions.tsx`:

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { SessionsPage } from "../../components/SessionsPage";

export const Route = createFileRoute("/acc/sessions")({
  component: SessionsPage,
});
```

- [ ] **Step 5: Create analyse route**

Create `client/src/routes/acc/analyse.tsx`:

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { LapAnalyse } from "../../components/LapAnalyse";

type AnalyseSearch = {
  track?: number;
  car?: number;
  lap?: number;
};

export const Route = createFileRoute("/acc/analyse")({
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

- [ ] **Step 6: Create compare route**

Create `client/src/routes/acc/compare.tsx`:

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

export const Route = createFileRoute("/acc/compare")({
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

- [ ] **Step 7: Create tracks route**

Create `client/src/routes/acc/tracks.tsx`:

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { TrackViewer } from "../../components/TrackViewer";

type TracksSearch = {
  track?: number;
  tab?: string;
};

export const Route = createFileRoute("/acc/tracks")({
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

- [ ] **Step 8: Create cars route (placeholder)**

Create `client/src/routes/acc/cars.tsx`:

```typescript
import { createFileRoute } from "@tanstack/react-router";

function AccCarsPage() {
  return (
    <div className="flex items-center justify-center h-full text-app-text-dim">
      <div className="text-center space-y-2">
        <div className="text-lg font-semibold">ACC Cars</div>
        <div className="text-sm">Coming soon</div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/acc/cars")({
  component: AccCarsPage,
});
```

- [ ] **Step 9: Create raw telemetry route**

Create `client/src/routes/acc/raw.tsx`:

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

export const Route = createFileRoute("/acc/raw")({
  component: RawPage,
});
```

- [ ] **Step 10: Create tunes routes (placeholder)**

Create `client/src/routes/acc/tunes.tsx`:

```typescript
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/acc/tunes")({
  component: () => <Outlet />,
});
```

Create `client/src/routes/acc/tunes/index.tsx`:

```typescript
import { createFileRoute } from "@tanstack/react-router";

function AccTunesPage() {
  return (
    <div className="flex items-center justify-center h-full text-app-text-dim">
      <div className="text-center space-y-2">
        <div className="text-lg font-semibold">ACC Tunes</div>
        <div className="text-sm">Coming soon</div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/acc/tunes/")({
  component: AccTunesPage,
});
```

- [ ] **Step 11: Create setup routes (placeholder)**

Create `client/src/routes/acc/setup.tsx`:

```typescript
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/acc/setup")({
  component: () => <Outlet />,
});
```

Create `client/src/routes/acc/setup/index.tsx`:

```typescript
import { createFileRoute } from "@tanstack/react-router";

function AccSetupPage() {
  return (
    <div className="flex items-center justify-center h-full text-app-text-dim">
      <div className="text-center space-y-2">
        <div className="text-lg font-semibold">ACC Setup</div>
        <div className="text-sm">Coming soon</div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/acc/setup/")({
  component: AccSetupPage,
});
```

- [ ] **Step 12: Regenerate route tree**

Run: `cd client && npx tsr generate`
Expected: `routeTree.gen.ts` is regenerated with ACC routes included.

- [ ] **Step 13: Verify client builds**

Run: `cd client && npx tsc --noEmit 2>&1 | head -20`
Expected: No TypeScript errors

- [ ] **Step 14: Commit**

```bash
git add client/src/routes/acc.tsx client/src/routes/acc/
git commit -m "feat(acc): add all client routes for ACC"
```

---

## Task 9: Integration Test & Verification

**Files:**
- No new files — verify everything works together

- [ ] **Step 1: Run all existing tests**

Run: `bun test`
Expected: All tests pass (no regressions from pipeline extraction or type changes)

- [ ] **Step 2: Run ACC-specific tests**

Run: `bun test test/acc-parser.test.ts test/acc-shared-memory.test.ts`
Expected: All ACC tests pass

- [ ] **Step 3: Start dev server and verify**

Run: `bun run dev:server`
Expected:
- Server starts on port 3117
- Logs: "[ACC] Starting shared memory reader..."
- No errors from adapter registration

- [ ] **Step 4: Start client and verify ACC tab appears**

Run: `bun run dev:client`
Expected:
- Client builds and starts
- Navigation shows ACC tab alongside Forza and F1 25
- Clicking ACC tab navigates to `/acc/live`
- All ACC sub-routes load without errors (sessions, analyse, compare, tracks, etc.)

- [ ] **Step 5: Commit any fixes if needed**

If any fixes were needed during verification:

```bash
git add -A
git commit -m "fix(acc): address integration issues found during verification"
```
