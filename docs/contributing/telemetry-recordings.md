# Recording and importing telemetry

Collect raw packet dumps to reproduce parser and lap-detection problems and to
preserve regression fixtures.

## Capture a session

Use the game-specific development command:

| Game | Command | Output directory |
| --- | --- | --- |
| Forza Motorsport 2023 | `bun run dev:dump:fm` | `test/artifacts/sessions/` |
| F1 2025 | `bun run dev:dump:f1` | `test/artifacts/sessions/` |
| Assetto Corsa Competizione | `bun run dev:dump:acc` | `test/artifacts/sessions/` |
| Assetto Corsa Evo | `bun run dev:dump:ac-evo` | `test/artifacts/sessions/` |
| iRacing | `bun run dev:dump:iracing` | `test/artifacts/sessions/` |

Drive the relevant session, then press `Ctrl+C`. The shutdown handler flushes the
recorder so the file ends on a complete frame.

Examples:

```text
test/artifacts/sessions/fm-2023-<timestamp>.bin
test/artifacts/sessions/f1-2025-<timestamp>.bin
test/artifacts/sessions/acc-<timestamp>.bin
test/artifacts/sessions/ac-evo-<timestamp>.bin
test/artifacts/sessions/iracing-<timestamp>.bin
```

Keep the game identifier in the filename. Import uses it to select the adapter.

## Import a dump

Import sends a recording through the normal parser, lap detector, and database
writer:

1. Start RaceIQ with `bun run dev`.
2. Open `http://raceiq.localhost:1355/dev`.
3. Drop a `.bin` or `.bin.gz` file on **Import Dump**.
4. Check the reported game, packet count, car, track, and saved laps.

The development route is unavailable in production builds.

Recorders use different binary formats:

- FM and F1: `SessionRecorder` length-prefixed UDP datagrams.
- ACC and AC Evo: `AcRecorder` typed shared-memory frames.
- iRacing: `IRacingRecorder` SDK source frames.

Use the corresponding reader or `test/support/recordings/parse-dump.ts` helper
rather than decoding recordings ad hoc.

## Commit a regression fixture

Raw `.bin` files are gitignored. Compress a selected fixture before adding it:

```sh
bun run gzip:recording path/to/recording.bin
git add path/to/recording.bin.gz
```

The command keeps the original `.bin` for local replay. Recording support and
the Import Dump panel accept `.bin.gz` directly.

```ts
import { parseDump } from "../../test/support/recordings/parse-dump";

const result = await parseDump(
  "fm-2023",
  "test/artifacts/sessions/fm-2023-<timestamp>.bin.gz",
);
```

Prefer a small fixture that demonstrates one observable regression. Document
the expected lap or parser behavior in the test that consumes it.

## Capture hygiene

- Stop with `Ctrl+C` when possible. A hard kill can truncate the final frame.
- Do not rename fixtures after capture without preserving the game identifier.
- Stage developer-only recordings under `test/artifacts/`, not production
  session storage.

## Normal ACC capture

Use normal `bun run dev` with ACC running; do not use `dev:dump:acc` for canonical Broadcast acceptance, since that separate ACCTEST recorder captures shared-memory pages only. Configure ACC's protocol-v4 Broadcast endpoint at `127.0.0.1:9000`, or set matching `ACC_BROADCAST_HOST` and `ACC_BROADCAST_PORT`. Set `ACC_BROADCAST_PASSWORD` and `ACC_BROADCAST_COMMAND_PASSWORD` when required by game configuration.

Broadcast capture starts whenever ACC starts, independently of voice enablement. To exercise live callouts, also enable `RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER` and include `acc` in `RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS`; these existing gates are unchanged.

Drive a multiplayer session with multiple opponents, completed laps, pit entry/exit, position changes, disconnect/reconnect, source dropout/recovery, and a session restart. Stop cleanly and retain the canonical session `.bin` or `.bin.gz`. ACCB records and recording-start raw context stay inside that one file; ACCP player frames remain unchanged. Lap export/import and reprocess preserve source evidence, and unavailable/malformed opponent data does not discard player telemetry.

In Engineer Replay, check typed `opponentSourceCapture` status/count and captured-clock availability, then compare identity/class/position/lap/pit/connectivity and pace/spotter evidence against live observations. Verify source-loss panels, player focus, seek/reset, mute, preemption, and exact-pace response. Heard audio and in-game usability require human observation.

Native ACC acceptance remains blocked until that real-game capture and comparison are retained. Synthetic fixtures and older shared-memory-only recordings prove automated compatibility, not native Broadcast support. Do not promote the [ADR capability](../architecture/decisions/opponent-callout-capabilities-and-phasing.md) solely because automated tests pass.
