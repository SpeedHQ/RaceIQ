# Performance benchmarks

RaceIQ keeps performance measurements separate from ordinary tests. `bun run bench` runs parser/pipeline benchmarks; `bun run bench:replay-io` measures end-to-end replay storage and I/O. Process-isolated benchmark tooling lives in `apps/backend/scripts/quality/process-bench.ts` with fixtures under `test/benchmarks/`.

## Direct recording audit: timing and memory

### Reproduce the direct recorder comparison

Run `bun run bench:direct-compare <baseline-checkout> <output.json>` from the candidate checkout. Both checkouts need dependencies, native fixtures, clean production sources, and identical copies of `direct-recorder-compare.ts`, `direct-recorder-workloads.ts`, and `live-lossless-release.bench.ts` under `apps/backend/test/benchmarks/`. The runner alternates revision order across two rounds and writes raw observations plus a Markdown table next to the JSON.

The seven-game burst times 32 fixture frames from first write through stop. Burst and paced runs verify persisted frame bytes, timestamps and order outside the timer. The 250 Hz synthetic LMU run measures write completion against the next scheduled frame, not heartbeat lateness. Stage timing and sampled RSS growth run in separate processes. Percent reductions compare local workload medians, not live game throughput.

### Retained LMU v3 grid: matched local recorder comparison

The input was the first 32 frames of `lmu-real-opponents-grid-2026-10-22.bin.gz`. The changing-grid variant alternated the first competitor's incarnation to force context cache misses. Each column used two fresh processes per workload, two warmups, and six measured captures per process. Revision order reversed in the second round. Time values are medians; deadline misses are counts across all 384 measured frames per column.

| Workload | Original (`7023af6b8`) | Reuse decoded key only | Context reuse + sparse block grouping + quote scan |
|---|---:|---:|---:|
| Real grid, synchronous writes | 100.57 ms | 75.80 ms | 27.95 ms |
| Real grid, first write through stop | 107.00 ms | 79.85 ms | 31.39 ms |
| Changing grid, first write through stop | 102.30 ms | 82.52 ms | 64.12 ms |
| Real grid at 250 Hz, missed write deadlines | 122 | 55 | 7 |
| Sampled RSS increase during writes, warm allocator | 0.336 MiB | 0.156 MiB | 0.023 MiB |

Each capture checked replay order, native bytes, timestamps, source-decoded first/last keys, and the companion SHA-256. The cache holds at most 1 MiB of context bytes per recorder; the warm RSS sample is not a bound on total or retained memory. Absolute deadline counts vary with the host. A separate unpaced stress case that grew the grid every frame exhausted the writer queue on both the key-only baseline and the optimized recorder. No buffer limit or integrity check was relaxed.

### LMU player identity on the live acquisition path

The live source reads identity from the same native telemetry and scoring slices that supplied the encoded frame. It no longer decodes that frame solely to obtain identity. The encoder still checks native player consistency and validates the context before emission.

On macOS arm64, four fresh processes per version replayed all 51 native memory snapshots at recorded spacing through `LMUTelemetrySource.pollOnce()`, the default parser, live pipeline, and recorder. REST was disabled; this excludes Windows mapping and REST acquisition. Pooled median poll completion fell from 3.084 to 2.769 ms (10.2%); p95 was 7.803 versus 7.733 ms. With fixed source clock and session key, all eight captures emitted the same frame digest. Strict replay matched every emitted frame and timestamp, and every live identity matched the identity decoded from its emitted frame.

For duplicate-heavy polling, the same 51 snapshots were polled four times each within their original update intervals. One controlled REST revision changed between native updates: 52 polls emitted frames and 152 were duplicates. Six fresh processes per candidate ran in balanced order on macOS arm64. Timings exclude Windows mapping and HTTP; live parsing, recording and strict replay were enabled.

