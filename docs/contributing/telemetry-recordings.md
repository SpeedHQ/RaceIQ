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
| Automobilista 2 | `bun run dev:dump:ams2` | `test/artifacts/sessions/` |
| Le Mans Ultimate (LMU) | `bun run dev:dump:lmu` | `test/artifacts/laps/` |

For AMS2, start dump mode before entering a session and leave the session before
stopping capture. Follow [AMS2 fixture instructions](../development/ams2-dump-recording.md)
for required lap coverage and independent observations.


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

When seeding checked-in source fixtures, convert each with its declared game ID to a sparse RaceIQ capture before passing it to the importer. Do not upload historical full-frame recordings; `/api/laps/import` accepts sparse RaceIQ captures only.

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
- AMS2: `AMS2DMP1` raw mapped-source frames, including menus and session transitions.
- LMU: `LMURecorder` LMUQDMP format.

Use the corresponding reader or `server/test-support/recordings/parse-dump.ts` helper
rather than decoding recordings ad hoc.

## Work with published lap archives

New completed-session splits publish one `capture.bin.gz` data file and a manifest v4 JSON index in an immutable attempt directory. The gzip file contains independent members, not one solid compressed session. Use the production artifact resolver and `SessionCaptureSource.artifact` to replay or export one lap; do not gunzip the whole data file, extract members to a cache, invent entry filesystem paths, or silently use the retained source when a published layout is invalid.

Keep physical member offsets and compressed sizes separate from decoded capture offsets and detector-owned source ranges. Preserve native frame bytes, ordering, timestamps, missing timestamps, zero-based detector lap numbers, parser bootstraps, and explicit completion context. A checksum proves integrity, not semantic source conservation. New splits must pass the package's closed-archive verification before fenced publication.

Legacy manifest v3 directory bundles remain readable without reinterpretation or in-place rewriting. Archive layout 2 uses separate DB manifest and archive paths; null-layout source reads remain unchanged. Cleanup and relocation must account for both paths, protect active staging and shared references, invalidate metadata/telemetry caches, and count shared archive bytes once. Never recompress the indexed archive as a whole-session stream.

