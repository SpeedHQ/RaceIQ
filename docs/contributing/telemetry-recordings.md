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
| Le Mans Ultimate (LMU) | `bun run dev:dump:lmu` | `test/artifacts/laps/` |

Drive the relevant session, then press `Ctrl+C`. The shutdown handler flushes the
recorder so the file ends on a complete frame.

Examples:

```text
test/artifacts/sessions/fm-2023-<timestamp>.bin
test/artifacts/sessions/f1-2025-<timestamp>.bin
test/artifacts/sessions/acc-<timestamp>.bin
test/artifacts/sessions/ac-evo-<timestamp>.bin
test/artifacts/sessions/iracing-<timestamp>.bin
test/artifacts/laps/lmu-<timestamp>.bin
```

Keep the game identifier in the filename. Import uses it to select the adapter.

## Replay a dump

Use the game's recording support with `parseDump` from
`@raceiq/backend-core/test-support/recordings/parse-dump` to replay a fixture
through production parsing and lap detection. Check the game, packet count,
car, track, and saved laps against capture notes. Reassemble split recordings
before passing the file to the reader.

Recorders use different binary formats:

- FM and F1: `SessionRecorder` length-prefixed UDP datagrams.
- ACC and AC Evo: `AcRecorder` typed shared-memory frames.
- iRacing: `IRacingRecorder` SDK source frames.
- LMU: `LMURecorder` LMUQDMP format.

Use the corresponding reader or `server/test-support/recordings/parse-dump.ts` helper
rather than decoding recordings ad hoc.

## Commit a regression fixture

Raw `.bin` files are gitignored. Keep each original raw `.bin` locally for replay.
Gzip selected fixtures; every committed recording file, including each split
part, MUST be strictly smaller than 100,000,000 bytes. Do not use Git LFS.
Never stage raw `.bin` files or oversized gzip files.

```sh
bun run gzip:recording test/artifacts/laps/lmu-example.bin
gzip -t test/artifacts/laps/lmu-example.bin.gz
wc -c < test/artifacts/laps/lmu-example.bin.gz
```

If gzip is 100,000,000 bytes or larger, run the existing recording-splitting
utility. Confirm every ordered part is strictly below 100,000,000 bytes and
retains the game identifier; stage only the parts, not the oversized original.
Do not write a new splitter or use Git LFS.

Use `combineRecordingParts()` in
`server/session-capture/combine-recording-parts.ts` to reassemble consecutive
`.part1`, `.part2`, … files in numeric order. Verify byte-for-byte integrity
against the original and gzip integrity before replay. Keep oversized original
and assembled files local and unstaged.

For an unsplit gzip below the limit, stage the `.bin.gz` file instead:

```sh
git add test/artifacts/laps/lmu-example.bin.gz
```

Reassemble a committed split fixture locally before replay; individual part
files are not standalone recordings. Recording support accepts `.bin.gz`.

For LMU, use matching game support and retain the game identifier in the
assembled filename:

```ts
import { parseDump } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { lmuRecordingSupport } from "../support/recordings";

const result = await parseDump(
  lmuRecordingSupport,
  "test/artifacts/laps/lmu-<timestamp>-assembled.bin.gz",
);
```

For new-game implementation, human capture steps, and fixture requirements, follow
[Adding new game support](adding-new-game-support.md).

For example, preserve the game's support module in parser tests:
```ts
import { parseDump } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import { fmRecordingSupport } from "../support/recordings";

const result = await parseDump(
  fmRecordingSupport,
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