| Duplicate-heavy live workload | Before | Reuse last identical snapshot | Borrow uncontended player snapshot and compare native identity fields |
|---|---:|---:|---:|
| Duplicate poll p95 | 70.5 µs | 40.6 µs | 30.0 µs |
| Main-thread CPU during duplicate polls per trial, median | 7.95 ms | 3.38 ms | 1.72 ms |
| All polls p95 | 4.04 ms | 3.60 ms | 3.51 ms |
| Main-thread CPU during all polls per trial, median | 212.3 ms | 188.4 ms | 177.0 ms |

The duplicate improvement repeated in an earlier four-trial comparison; whole-workload p95 did not improve consistently across both experiments. All candidates preserved admission decisions, replay bytes and timestamps. The selected path still copies snapshots when polls queue, player-session invalidation yields, or scoring-only processing needs ownership.

### LMU accepted-frame opponent snapshots

In the 16-car fixture, 44 of 51 accepted player frames repeated the preceding active scoring bytes. The tracker reuses its validated grid only for identical scoring bytes and player identity in the same session. On misses, it groups places by class once and applies the existing rank derivation.

| 51 accepted polls at recorded spacing | Main-thread CPU before → after | Poll p95 before → after |
|---|---:|---:|
| Recorded grid | 190.95 → 173.64 ms | 7.97 → 6.72 ms |
| Forced multiclass position changes on every frame | 310.70 → 307.56 ms | 7.72 → 7.95 ms |

Four fresh macOS arm64 processes per version and workload, balanced run order. CPU is the median total measured inside accepted polls; latency is pooled across polls. Every replay matched source frames and timestamps, and frame digests matched across versions within each workload. The changing 16-car grid showed no clear end-to-end gain. A separate tracker-only stress test with 104 cars and four classes used 38.95 → 36.58 ms median thread CPU per 100 changing grids, excluding recording and I/O.

### LMU dispatch when every opponent moves

On the 51-frame, 16-car trace, rotate native scoring rows and change each car's position, velocity, lap distance and rank on every accepted frame. Keep the production parser, live session capture and native dump worker active. A baseline profile measured 219.2 ms of main-thread CPU in `parsePacket` and 60.7 ms in `processPacket`. The dump worker used 11.8 ms of thread CPU from startup through the last poll; waiting for dump admission after submission took 0.13 ms elapsed over the trace. Worker time is not additive to main-thread CPU.

After consecutive context-cache misses, the decoder locates the first root `key` without scanning the entire opponent payload for duplicate names. Every changed context still passes full wire validation. Before cached data can be reused, the decoder checks the surrounding bytes and verifies root names are unique.

| Workload | Main-thread CPU before → after, ms per trace | Poll p95 before → after, ms |
|---|---:|---:|
| Every car moving | 318.13 → 292.27 | 7.51 → 7.46 |
| Every car moving, reversed run order and matched checkouts | 307.66 → 295.86 | 7.40 → 7.46 |
| Original recorded grid | 191.45 → 202.05 | 8.61 → 9.12 |
| Original recorded grid, reversed run order and matched checkouts | 189.95 → 196.38 | 9.44 → 9.43 |

Each row uses six fresh macOS arm64 processes per version, median CPU and pooled poll p95. Moving-grid CPU fell in both comparisons; p95 did not change consistently. Original recorded-grid CPU increased in both comparisons. Every native dump and strict session replay matched the emitted frames, including timestamps; digests matched across revisions within each workload.

#### Decoder-owned buffer reuse (not adopted)

The candidate copied changed context bytes into a reusable decoder-owned backing buffer. Capacity rounded up to 4 KiB; contexts above 1 MiB bypassed the cache. Both rounds used six fresh processes per workload and version; the second round reversed the order. The production parser, session recorder and native dump worker remained active.

