# Recording diagnostics

Cross-game tools for inspecting, replaying, compressing, and auditing recorded telemetry files.

## Commands

| Command | Required input | Output |
| --- | --- | --- |
| `bun scripts/telemetry/recordings/debug-fm-lap.ts` | Built-in Forza Motorsport recording fixture | Per-lap geometry, distance, and quality assessment |
| `bun scripts/telemetry/recordings/check-mid-session-lap.ts` | Built-in gzip AC Evo fixture | Packet lap transitions and detector output |
| `bun run gzip:recording <path/to/file.bin>` | Existing raw `.bin` | Adjacent `.bin.gz`; source remains unchanged |
| `bun scripts/telemetry/recordings/inspect-bin.ts <path> [--game <id>] [--no-import]` | `.bin` or `.bin.gz` capture | Header, game detection, and optional import summary |
| `bun scripts/telemetry/recordings/probe-recording.ts <gameId> [path]` | Game ID and optional capture path | Parsed lap JSON; finds latest recording when path omitted |
| `bun scripts/telemetry/recordings/replay-udp-debug.ts <dump> [port] [speed]` | Length/timestamp-prefixed UDP dump | Packet statistics and localhost UDP replay |
| `bun scripts/telemetry/recordings/scan-currentlap.ts` | Built-in FM and F1 fixtures | Current-lap ranges and reset transitions |
| `bun run scripts/telemetry/recordings/scan-lap-offsets.ts <sessionId>` | Database session ID with raw file | Lap transitions and raw byte offsets |
| `bun run scripts/telemetry/recordings/verify-lap-alignment.ts <sessionId>` | Database session ID with raw file and laps | DB/file offset skew report |

## Boundaries and verification

`inspect-bin.ts` uses gzip magic-byte detection and `gunzipIfNeeded`; `check-mid-session-lap.ts` remains unconditionally gzip-decompressing, while `diag-status.ts` owns extension-based policy. Database tools require initialized RaceIQ DB and session raw files. Replay tools send only to localhost and require a compatible UDP listener for end-to-end verification.
