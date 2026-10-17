# Record an AMS2 source fixture

Dump mode is a development tool, separate from ordinary saved sessions. Start it
before entering a driving session, and leave the session before stopping it.
Windows x64, Bun 1.4.2, an installed AMS2 copy, and Project CARS 2 shared memory
in AMS2's Options → System are required. Close other RaceIQ copies first.

From the repository root:

```powershell
bun install --frozen-lockfile
bun run dev:dump:ams2
```

The command starts the normal development proxy/client and backend with
`--record=ams2`. It starts the native recorder even before AMS2 is running.
Wait for `[AMS2] Recording mode: <path>` before entering a session. Dumps are
written to `test/artifacts/sessions/ams2-<UTC timestamp>-<unique suffix>.bin`.
The output header is created immediately, even before any source frames arrive.
Keep the filename, which identifies the game.

## Human recording

Record **no more than six laps in total, including partial laps**. Include an
outlap, a clean reference lap, a following comparison lap at a different pace,
an unclean/invalid lap, and an inlap. Start in the pits if possible. Otherwise,
pit at the first opportunity, then capture the following outlap. Plan the laps
to stay within the six-lap total. The final lap need not be an inlap.

Write down the game build, shared-memory settings, car, circuit/layout, session
type, lap numbering, validity, and observed lap and sector times. On the clean
reference and comparison laps, note delta-to-best near 25%, 50%, and 75% lap
progress, including its sign and reference. Note unsupported readings rather
than guessing expected results. Screenshots/video can help retain observations.

Leave the driving session while the recorder is still running. Remain in the
menus for at least five seconds, then press Ctrl+C in the recording terminal.
Wait for `[AMS2] Dump flushed: ...` before closing the terminal. Do not restart
the backend, edit source files, or kill the process during capture. Supply the
dump path and notes about session entry and exit.

## Compression and fixture review

The `.bin` stays local and is ignored by Git. Compress using the existing tool:

```powershell
bun run gzip:recording "test/artifacts/sessions/ams2-<capture filename>.bin"
```

Only reviewed gzip fixtures (or ordered parts made by the existing splitting
utility) belong in Git; each committed file must be strictly below 100,000,000
bytes. Do not use Git LFS. Verify gzip integrity and replay results against the
human notes before committing. Follow the current upstream new-game checklist.

## Format, lifecycle, and limitations

`AMS2DMP1` version 1 is a development raw dump: a 16-byte header containing magic,
version, and flushed frame count; then repeated uint32 little-endian lengths and
complete `RQAMS201` source frames. A zero count denotes an open/interrupted file.
Readers reject unsupported versions, impossible lengths, truncation, and a
nonzero frame-count mismatch. Raw and gzip streaming readers use bounded input
buffers. Production sessions continue to use the existing lossless sparse codec.

Source frames retain acquisition UTC, session epoch, and every byte of the
readable Windows mapped region, including undecoded extensions and page padding.
The existing 7,388-byte stable prefix is decoded; older prefix-only recordings
remain readable. ABI versions 8–14 are supported for driving interpretation.
Do not claim unimplemented tail fields as supported telemetry.

Capture includes menu/replay snapshots even without car/participant identity.
Identical snapshots and odd/inconsistent writer sequences are filtered explicitly.
Polling is requested every 10 ms with serial dispatch; actual accepted update
rate depends on the game and storage. This does not claim verified native 100 Hz
or persisted benchmark acceptance. No samples are fabricated to raise the rate.

Dump mode prints `[AMS2] Capture totals` every ten seconds and when stopped.
These are cumulative counters for the source instance. `processingBusy` counts
polls skipped while an earlier packet is still processing; `noSnapshot` counts
empty reader results. Reader counters distinguish an absent mapping
(`disconnected`), an odd writer sequence (`writerBusy`), a sequence changed
between copies (`sequenceChanged`), and differing bytes with the same sequence
(`bytesChanged`). `duplicates`, `malformed`, `dispatched`, and `errors` describe
later source processing. Keep the console log with the dump when investigating
missing samples; dumps contain accepted snapshots and cannot recover rejected
reads. These counters do not relax the existing snapshot consistency checks.

`staleTransition` counts snapshots whose session type changes while the native
race state still says finished. They remain in the raw dump but are withheld
from live processing until the new session publishes a non-finished state.
This guard applies to live capture; importing an existing raw dump does not
apply the source's transition guard.

An active session's menu/exit transition finalises production persistence before
EOF, without publishing retained menu readings as live driving telemetry. Pausing
and replay are not treated as proof of a session end. Native delayed timing,
validity, sectors, and source transitions still need the real human fixture;
synthetic and controlled-memory tests do not replace it.

Untimed lead-in crossings can wrap distance while AMS2 leaves the lap number
unchanged and reports unavailable lap timing. When adjacent samples cross the
start line with continuous position and no session change, AMS2's lap policy
starts a new buffer and logs `Untimed start-line crossing`, rather than reporting
a race restart. This does not invent lap times for untimed circuits. Timed
restarts, mid-lap distance resets, position jumps, and long gaps retain the
existing reset handling.

The dump can be imported through the development dump importer (`.bin`/`.bin.gz`)
or the registered session import path. Both use the matching dump reader;
canonical sparse session recordings use their existing reader.

Windows mapping references: [MapViewOfFile](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-mapviewoffile)
and [VirtualQuery](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualquery).
Mapping the complete view and querying its readable committed region avoids
discarding extensions based on the decoded prefix size.