| 51-frame workload | Median main-thread CPU, baseline → reuse | Pooled poll p95, baseline → reuse |
|---|---:|---:|
| Every car moving, round 1 | 300.41 → 306.70 ms | 7.84 → 8.08 ms |
| Every car moving, round 2 | 293.93 → 294.31 ms | 7.72 → 7.13 ms |
| Original recorded grid, round 1 | 214.63 → 186.45 ms | 8.74 → 8.02 ms |
| Original recorded grid, round 2 | 199.01 → 184.50 ms | 9.42 → 8.51 ms |

Separate decoder replays counted cache backing allocations. On the moving grid, allocations fell from 51 to 2 (29,871,305 → 1,175,552 bytes allocated cumulatively); final backing capacity rose from 585,917 to 589,824 bytes. On the recorded grid, allocations fell from 7 to 3 (4,142,826 → 1,785,856 bytes); final capacity rose from 589,799 to 589,824 bytes. These figures exclude decoded objects and are not process RSS.

Strict session replay matched all emitted frames and timestamps; native dump counts and digests matched on both workloads. Reuse reduced recorded-grid CPU but did not reduce moving-grid CPU in either round. Keep the existing decoder for the moving-grid priority. The next experiment should target parsing the serialized context immediately after the live source encoded it, without changing recording bytes or replay validation.

#### Live player context handoff (not adopted)

Four candidates passed an immutable opponent grid from LMU acquisition to the live parser. Recording and replay still used the original bytes. Each comparison used six fresh processes per workload and version, with the native dump worker enabled. Positive percentages below mean **less** main-thread CPU than the matched baseline. Ranges are separate rounds, not confidence intervals.

| Handoff strategy | Every car moving | Original recorded grid |
|---|---:|---:|
| Copy and freeze the context on every player frame | +5.1% | −12.3% |
| Reuse the copied grid after checking its bytes | −7.2%, −2.5% | −6.8%, +5.7% |
| Freeze the native grid in place on every player frame | +11.1% | −13.7% |
| Freeze in place only after consecutive grid changes | +9.3%, −0.5% | −8.9%, +11.9% |

The adaptive candidate kept a private metadata copy until dispatch, rejected changed metadata, decoded the supplemental header independently and left replay on the ordinary decoder. On the moving grid, poll p95 was 7.34 → 7.37 ms and 7.19 → 7.57 ms. No candidate demonstrated a repeatable moving-grid CPU improvement without a recorded-grid regression. Keep the ordinary parser and do not add the handoff or its per-queued-frame storage.

Strict session replay matched emitted frame bytes and timestamps. Native dump counts and digests matched for all four candidates. The final candidate also matched all 51 normalized packets against ordinary decoding and passed the targeted partition, phase1, adapter and opponent-recorder tests. These are local fixture replays, not live Windows or HTTP measurements.

#### Decode privately parsed opponent channels in place (adopted)

On a cache miss, the decoder parses and validates the complete JSON, converts timestamps and sequence numbers inside the privately owned competitor records, then freezes the tree. Parsed JSON cannot contain cycles, so this path does not allocate a visited-object set. The general object decoder still handles caller-owned objects separately. The encoder, SHA-256, capture bytes and worker boundary do not change.

| Workload and order | Baseline → owned decoder, median main-thread CPU per 51 frames | Reduction | Poll p95 |
|---|---:|---:|---:|
| Every car moving | 297.00 → 283.51 ms | 4.5% | 7.28 → 7.97 ms |
| Every car moving, reversed | 299.01 → 276.33 ms | 7.6% | 7.68 → 7.31 ms |
| Recorded grid | 196.41 → 193.24 ms | 1.6% | 8.61 → 8.93 ms |
| Recorded grid, reversed | 195.46 → 187.78 ms | 3.9% | 9.40 → 8.52 ms |

Six fresh processes per version, workload and order. The baseline already includes the adaptive key probe. CPU improvements repeated; poll p95 did not. Strict replay bytes, timestamps, dump counts and digests matched. No RSS or live Windows claim.

