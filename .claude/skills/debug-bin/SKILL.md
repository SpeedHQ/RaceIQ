---
name: debug-bin
description: Debug RaceIQ session .bin/.bin.gz files — unknown track/car, 0 packets, missing laps, import failures. Use when a session bin imports wrong or a user reports bad telemetry data.
---

# Debug Session Bins

## Quick start

```bash
bun scripts/inspect-bin.ts <path-to-bin> [--game <gameId>] [--no-import]
```

One command. Prints header hex dump, game detection, packet count, laps, car/track resolution. Flags `UNKNOWN TRACK` inline.

Stage-only header check (fast, no import): add `--no-import`.

## Diagnosis flowchart

| Symptom | Likely cause | Where to look |
|---|---|---|
| `game from buffer: (none)` | Magic bytes not recognized | `detectGameIdFromBuffer` in `server/import-session-bin.ts` (~line 126). Compare hex dump vs known magics (`ACEVO_PACKED_MAGIC`, `META_FRAME_MAGIC`) |
| `packets: 0` | Frame format mismatch or parser rejects frames | `iterateFrames` + adapter `tryParse` in `server/games/<game>/` |
| `UNKNOWN TRACK` | Track name/ordinal not in CSV, or track extraction never ran | `shared/games/ac-evo/tracks.csv`, `getAcEvoTrackByName`, parser track resolution in AC Evo parser |
| Unknown car (log line `Unknown car "..."`) | Car missing from CSV | `shared/games/ac-evo/cars.csv`, `getAcEvoCarByDisplayName` |
| Laps = 0 with packets > 0 | Lap detector never fires | `createLapDetector`, check session type, `flushIncompleteLap`. Note: lap detector defers `insertLap` via `setTimeout(0)` — importer waits 100ms |
| Wrong lap times | Sector/timing extraction | `scripts/check-lap-times.ts`, `scripts/check-lap-sequence.ts` |

## Key facts

- `importSessionBin(bytes, gameId)` accepts gzip'd input (auto-detected by magic bytes) regardless of extension.
- MUST call `initServerGameAdapters()` (from `server/games/init`) before `getServerGame`/`importSessionBin` in any standalone script — otherwise `Unknown server game adapter` error.
- Import path uses `ImportCaptureAdapter` + `NoopWsAdapter` + `bypassPacketRateFilter: true` — no live server needed.
- AC Evo player slot locks after ~60 frames (`Player slot locked` log line). Early frames may resolve to wrong car.
- Parser logs (`[AC Evo Parser] Resolved track/car: ...`) go to stdout — grep them, don't suppress.

## Deeper digging

- Raw hex around a specific offset: `bun scripts/inspect-bin.ts <file> --no-import`, then targeted reads.
- Game-specific diagnostics: `scripts/diag-ac-evo-physics.ts`, `scripts/diag-ac-evo-status.ts`, `scripts/check-acc-dump.ts`, `scripts/debug-fm-lap.ts`.
- Adding a missing track/car: edit the CSV in `shared/games/<game>/`, then re-run inspect-bin to verify resolution end-to-end (parser → ordinal → DB).
- Follow systematic-debugging: reproduce first (inspect-bin IS the repro), find root cause before patching CSVs blindly.
