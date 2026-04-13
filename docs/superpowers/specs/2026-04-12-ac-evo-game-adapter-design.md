# AC Evo Game Adapter Design

**Date:** 2026-04-12  
**Status:** Approved  
**Branch:** New feature branch

---

## Overview

Add Assetto Corsa Evo (AC Evo) as a supported game in RaceIQ, following the existing adapter registry pattern. AC Evo uses the same Windows shared memory format as ACC (`Local\acpmf_physics`, `Local\acpmf_graphics`, `Local\acpmf_static` with identical struct offsets), so most of the ACC infrastructure can be reused directly. The primary delta is a new car/track catalogue, a separate process checker, and wiring everything into the registry.

**Assumption:** AC Evo shared memory format is structurally identical to ACC v1.9. The struct offsets in `server/games/acc/structs.ts` are reused as-is. If offsets differ post-release, only `server/games/acc/structs.ts` needs patching (or a separate `server/games/ac-evo/structs.ts` created).

---

## Architecture

### Shared Memory Reuse

The ACC infrastructure (`BufferedAccMemoryReader`, `TripletAssembler`, `TripletPipeline`) is reused unchanged. The only modification to the ACC parser is adding an optional `gameId` field to `parseAccBuffers`'s `overrides` parameter (defaulting to `"acc"`), so AC Evo can produce packets with `gameId: "ac-evo"`.

`ParsingProcessor` in `triplet-pipeline.ts` gets an optional `gameId` constructor parameter (defaulting to `"acc"`) which it passes through to `parseAccBuffers`.

### New Files

```
shared/
  types.ts                          MODIFIED: add "ac-evo" to KNOWN_GAME_IDS
  games/
    ac-evo/
      index.ts                      NEW: GameAdapter (id, displayName, routePrefix, etc.)
    ac-evo/cars.csv                  NEW: AC Evo car catalogue (model → display name, class)
    ac-evo/tracks.csv                NEW: AC Evo track catalogue (id, name, variant, commonTrackName)
    init.ts                          MODIFIED: register acEvoAdapter
  ac-evo-car-data.ts                 NEW: CSV-backed car lookup (mirrors acc-car-data.ts)
  ac-evo-track-data.ts               NEW: CSV-backed track lookup (mirrors acc-track-data.ts)

server/
  games/
    acc/
      parser.ts                      MODIFIED: add gameId? to overrides
      triplet-pipeline.ts            MODIFIED: ParsingProcessor accepts gameId param
    ac-evo/
      index.ts                       NEW: ServerGameAdapter
      process-checker.ts             NEW: Watches for AssettoCorsa.exe
      shared-memory.ts               NEW: AcEvoSharedMemoryReader (wraps ACC infra)
    init.ts                          MODIFIED: register acEvoServerAdapter
  routes/
    ac-evo-routes.ts                 NEW: /api/ac-evo/cars + /api/ac-evo/debug/raw
  routes.ts                          MODIFIED: mount acEvoRoutes
  index.ts                           MODIFIED: create + start acEvoReader

client/src/routes/
  ac-evo.tsx                         NEW: layout route (setGameId "ac-evo")
  ac-evo/
    index.tsx                        NEW: HomePage
    live.tsx                         NEW: AccLiveDashboard with gameId="ac-evo"
    analyse.tsx                      NEW: LapAnalyse
    sessions.tsx                     NEW: SessionsPage
    compare.tsx                      NEW: LapComparison
    tracks.tsx                       NEW: TrackViewer
    cars.tsx                         NEW: AcEvoCars component
    raw.tsx                          NEW: RawTelemetry
    chats.tsx                        NEW: ChatsPage

client/src/components/acc/
  AccLiveDashboard.tsx               MODIFIED: accept optional gameId prop (default "acc")

client/src/components/ac-evo/
  AcEvoCars.tsx                      NEW: car catalogue page (/api/ac-evo/cars)
```

---

## Data

### Car Catalogue (`shared/games/ac-evo/cars.csv`)

Format: `id,model,name,class`

Road cars (id 0–49):
| id | model | name | class |
|----|-------|------|-------|
| 0 | ferrari_sf90_stradale | Ferrari SF90 Stradale | Road |
| 1 | ferrari_488_pista | Ferrari 488 Pista | Road |
| 2 | lamborghini_huracan_evo | Lamborghini Huracán EVO | Road |
| 3 | lamborghini_huracan_sto | Lamborghini Huracán STO | Road |
| 4 | bmw_m4_competition | BMW M4 Competition | Road |
| 5 | bmw_m4_csl | BMW M4 CSL | Road |
| 6 | alfa_romeo_giulia_gta | Alfa Romeo Giulia GTA | Road |
| 7 | abarth_695 | Abarth 695 | Road |
| 8 | lotus_emira_v6 | Lotus Emira V6 | Road |
| 9 | toyota_gr86 | Toyota GR86 | Road |
| 10 | porsche_911_gt3_rs | Porsche 911 GT3 RS | Road |
| 11 | lamborghini_revuelto | Lamborghini Revuelto | Road |