Writing UTF-8 directly into the output buffer instead of copying a temporary buffer gave mixed results. Alone, it changed moving-grid CPU from 290.77 to 301.71 ms and recorded-grid CPU from 202.16 to 190.92 ms. Added to the owned decoder, it changed moving-grid CPU from 291.11 to 268.70 ms but raised recorded-grid CPU from 178.87 to 212.86 ms. Keep the existing encoder.

A separate size experiment used the original 51 metadata documents, not the full capture or the recorder. A per-frame provenance dictionary reduced 32,943,247 bytes to 18,800,356; per-frame Zstandard level 1 reduced them to 674,515. Both reconstructed every input byte. Neither is a demonstrated recorder speedup: the current parser needs decoded values, and storing either representation would require a format change. Do not add those size reductions to the CPU savings above.

### Decision: inline SHA-256 for retained LMU opponents

The [accepted decision](../adr/0018-inline-companion-sha256.md) prioritizes missed deadlines over synchronous write speed. Three synthetic runs per strategy submitted 500 frames each at 250 Hz on macOS arm64, rotating strategy order. A miss means `writeRecord()` returned after the next scheduled frame was due. Start delay includes timer jitter.

| Strategy | Lost / submitted | Deadline misses by run | P95 start delay | Median write | Peak queued |
|---|---:|---|---:|---:|---:|
| Reread at stop | 0 / 1,500 | 2, 2, 4 | 1.44 ms | 441 µs | 385 KiB |
| Inline (selected) | 0 / 1,500 | 0, 1, 0 | 1.49 ms | 511 µs | 514 KiB |
| Batch drain | 0 / 1,500 | 1, 1, 1 | 1.58 ms | 360 µs | 514 KiB |

All strategies committed every frame with identical companion digests. Mean queued bytes in the first and last quarters were within 1 KiB for each strategy. The low miss counts do not establish a statistically reliable advantage. The batch results below describe the evaluated alternative, not the selected implementation.

### Retained LMU capture: SHA-256 in the writer drain

| 12-frame burst, median | Original reread (`7023af6b8`) | Inline hash (`4a7bee3e75`) | Batch hash |
|---|---:|---:|---:|
| First write through completed stop | 7.070 ms | 5.746 ms | 6.000 ms |
| Synchronous write | 242.98 µs/frame | 294.95 µs/frame | 237.75 µs/frame |
| Stop including pending writes | 4.173 ms | 2.149 ms | 3.093 ms |

The total is measured directly, not summed from stage medians. Each implementation recorded the same 12 prebuilt synthetic v2 frames on macOS arm64, with four warmups followed by 21 measured captures. Setup and independent digest verification were outside the timer. Batched hashing saved 1.070 ms (15.1%) per capture versus the original. Compared with inline hashing, writes took 19.4% less time, but the burst took 0.254 ms (4.4%) longer overall.

A separate paced run scheduled 120 frames per capture at 4 ms intervals. Over four measured captures after one warmup, median synchronous write time fell from 495 to 354 µs/frame and median stop took 3.92 versus 3.98 ms. P95 scheduled-to-actual write-start delay **increased** from 1.41 to 1.65 ms across 480 frames per variant. All records committed and companion digests matched across variants. Delay includes timer jitter; this is not a live UDP or Windows benchmark.

### Earlier inline-hash recorder versus `7023af6b8`

| Workload | Baseline | Updated |
|---|---:|---:|
| LMU partition, retention disabled | 127.65 µs/frame | 1.82 µs/frame |
| Publish a snapshot of 128 already-published laps | 238.67 µs/snapshot | 2.52 µs/snapshot |
| Retained LMU capture, synchronous `writeRecord` | 248.54 µs/frame | 326.03 µs/frame |
| Retained LMU capture, `stop()` including pending writes | 3.93 ms/capture | 2.89 ms/capture |

