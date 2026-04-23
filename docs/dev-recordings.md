# Recording and importing telemetry dumps

Telemetry dumps are raw packet captures saved to `test/artifacts/sessions/`.
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

Drive your session. The server appends packets live. When you're done,
hit `Ctrl+C` — the signal handler flushes the recorder before exiting,
so the file ends on a clean packet boundary. Recording files are
timestamped:

```
test/artifacts/sessions/fm-2023-2026-04-18T17-32-09-418Z.bin
test/artifacts/sessions/f1-2025-2026-04-18T17-45-12-902Z.bin
test/artifacts/sessions/acc-2026-04-18T17-51-03-776Z.bin
test/artifacts/sessions/ac-evo-2026-04-18T17-59-44-112Z.bin
```

The filename prefix encodes the `gameId` — don't rename it, or the
importer can't auto-detect which parser to use.

## Import a dump

Importing feeds the file through the full pipeline — parser, lap
detector, DB writer — so any detected laps land in
`data/forza-telemetry.db` as if you had played the session live.

Both raw `.bin` and gzipped `.bin.gz` are accepted — the server detects
gzip magic bytes and decompresses on the fly. No need to gunzip first.

1. Run the dev server: `bun run dev`
2. Open http://raceiq.localhost:1355/dev
3. Drag a `.bin` or `.bin.gz` onto the **Import Dump** panel
4. The panel reports detected `gameId`, parsed packet count, detected
   car/track, and how many laps were written

The `/dev` route is only mounted when `IS_DEV` is true — not available
in production builds.

## Committing a recording as a test fixture

Raw `.bin` dumps are gitignored — they're developer-local by default.
To commit one as a regression fixture, **gzip it first**:

```sh
bun run gzip:recording test/artifacts/sessions/fm-2023-2026-04-18T17-28-14-420Z.bin
git add test/artifacts/sessions/fm-2023-2026-04-18T17-28-14-420Z.bin.gz
```

The script keeps the raw `.bin` next to the `.bin.gz` so you can still
replay it locally without decompressing. Run it once per recording
you want to commit — recordings tend to be a deliberate choice, so the
script doesn't sweep the whole directory.

Test helpers accept `.bin.gz` directly — they decompress on load, so
fixtures stay compressed in the repo and nothing has to be unpacked
into a temp file first:

```ts
// test/e2e/fm-2023-recording.test.ts
import { parseDump } from "../helpers/parse-dump";

const result = await parseDump(
  "fm-2023",
  "test/artifacts/sessions/fm-2023-2026-04-18T17-28-14-420Z.bin.gz"
);
expect(result.laps).toHaveLength(3);
```

Same for the `/dev` Import Dump panel — drop a `.bin.gz`, the server
gunzips it server-side before replaying.

## Tips

- Recordings are append-only. A clean `Ctrl+C` runs the SIGINT handler
  and flushes the buffer, so the file ends on a packet boundary. A
  hard kill (e.g. `kill -9`) can still truncate the in-flight record,
  but everything written prior remains importable.
- Shared-memory games (ACC, AC Evo) use their own `.bin` triplet
  format; UDP games (FM, F1) use the `UdpRecorder` `[uint32 len][N
  bytes]` format. The importer picks the reader automatically from the
  filename prefix.
