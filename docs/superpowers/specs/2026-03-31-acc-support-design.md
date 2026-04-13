# ACC (Assetto Corsa Competizione) Support Design

## Overview

Add Assetto Corsa Competizione as a supported game in RaceIQ, using Windows shared memory for telemetry input. Full feature parity with existing games: live telemetry, lap recording/history, lap comparison, track maps, AI analysis, and corner detection.

## Data Source: Windows Shared Memory

ACC exposes telemetry via three memory-mapped files (Windows shared memory API). This provides richer data than ACC's UDP broadcast — including tire compounds, brake pad wear, electronics settings (TC/ABS/engine map), weather data, DRS, and flag status.

### Memory-Mapped Files

| Name | Struct | Size (approx) | Update Rate | Contents |
|------|--------|---------------|-------------|----------|
| `Local\acpmf_physics` | `SPageFilePhysics` | ~720 bytes | ~300Hz (physics tick) | Speed, G-forces, tire temps/pressures, brake temps, fuel, steering/throttle/brake inputs, suspension travel, damage, TC/ABS values |
| `Local\acpmf_graphics` | `SPageFileGraphics` | ~1500 bytes | ~60Hz (render tick) | Lap/sector times, position, session type/status, flags, tire compound, rain/grip, pit status, DRS, gap data |
| `Local\acpmf_static` | `SPageFileStatic` | ~820 bytes | Once per session | Car model, track name, max RPM, gear count, player name |

### Why Shared Memory Over UDP

- Full tire data (compound, inner/outer/core temps per tire)
- Brake pad wear and compound
- Car damage detail
- TC/ABS/engine map settings
- Fuel consumption rate
- Weather data (rain, grip, wind)
- DRS/flag status
- Higher update frequency (~300Hz physics vs ~50Hz UDP)

## Architecture

### Adapter Pattern (follows existing game adapter system)

```
shared/games/acc/index.ts              -- GameAdapter implementation
server/games/acc/index.ts              -- ServerGameAdapter implementation
server/games/acc/shared-memory.ts      -- AccSharedMemoryReader (data source)
server/games/acc/parser.ts             -- Struct parsing (buffers -> TelemetryPacket)
```

### Shared Adapter (`shared/games/acc/index.ts`)

```typescript
GameAdapter {
  id: "acc"
  displayName: "Assetto Corsa Competizione"
  shortName: "ACC"
  routePrefix: "acc"
  coordSystem: "standard-xyz"     // Right-handed, Y-up, Z-forward
  steeringCenter: 0
  steeringRange: 1                // Normalized -1 to +1
  getCarName(ordinal)             // Static lookup from CSV
  getTrackName(ordinal)           // Static lookup from CSV
  getSharedTrackName(ordinal)     // Maps to track outline files
}
```

### Server Adapter (`server/games/acc/index.ts`)

```typescript
ServerGameAdapter {
  ...accAdapter,
  canHandle(buf)                  // For consistency; shared memory reader calls tryParse directly
  tryParse(buf, state)            // Parses combined physics+graphics+static buffers into TelemetryPacket
  createParserState()             // Returns AccSharedMemoryReader instance + session tracking
  aiSystemPrompt                  // ACC-specific (GT3/GT4, electronics, compound strategy, weather)
  buildAiContext(packets)         // Extracts ACC-relevant summary for AI analysis
}
```

### Shared Memory Reader (`server/games/acc/shared-memory.ts`)

Uses Bun FFI to call `kernel32.dll`:
- `OpenFileMappingW` -- open existing memory-mapped file by name
- `MapViewOfFile` -- get pointer to mapped memory
- `UnmapViewOfFile` / `CloseHandle` -- cleanup

**Polling behavior:**
- 60Hz timer reads physics + graphics structs
- Static struct read once per session (detected via session change in graphics)
- When ACC is not running: `OpenFileMappingW` returns null, reader goes idle, retries every 2 seconds
- When ACC exits mid-session: detect via `graphics.status === AC_OFF`, stop processing

### Parser (`server/games/acc/parser.ts`)

- Reads C struct fields at fixed byte offsets (same approach as Forza parser)
- Maps ACC fields to `TelemetryPacket` base fields + `acc: AccExtendedData`
- Handles ACC coordinate system mapping

### Pipeline Integration

**Refactor:** Extract `processPacket(packet: TelemetryPacket)` from `server/udp.ts` into `server/pipeline.ts`:
- Lap detection
- Track calibration
- WebSocket broadcast

