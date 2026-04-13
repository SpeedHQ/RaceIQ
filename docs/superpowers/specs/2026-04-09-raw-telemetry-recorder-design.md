# Raw Telemetry Recorder — Design Spec

**Date:** 2026-04-09  
**Status:** Approved

## Overview

A standalone dev tool that records raw telemetry to disk without running the normal server pipeline. Used to capture real packet dumps for writing tests and developing parsers without doing more laps.

## Trigger

New npm script in `package.json`:

```bash
bun run dev:record <gameId>
```

Examples:
```bash
bun run dev:record f1-2025
bun run dev:record fm-2023
bun run dev:record acc
```

The game ID is a required positional argument. If missing or unknown, the process exits immediately with a clear error message. No env flags, no detection — the caller declares the game.

## Entry Point

`server/record.ts` — a completely standalone Bun entry. Does NOT import or start:
- HTTP server
- WebSocket manager
- Lap detector
- Pipeline (`processPacket`)
- Tray / auto-update / logger

It DOES import:
- `shared/games/init` + `server/games/init` — needed to register adapters for `canHandle` and parsing
- `server/settings` — to read the configured UDP port
- `server/db` — NOT imported (no database)

## Output Files

Each recording session creates a timestamped directory:

```
data/recordings/
  2026-04-09T14-32-11/
    meta.json
    dump.bin
```

### `meta.json`

Written atomically (write to `meta.tmp`, then `fs.renameSync` to `meta.json`) once track and car are resolved. Fields:

```json
{
  "gameId": "f1-2025",
  "trackOrdinal": 12,
  "trackName": "Bahrain International Circuit",
  "carOrdinal": 3,
  "carName": "McLaren MCL39",
  "startedAt": "2026-04-09T14:32:11.000Z"
}
```

`trackOrdinal`, `trackName`, `carOrdinal`, `carName` start as `null`. The first ~100 packets are fully parsed using the known game adapter; once `TrackOrdinal` and `CarOrdinal` are non-zero, meta is written and parsing stops.

If track/car are never resolved (e.g. recording stopped early), meta is still written on exit with whatever was found (`null` for unknown fields).

### `dump.bin`

Append-only binary file. Format differs by game:

**UDP games (f1-2025, fm-2023):**
```
[uint32 LE — byte length N][N bytes raw UDP payload]
```
Repeated for every packet received.

**ACC:**
```
[uint8 — frame type][uint32 LE — byte length N][N bytes raw struct data]
```
Frame types:
- `0x01` — physics frame (`acpmf_physics`)
- `0x02` — graphics frame (`acpmf_graphics`)
- `0x03` — static frame (`acpmf_static`)

The interleaved ordering is preserved so replay reproduces the exact runtime read sequence.

### Corruption safety

Append-only writes mean a hard kill (ctrl+C, process kill) can only truncate the last in-flight write. All prior records remain intact. A replayer detects truncation by reading the declared length and checking if enough bytes follow — if not, it stops there.

## UDP Recording (F1 / Forza)

Uses the same `dgram` socket setup as `udp.ts` (64MB receive buffer, `0.0.0.0` bind). Port read from `data/settings.json` → `UDP_PORT` env → `5301` fallback.

On each packet:
1. Append raw buffer to `dump.bin`
2. If still in metadata-resolve phase: run `adapter.tryParse(buf, state)` — if result has non-zero `TrackOrdinal`/`CarOrdinal`, write meta and exit resolve phase

No broadcasting, no pipeline, no lap detection.

## ACC Recording

A thin standalone reader inside `server/record.ts` that opens the three ACC memory-mapped files directly using the same `kernel32.dll` FFI calls as `shared-memory.ts`, but implemented fresh with no dependency on the existing reader. Does NOT call `processPacket`. On each read tick:
1. Copy raw bytes from each mapped region
2. Append to `dump.bin` with type prefix (`0x01` / `0x02` / `0x03`)
3. If in metadata-resolve phase: assemble a `TelemetryPacket` from the structs, check for non-zero track/car ordinals, write meta when found

The existing `shared-memory.ts` and `accReader` singleton are NOT modified.

## Replay (Tests)

```ts
import { readUdpDump, readAccDump } from "./helpers/recording";
import { parsePacket } from "../server/parsers";

// UDP games
const buffers = readUdpDump("data/recordings/2026-04-09T14-32-11/dump.bin");
for (const buf of buffers) {
  const packet = parsePacket(buf); // identical path to runtime
}

// ACC
const frames = readAccDump("data/recordings/2026-04-09T14-32-11/dump.bin");
// frames: Array<{ type: 0x01 | 0x02 | 0x03, buf: Buffer }>
```

`readUdpDump` reads plain length-prefixed records and returns `Buffer[]`. `readAccDump` reads type-prefixed records and returns `{ type: number, buf: Buffer }[]` preserving the original interleaved sequence.

## Files Changed / Created

| File | Change |
|------|--------|
| `server/record.ts` | New — standalone recorder entry |
| `package.json` | Add `dev:record` script |
| `test/helpers/recording.ts` | New — dump reader helper for tests |
