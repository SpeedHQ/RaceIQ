# Recording and importing telemetry dumps

Telemetry dumps are raw packet captures saved to `test/artifacts/laps/`.
They are useful for reproducing parser bugs, building test fixtures, and
replaying a session through the pipeline without the game running.

## Capture a session

Pick the `dev:dump:*` script for the game you're running. Each launches
the dev server in recording mode and opens the dashboard:

| Game | Script | Recording mechanism |
| --- | --- | --- |
| Forza Motorsport (2023) | `bun run dev:dump:fm` | UDP — raw datagrams |
| F1 2025 | `bun run dev:dump:f1` | UDP — raw datagrams |
| Assetto Corsa Competizione | `bun run dev:dump:acc` | Shared memory (Windows only) |
| Assetto Corsa Evo | `bun run dev:dump:ac-evo` | Shared memory (Windows only) |

Drive your session. The server appends packets live — kill the process
when you're done (`Ctrl+C`). Recording files are timestamped:

```
test/artifacts/laps/fm-2023-2026-04-18T17-32-09-418Z.bin
test/artifacts/laps/f1-2025-2026-04-18T17-45-12-902Z.bin
test/artifacts/laps/acc-2026-04-18T17-51-03-776Z.bin
test/artifacts/laps/ac-evo-2026-04-18T17-59-44-112Z.bin
```

The filename prefix encodes the `gameId` — don't rename it, or the
importer can't auto-detect which parser to use.

## Import a dump

Importing feeds the file through the full pipeline — parser, lap
detector, DB writer — so any detected laps land in
`data/forza-telemetry.db` as if you had played the session live.

### Option 1 — Dev route (recommended)

1. Run the dev server: `bun run dev`
2. Open http://raceiq.localhost:1355/dev
3. Drag the `.bin` (or gzipped `.bin.gz`) onto the **Import Dump** panel
4. The panel reports detected `gameId`, parsed packet count, detected
   car/track, and how many laps were written

### Option 2 — Direct API call

```bash
curl -F "file=@test/artifacts/laps/fm-2023-…-.bin" \
     http://raceiq.localhost:1355/api/dev/import-dump
```

The route is mounted only when `IS_DEV` is true — not available in
production builds.

## Tips

- Recordings are append-only. A hard kill mid-write truncates at most
  the last packet — everything prior is intact and importable.
- `.bin.gz` uploads are decompressed on the server, so large dumps can
  be checked into the repo gzipped.
- Shared-memory games (ACC, AC Evo) use their own `.bin` triplet
  format; UDP games (FM, F1) use the `UdpRecorder` `[uint32 len][N
  bytes]` format. The importer picks the reader automatically from the
  filename prefix.
