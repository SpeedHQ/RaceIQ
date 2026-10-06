# Performance benchmarks

RaceIQ keeps performance measurements separate from ordinary tests. `bun run bench` runs parser/pipeline benchmarks; `bun run bench:replay-io` measures end-to-end replay storage and I/O. Process-isolated benchmark tooling lives in `apps/backend/scripts/quality/process-bench.ts` with fixtures under `test/benchmarks/`.

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

## Bun recorder workloads

`bun run bench:recorder` supports in-memory imports, persistent file imports, live UDP replay, and recording completion. Select `--mode=imports|disk-imports|live|both|recording` and provide `--output=<path>`. Reports include fixture hashes, packet/lap outcomes, measured trials, and explicit storage/resource scopes. Benchmark data uses isolated temporary directories.

The `imports` workload runs the production lap-index parser and detector through an isolated `LiveTelemetryPipeline` with captured in-memory session/lap outcomes. It includes decompression, framing, parser construction, and processing. Fixture reads and module initialization are outside the timer. Database and capture persistence, history seeding, developer-state updates, reconciliation, and acquisition are excluded; this is not the persistent `importSessionBin` API. Separate fresh-process memory trials measure whole-process resources, not parser allocations.

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