Both `server/udp.ts` (for Forza/F1 UDP) and `AccSharedMemoryReader` call `processPacket()`.

Reader starts/stops via server lifecycle (init on server start, cleanup on shutdown).

## Shared Types

### `shared/types.ts` Changes

- Add `"acc"` to `KNOWN_GAME_IDS`
- Add `acc?: AccExtendedData` to `TelemetryPacket`

### `AccExtendedData` Fields

```typescript
interface AccExtendedData {
  // Tire detail
  tireCompound: string;                    // "dry_compound" | "wet_compound"
  tireCoreTemp: [number, number, number, number];
  tireInnerTemp: [number, number, number, number];
  tireOuterTemp: [number, number, number, number];

  // Brake detail
  brakePadCompound: number;
  brakePadWear: [number, number, number, number];

  // Electronics
  tc: number;                              // Traction control level
  tcCut: number;                           // TC cut level
  abs: number;                             // ABS level
  engineMap: number;                       // Engine map setting
  brakeBias: number;                       // Front brake bias %

  // Weather
  rainIntensity: number;                   // 0-1
  trackGripStatus: string;                 // "green" | "fast" | "optimum" | "greasy" | "damp" | "wet" | "flooded"
  windSpeed: number;
  windDirection: number;

  // Race state
  flagStatus: string;                      // "green" | "yellow" | "blue" | "black" | "checkered" | etc.
  drsAvailable: boolean;
  drsEnabled: boolean;
  pitStatus: string;                       // "none" | "pit_lane" | "pit_box"

  // Fuel
  fuelPerLap: number;                      // Estimated fuel per lap

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

## Registration

### `shared/games/init.ts`
```typescript
import { accAdapter } from "./acc";
registerGame(accAdapter);
```

### `server/games/init.ts`
```typescript
import { accServerAdapter } from "./acc";
registerServerGame(accServerAdapter);
registerGame(accServerAdapter);
```

## Data Files

- `shared/acc-cars.csv` -- Car model ID to name (100+ cars: GT3, GT4, GTC, TCX, etc.)
- `shared/acc-tracks.csv` -- Track ID to name (20+ circuits)
- `shared/acc-car-data.ts` -- Lookup functions from CSV
- `shared/acc-track-data.ts` -- Lookup functions from CSV
- `shared/track-outlines/acc/` -- Track geometry JSON files

## Client Routes

```
client/src/routes/acc.tsx              -- Layout, sets gameId="acc" in store
client/src/routes/acc/
  index.tsx                            -- Dashboard/home
  live.tsx                             -- Real-time telemetry
  sessions.tsx                         -- Session history
  analyse.tsx                          -- Single lap analysis with corners
  compare.tsx                          -- Side-by-side lap comparison
  cars.tsx                             -- Car database
  tracks.tsx                           -- Track database
  raw.tsx                              -- Raw telemetry viewer
  tunes.tsx                            -- Setup/tune management
  setup.tsx                            -- Setup profiles
```

All routes reuse existing components (`LiveTelemetry`, `LapComparison`, `TrackMap`, `LapAnalyse`, etc.) which work off `TelemetryPacket` and the game adapter registry.

**ACC-specific UI:** Live telemetry dashboard shows ACC-specific fields when available (tire compound, TC/ABS/engine map, weather, flags). AI analysis modal gets ACC-specific context.

**Navigation:** Root layout renders tabs from `getAllGames()` -- ACC appears automatically once registered.

## AI Analysis

### System Prompt
ACC-specific prompt covering:
- GT3/GT4/GTC car class characteristics
- Tire compound strategy (dry vs wet)
- Electronics management (TC, TC cut, ABS, engine map)
- Fuel strategy and consumption
- Weather adaptation and tire temp management
- Brake bias and pad wear considerations
- Track-specific advice

### `buildAiContext(packets)`
Extracts ACC-relevant summary:
- Average TC/ABS/engine map settings through the lap
- Tire temps by compound (inner/outer/core progression)
- Fuel consumption rate
- Weather conditions during lap
- Brake pad wear progression
- Car damage state

## Corner Detection

Works automatically via adapter config:
- `steeringCenter: 0`, `steeringRange: 1` (same as F1)
- Existing corner detection algorithm uses these values -- no ACC-specific changes needed

## Track Outlines

- Stored in `shared/track-outlines/acc/`
- JSON coordinate files generated from telemetry (drive a lap, extract X/Z positions)
- `getSharedTrackName()` maps ACC track identifiers to outline filenames