These measurements used the baseline and updated TypeScript implementations in separate Bun processes on macOS arm64. Timing values are medians of nine trials after two warmups. Each partition trial processed 64 synthetic v2 frames; each publication trial processed 50 snapshots. Each retained capture wrote 12 frames with varying opponent telemetry to a temporary directory. Both implementations produced a 2,491,597-byte companion whose manifest digest matched a separate file hash. Incremental hashing moved work into ingress: writes cost about 77 µs more per frame while stop finished about 1.04 ms sooner. This is not an end-to-end throughput claim.

| Sampled RSS increase above warm baseline | Baseline | Updated |
|---|---:|---:|
| 512 partitions | 0.000 MiB | 0.016 MiB |
| 512 publication snapshots | 1.094 MiB | 0.391 MiB |
| 12-frame retained capture | 0.031 MiB | 0.063 MiB |

For partition and publication, each fresh process ran a warmup workload, forced GC, then sampled RSS every eight operations. Values are medians across three processes. Retained-capture RSS was sampled after each write and after stop, with the same nine trials as timing. Warm allocator reuse makes small deltas inconclusive; eliminating a companion allocation does not imply a matching reduction in resident memory.

Regression tests hold a real retiring writer at its durability fence and verify strict replay after current-capture failure. The paused-ingress test submits 800 packets: 544 reject before release, 256 drain in order, and the next packet succeeds with no budget leak.

### Original candidate probes

These one-off probes compared revision `7023af6b8` with in-memory candidate changes on Bun 1.4.6, macOS arm64. The candidates did not change the shipped recorder. Timing values are medians of nine alternating paired trials after two warmups. Memory values are medians of three fresh processes per variant: the highest sampled RSS above each process's post-GC baseline, not retained heap or an exact allocation peak.

| Stage and workload | Current time | Candidate time | Current RSS increase | Candidate RSS increase |
|---|---:|---:|---:|---:|
| LMU partition, opponents off; skip companion construction | 123.09 µs/frame | 1.48 µs/frame | 11.73 MiB | 0.67 MiB |
| Lap publication, 128 already-published laps; skip known IDs before path lookup | 210.73 µs/snapshot | 2.61 µs/snapshot | 18.22 MiB | 4.53 MiB |
| 4 MiB companion checksum, write + sync + close + digest; hash on append instead of rereading | 4.29 ms/file | 3.23 ms/file | 4.78 MiB | 0.11 MiB |

The LMU timing probe processed 64 synthetic v2 frames per trial; the memory probe processed 512. Both variants produced identical player bytes in the timing probe. The current path copied 322,624 source bytes into a 322,720-byte opponent buffer per tested frame, despite retention being off.

The publication probe processed 50 snapshots per timing trial and 512 per memory trial. A single 128-lap snapshot performed 8,256 path inspections without publishing a lap. The memory result measures repeated scans, not a sustained per-session saving.

The checksum probe used real temporary files and 64 KiB writes. Both variants produced the expected SHA-256 digest. Post-close digest time, already included in the table, fell from 2.20 ms to 0.0014 ms. Hashing on append moves CPU work into recording; this probe did not measure live ingress latency.

Two fault probes identified correctness risks separate from the timing comparison:

- **Paused admission:** 800 pending calls to `processPacket` held 12.5 MiB of source buffers while the 8 MiB detector budget reported zero charged bytes. Sampled RSS rose by a median 11.86 MiB. In the admission probe, 256 calls proceeded and 544 rejected after release. Downstream packet processing was stubbed; this was not a UDP loss measurement.
- **Shutdown drain:** With one real recorder held at its durability fence, a second recorder failed. The pipeline finalizer rejected before the healthy recorder sealed or published its manifest. Releasing the fence produced a sealed, one-chunk manifest. The probe did not terminate a live backend or demonstrate permanent data loss.

These are stage measurements, not Windows full-session results, production memory forecasts, or release benchmarks.

## Benchmark tools and profiling