Retained monolithic recordings follow existing policy. Measure archive storage against identical plain and already-gzipped member payloads, with logical and allocated bytes distinguished. Report retained-source storage separately; aggregation alone does not prove compression savings. Label synthetic windows, synthetic acquisition timestamps, application-cold reads, OS cache assumptions, and memory high-water scope explicitly. See [recording architecture](../architecture/telemetry-recording.md#indexed-completed-session-lap-archives) and the [archive implementation plan](../plans/indexed-session-lap-archive.md).

## Verify incremental live capture

Incremental live derivation is release-gated: `configureLiveCaptureRuntime()` exists but is not registered in production boot. Do not enable it merely because a behavioral smoke or compiler check passes. Live means telemetry is currently being produced; offline means existing recordings, import, reprocessing, or restart recovery—not network connectivity.

Run real-game conservation, independent offline detector, semantic replay, early-reader, and close checks:

```sh
bun apps/backend/test/benchmarks/live-lossless-release.bench.ts --trials=1 --rate-scale=1 --output=.omp/evidence/live-lossless/behavioral.json
bun test apps/backend/test/session-capture/live-worker-catchup.test.ts apps/backend/test/session-capture/live-recovery.test.ts apps/backend/test/session-capture/live-source-reader.test.ts
```

Prepared handover has separate deterministic file-backed coverage:

```sh
bun test packages/capture-splitting/test/prepared-host.test.ts packages/capture-splitting/test/prepared-handover.test.ts packages/capture-splitting/test/live-scenarios.test.ts --timeout 60000
```

The host tests exercise pre-opened spare files/journals and terminal cleanup. Handover tests hold finalization behind explicit gates: the next member must accept records before the previous gate is released, another boundary must respect the one-finalizer capacity, and close/failure must settle outstanding work without publishing an unverified member. These are ordering and losslessness assertions, not wall-clock speed thresholds; the production parser/detector smoke above remains the integration check.

The catch-up regression uses a real shared source/derivation worker, delayed authoritative controls, and concurrent bounded input after a canonical-cache miss. It covers both an original candidate and a selected, trimmed preparation window. Its optional long-input probe retains only a small native fixture and bounded RSS observations; `RACEIQ_LIVE_STRESS_OUTPUT` writes separate `-trim-0.json` and `-trim-1.json` reports rather than overwriting either scenario:

```sh
RACEIQ_LIVE_STRESS_RECORDS=100000 RACEIQ_LIVE_STRESS_OUTPUT=.omp/evidence/live-lossless/long-source-catchup.json bun test apps/backend/test/session-capture/live-worker-catchup.test.ts
bun apps/backend/test/benchmarks/live-lossless-performance.bench.ts --trials=3 --rate-scale=1 --output=.omp/evidence/live-lossless/matched-release.json
```

The matched runner declares and enforces numeric capture budgets before measurements. It requires all six fixtures, at least three trials, and sustained rate scale 1 for release coverage; subsets or faster replay exit nonzero without release approval. Timed legacy and incremental variants both exclude user replay/cache work. Native member verification, independent parser replay, publication, readiness, and sealing remain enabled. Early-reader, full replay/export, and reconnect proof are separate mandatory behavioral/UI gates, not optional replacements for capture measurements. CPU includes worker threads; OS-attributed physical I/O and page-cache effects must be distinguished from logical archive/source bytes. Fixture pacing uses the reported acquisition or game-clock domain and preserves missing timestamps rather than fabricating them.

Both variants start with an empty replay cache and a full GC. RSS sampling includes ingress and close; the legacy baseline also samples after offline splitting, so its allocation cost is not omitted. These sampled deltas are not an OS lifetime high-water mark or a cold-machine claim. Behavioral smoke reports also measure full consumer replay; do not compare their replay-cache growth to a capture-only baseline.

The 500 ms close budget applies at sustained game rate (scale 1). Accelerated or unpaced stress still requires bounded queues, native conservation, parser verification, publication, and complete drain; its measured backlog close latency is reported without that cap. Other numeric budgets remain enforced. This is not a constant-time close guarantee when unverified work remains.

The long-input probe is synthetic repeated native input, not game-rate or disk-latency evidence. Its late-half RSS-span budget is 64 MiB; inspect its bounded observations and worker queue/cache limits rather than treating the final zero backlog as a peak. Verify recording/finalizing/sealed/failure states, reconnect, actual playback, and raw export in the application on desktop and mobile. Retain source and committed prefixes on failure; do not weaken v4 EOF validation or mark an uncommitted member ready.

### Diagnose source-recorder memory and worker handoff

Run the diagnostic benchmark independently of the all-game release gate:

```sh
bun apps/backend/test/benchmarks/recorder-handoff.bench.ts --seconds=30 --fps=240 --trials=3 --output=.omp/evidence/live-lossless/recorder-handoff.json
```

Each baseline/worker trial runs in a fresh process with the same bounded working set of 512 real FM frames. Input repeats with synthetic missing, zero, and UTC timestamps; `--fps` controls offered load, not a claim about observed game rates. Increase `--seconds` for memory-plateau observations or `--fps` for burst pressure. Admission failure fails the command rather than silently reducing load. Trials alternate variant order, and temporary capture files are removed.

The report separates enqueue cost, enqueue-to-worker receipt (including batching), write acknowledgement, and durable acknowledgement latency, with p50/p95/p99 and sample counts. Receipt is timestamped inside the real filesystem worker before queued I/O runs; acknowledgements include return-message delay. It also reports transferred buffer bytes, batch sizes, sampled RSS peaks and twelve bounded memory windows, process lifetime peak RSS before verification, and source queue high-water marks. Transferred bytes are not copy/allocation counts. One extra diagnostic message per batch and bounded timestamp bookkeeping add measurement overhead.

Both variants must reproduce every native frame, its order, and timestamp presence/value through the production sparse reader after durable close. Baseline close includes an explicit final file sync; unlike the worker, it has no periodic sync. RSS includes fixture/runtime/diagnostic state and worker memory. Final verification is excluded from capture samples; lifetime peaks still include fixture preparation. OS caches are uncontrolled. This isolates source recording, not parser/detector work, lap-ready latency, or full derivation. Results have no arbitrary speed thresholds and do not authorize production activation.


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
