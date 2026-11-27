# Performance benchmarks

RaceIQ keeps performance measurements separate from ordinary tests. `bun run bench` runs parser/pipeline benchmarks; `bun run bench:replay-io` measures end-to-end replay storage and I/O. Process-isolated benchmark tooling lives in `apps/backend/scripts/quality/process-bench.ts` with fixtures under `test/benchmarks/`.

## Direct recording audit: timing and memory

### Implemented recorder versus `7023af6b8`

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