Follow [Bun's benchmarking recommendations](https://bun.com/docs/project/benchmarking): Mitata for parser/pipeline microbenchmarks; Hyperfine for complete script/CLI timings. CLI measurements include startup, fixture preparation, reporting and shutdown, so do not compare them directly with stage-only timings. The recorder scenarios keep explicit acquisition/import/finalization boundaries rather than treating paced replay duration as throughput.

For whole-command timing with separately installed Hyperfine:

```sh
hyperfine --warmup 1 --runs 5 'bun run bench:pipeline-stages --game=f1-2025 --trials=1 --frames=10000 --memory=off --output=/tmp/raceiq-stage-cli.json'
```

Run CPU and heap profiles separately from unprofiled timing comparisons:

```sh
bun --cpu-prof-md --cpu-prof-dir=/tmp/raceiq-profiles apps/backend/test/benchmarks/pipeline-stages.bench.ts --game=f1-2025 --trials=1 --frames=10000 --memory=off --output=/tmp/raceiq-profiled-stages.json
bun --heap-prof-md --heap-prof-dir=/tmp/raceiq-profiles apps/backend/test/benchmarks/pipeline-stages.bench.ts --game=f1-2025 --trials=1 --frames=10000 --memory=off --output=/tmp/raceiq-profiled-heap.json
```

Bun's JavaScript heap (`bun:jsc`) and native allocator heap are distinct. Retained JSC measurements below do not measure total process memory or exact transient allocations. Use RSS for whole-process scope; `heapStats()`, heap snapshots and `Bun.unsafe.mimallocDump()` provide separate diagnostic views, not interchangeable byte totals.

## Bun parsing, processing, and retained memory

```sh
bun run bench:pipeline-stages --game=f1-2025 --trials=20 --frames=10000 --output=/tmp/raceiq-pipeline-stages.json
```

This Bun-only harness uses Mitata's computed-parameter `measure()` API to separate full-presentation raw-frame parsing from processing of pre-parsed packets through `LiveTelemetryPipeline`. Defaults are six canonical recording fixtures, up to 10,000 source frames, one excluded warmup, and 20 measured full-workload samples per stage. `--trials` sets exact sample count; adaptive batching and trimming are disabled. Options are `--game=fm-2023|f1-2025|acc|ac-evo|iracing|lmu`, `--trials=1..100`, `--frames=<positive integer>`, `--memory=on|off` (default `on`), and required `--output=<path>`. FM's first active packet is at index 5,218; prefixes with no accepted packets fail rather than report an empty processing workload.

Fixture reading, decompression/framing, initial parser state, prepared packet cloning, and pipeline construction are outside throughput timers. Context records seed state without entering processing; segment boundaries reset state. Processing uses at-most-500-packet chunks and times each final/incomplete flush, releasing completed chunk state before advancing. This is a bounded workload, not a continuous-session or complete-finalization benchmark.

Processing uses null database, WebSocket, and recorder adapters. It does not measure UDP acquisition, capture writes, database persistence, or shutdown; detached followups are not guaranteed complete by the timed awaited boundaries. Reports retain runtime and Mitata version/API/options, fixture/workload hashes, raw Mitata statistics, and accepted/processed counts. `samplesSeconds` and `medianSeconds` derive from Mitata's nanosecond samples and p50; `nsPerFrame` uses source-frame count, while `nsPerPacket` uses accepted/processed count.

After throughput trials, memory profiling runs in a fresh process per fixture with three profile windows. Profile timings are discarded. The headline is median end-of-stage retained additional bytes above the prepared-input baseline. Separate sampled post-GC maxima are not exact allocation peaks: short-lived allocations between samples can be missed. Fixture buffers, prepared inputs, and report serialization are excluded; parser/pipeline state construction and stage work are included. Zero net growth does not mean zero allocation or zero state size. Use process RSS separately for whole-process memory.

For a small throughput-only smoke:

```sh
bun run bench:pipeline-stages --game=f1-2025 --trials=1 --frames=10000 --memory=off --output=/tmp/raceiq-pipeline-smoke.json
```

## Direct per-lap recording at 240 Hz

```sh
bun apps/backend/test/benchmarks/direct-lap-recording.bench.ts --output=artifacts/direct-lap-recording.json --fps=240 --trials=1
```

This runs all six complete native recording fixtures sequentially, with a fresh process and isolated database/recording directory per game and trial. Native inputs are paced individually at the requested frequency; this is not normalized telemetry output frequency. New recording uses the production direct recorder, real async filesystem writes, and durable file closure rather than a null recorder or post-session splitter.

Reports separate native admission, sparse encoding/enqueue, synchronous boundary rotation, and combined synchronous recording work per processed input. The combined metric includes admission and any subsequent encoding/boundary work for that input; normal and boundary distributions and operations exceeding 2 ms are reported explicitly. Whole `processPacket` wall time includes detector/database work and is not equivalent to recording enqueue latency. Startup waits for the two initial file opens and is reported separately.

Write-completion samples observe the oldest buffered enqueue through an async write batch completion, including batching delay; they are not individual device/fsync syscall measurements. A deadline-based 240 Hz heartbeat reports scheduling lateness and missed deadlines. CPU, OS-attributed disk bytes, sampled RSS, and queue peaks cover recording through finalization, excluding the subsequent conservation and replay checks. RSS still includes preloaded fixture buffers and all process state; it is not splitter-only or parser-allocation memory. Filesystem cache remains enabled.

Each complete run verifies native bytes/order/timestamps, standalone lap replay, actual shared boundary bytes, durable/closed files, and absence of a duplicate live archive or queued offline split job. `--game=<id>` and `--trials=<count>` narrow coverage. `--sample-limit=<count>` is diagnostic only and may not reach session start or any lap boundary; its report cannot establish complete boundary coverage. Per-game stdout/stderr logs are retained next to the requested output. Benchmark files and databases are removed after verification.

## Bun recorder workloads

`bun run bench:recorder` supports in-memory imports, persistent file imports, live UDP replay, and recording completion. Select `--mode=imports|disk-imports|live|both|recording` and provide `--output=<path>`. Reports include fixture hashes, packet/lap outcomes, measured trials, and explicit storage/resource scopes. Benchmark data uses isolated temporary directories.

The `imports` workload runs the production lap-index parser and detector through an isolated `LiveTelemetryPipeline` with captured in-memory session/lap outcomes. It includes decompression, framing, parser construction, and processing. Fixture reads and module initialization are outside the timer. Database and capture persistence, history seeding, developer-state updates, reconciliation, and acquisition are excluded; this is not the persistent `importSessionBin` API. Separate fresh-process memory trials measure whole-process resources, not parser allocations.

Stage benchmarks and in-memory imports explicitly register iRacing, including their memory children, independently of `RACEIQ_FEATURE_IRACING_ADAPTER`. Production adapter feature gating is unchanged. Recorder resource sampling uses `ps` on macOS/Linux and Windows PowerShell (`powershell.exe`) with `Get-CimInstance Win32_Process` on Windows. Unix CPU times accept `minutes:seconds` and `[days-]hours:minutes:seconds`; Windows kernel/user CPU ticks and working-set bytes are converted to the same CPU-seconds/RSS-bytes report. Sampling commands reject spawn failures, nonzero exits, and execution exceeding 10 seconds. Background sampling failures are surfaced by `stop()`, and an unavailable initial root-process sample fails instead of producing zero resource measurements.

Sampling subprocesses run with piped output and `windowsHide: true`; Windows PowerShell runs without a profile and in non-interactive mode, so sampling does not open a console window or prompt the user.

Use `disk-imports` for the real file-import API, storage writes, and outcome validation. `live` exercises UDP acquisition and replay; `recording` also measures recording completion and validates readable persisted captures. Live UDP workloads support FM 2023 and F1 2025. Keep replay pacing, acquisition, import, and finalization timings separate rather than interpreting replay wall time as parser throughput.

Focused recorder scenarios:

```sh
bun run bench:recorder --mode=imports --game=f1-2025 --trials=1 --output=/tmp/raceiq-memory-import.json
bun run bench:recorder --mode=disk-imports --game=f1-2025 --trials=1 --output=/tmp/raceiq-file-import.json
bun run bench:recorder --mode=live --game=fm-2023 --trials=1 --output=/tmp/raceiq-live.json
bun run bench:recorder --mode=recording --game=fm-2023 --trials=1 --speed=4 --output=/tmp/raceiq-recording.json
```

`--game` filters a canonical fixture; `--trials` controls measured scenario repetitions. Live scenarios retain nominal game-clock pacing at 1x/2x/4x, so even a single-trial live smoke takes fixture wall time. `both` combines in-memory imports and live replay. `--speed` and `--storage-root` apply to recording; disk imports also accept `--storage-root`. These temporary directories must be writable and are removed after each scenario.



## Recording reconciliation

Race reconciliation accumulates normalized packets without serializing or hashing every decoded packet. Persisted provenance retains raw capture identity and processing versions; the decoded-stream fingerprint is removed. Small `JSON.stringify` comparisons of derived result metadata and events remain.

Raw capture hashing, parser work, result derivation, and persistence remain separate costs. Benchmark consumer-only changes with identical inputs and compare complete observations/results; do not describe a consumer-only speedup as end-to-end recording finalization. Repeated reconciliation should remain unchanged, and partial-source failures must discard accumulated evidence before lap fallback.

A matched Bun experiment used `f1-2025-2026-04-09T21-34-10-190Z.bin.gz`, replaying 184,333 normalized packets into `RaceSourceAccumulator` with and without the old per-packet stringify/SHA256 work. Three sequential before/after pairs in fresh processes produced identical complete source observations and derived results. Median timed replay/accumulation was 4,851 ms with fingerprinting versus 567 ms without (88.3% less time). Fixture preparation, raw capture hashing, SQLite persistence, acquisition, and shutdown were excluded; filesystem cache remained enabled. This is one workload on Bun 1.4.2, not a general or end-to-end recording speedup.

## Process benchmark protocol

A child process loads one selected fixture, runs optional `setup()` once, performs unmeasured warmups, then executes exactly the requested measured iterations using `Bun.nanoseconds()`. It emits exactly one JSON report line on stdout. Fixture logs, diagnostics, and errors go to stderr so report parsing remains deterministic. Setup and fixture loading occur before measured work.

Timing and retained-heap sampling are independent:

- `--processes` controls timing children.
- `--retained-processes` controls retained-heap children and defaults to 5; CI uses 5 to bound fixture reload cost.
- The parent computes p50/p99 per timing child, then takes the median of those child summaries. Raw samples remain in the report.
- Retained-heap children with invalid or negative deltas are rejected, not clipped. The parent retries until the requested valid quota is met, up to `retainedProcesses * 4` attempts per alias. Rejections are recorded under `rawProcesses[*].retainedHeapErrors`; quota failure reports alias, quota, attempts, and rejection details.

The replay process suite performs adapter initialization and packet/envelope preflight before timing. Benchmark aliases must remain stable because comparator keys and CI reports consume them.

## Commands

Run focused contract coverage:

```sh
bun test apps/backend/test/tooling/process-bench.test.ts --timeout 60000
bun test scripts/test/tests/bench-compare.test.ts --timeout 60000
```

Run a small process smoke test:

```sh
bun run apps/backend/scripts/quality/process-bench.ts --processes=2 --retained-processes=7 --warmups=1 --iterations=5
```

Use `bun run bench` for parser/pipeline guardrails and `bun run bench:replay-io` for storage measurements. Do not fold benchmarks into ordinary test manifests; setup, inputs, and measured boundaries must stay explicit.