GT3 cars (id 50+):
| id | model | name | class |
|----|-------|------|-------|
| 50 | ferrari_296_gt3 | Ferrari 296 GT3 | GT3 |
| 51 | bmw_m4_gt3 | BMW M4 GT3 | GT3 |
| 52 | mclaren_720s_gt3_evo | McLaren 720S GT3 EVO | GT3 |
| 53 | porsche_992_gt3_r | Porsche 992 GT3 R | GT3 |
| 54 | lamborghini_huracan_gt3_evo2 | Lamborghini Huracán GT3 EVO2 | GT3 |
| 55 | mercedes_amg_gt3_2024 | Mercedes-AMG GT3 2024 | GT3 |
| 56 | audi_r8_lms_evo2 | Audi R8 LMS EVO II | GT3 |
| 57 | honda_nsx_gt3_evo | Honda NSX GT3 Evo | GT3 |

**Note:** AC Evo's shared memory reports `carModel` as a string (e.g., `"ferrari_296_gt3"`). Lookups use model string → display name via `getAcEvoCarNameByModel()`. The integer `id` column is for ordinal-based lookups from the packet's `CarOrdinal` field. If AC Evo uses a different model string format, the CSV `model` column needs updating — the lookup code does not need changing.

### Track Catalogue (`shared/games/ac-evo/tracks.csv`)

Format: `id,name,variant,commonTrackName`

`commonTrackName` maps to ACC track outline folders in `shared/track-outlines/acc/` so track maps render immediately without new track data.

| id | name | variant | commonTrackName |
|----|------|---------|-----------------|
| 0 | Monza | GP | monza |
| 1 | Nürburgring | GP | nurburgring |
| 2 | Brands Hatch | GP | brands-hatch |
| 3 | Mount Panorama | GP | mount-panorama |
| 4 | Misano | GP | misano |
| 5 | Spa-Francorchamps | GP | spa |
| 6 | Silverstone | GP | silverstone |
| 7 | Imola | GP | imola |
| 8 | Paul Ricard | GP | paul-ricard |
| 9 | Laguna Seca | GP | laguna-seca |

---

## Key Component Changes

### `server/games/acc/parser.ts`
Add `gameId?: GameId` to the overrides object:
```typescript
overrides?: { carOrdinal?: number; trackOrdinal?: number; gameId?: GameId }
// ...
gameId: overrides?.gameId ?? "acc",
```

### `server/games/acc/triplet-pipeline.ts` — `ParsingProcessor`
```typescript
constructor(carOrdinal: number, trackOrdinal: number, _accRecorder?: any, gameId: GameId = "acc")
// passed to parseAccBuffers: { carOrdinal, trackOrdinal, gameId }
```

### `server/games/ac-evo/process-checker.ts`
Mirrors `AccProcessChecker` but uses `isGameRunning("ac-evo")` and emits `"ac-evo-detected"` / `"ac-evo-lost"`.  
Process names for `"ac-evo"` adapter: `["AssettoCorsa.exe", "AC2.exe"]`.

### `server/games/ac-evo/shared-memory.ts`
`AcEvoSharedMemoryReader` — mirrors `AccSharedMemoryReader` exactly, but:
- Imports `acEvoProcessChecker` instead of `accProcessChecker`
- Passes `gameId: "ac-evo"` to `ParsingProcessor`
- No recording mode (omit recorder plumbing)

### `client/src/components/acc/AccLiveDashboard.tsx`
Add optional `gameId` prop (default `"acc"`). Replace the three hardcoded `"acc"` strings with the prop value.

### `client/src/components/ac-evo/AcEvoCars.tsx`
Thin clone of `AccCars.tsx` that queries `client.api["ac-evo"].cars.$get()`.

---

## Process Detection

AC Evo process names: `["AssettoCorsa.exe", "AC2.exe"]`  
These are added to the `acEvoServerAdapter.processNames` array. The registry's `isGameRunning("ac-evo")` polls these names every 2s via the process checker.

---

## Track Outlines

No new track outline data files are required. The `getSharedTrackName(ordinal)` call returns the `commonTrackName` from the AC Evo tracks CSV, which resolves to existing ACC track outline folders. If AC Evo adds tracks not in ACC, a new outline folder under `shared/track-outlines/acc/` (or a dedicated `shared/track-outlines/ac-evo/` directory) can be added independently.

---

## Server API Routes (`/api/ac-evo/`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ac-evo/cars` | Full car catalogue with class |
| GET | `/api/ac-evo/cars/:ordinal/class` | Class for a given ordinal |
| GET | `/api/ac-evo/debug/raw` | Raw shared memory dump (debug) |

No setup/recording routes in initial implementation (ACC-specific, not applicable to AC Evo yet).

---

## Navigation

AC Evo registers as `routePrefix: "ac-evo"`. TanStack Router file-based routing auto-discovers all files in `client/src/routes/ac-evo/`. Navigation tabs in the shell will render an "AC Evo" entry via the game store (same mechanism as ACC).

---

## Shared Memory Verification Note

The shared memory format assumption can be validated by running AC Evo and hitting `/api/ac-evo/debug/raw` in a browser. If offsets look wrong (NaN or clearly incorrect values), create a separate `server/games/ac-evo/structs.ts` with corrected offsets and import it in `shared-memory.ts` instead of the ACC structs.
