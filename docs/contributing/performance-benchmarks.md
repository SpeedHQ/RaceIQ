# Performance benchmarks

RaceIQ keeps performance measurements separate from ordinary tests. `bun run bench` runs parser/pipeline benchmarks; `bun run bench:replay-io` measures end-to-end replay storage and I/O. Process-isolated benchmark tooling lives in `apps/backend/scripts/quality/process-bench.ts` with fixtures under `test/benchmarks/`.

## Bun/Rust processing stages

```sh
cargo build --release --locked --manifest-path native/recorder/Cargo.toml
cargo build --release --locked --manifest-path native/recorder/Cargo.toml --features benchmark-memory --bin raceiq-pipeline-memory
bun run bench:pipeline-stages --engine=both --output=.omp/evidence/pipeline-stage-benchmark/paired.json
```

This companion to the original `pipeline.bench.ts` separately times full-presentation raw-frame parsing and processing of pre-parsed packets. Defaults: six canonical recorder fixtures, up to 10,000 source frames each, one warmup and 20 measured trials per stage. The FM fixture's first active packet is at index 5,218; a 5,000-frame prefix has no accepted packets.

Options: `--engine=bun|rust|both`, `--game=fm-2023|f1-2025|acc|ac-evo|iracing|lmu`, `--trials=1..100`, `--frames=<positive integer>`, `--memory=on|off` (default `on`), and required `--output=<path>`. A prefix with no accepted packets fails rather than reporting an empty processing sample.

Fixture reads/decompression/framing, native IPC/base64, initial parser state, packet preparation/cloning, and pipeline/detector construction are outside timers. Context frames seed parsers without entering processing; segment boundaries reset parser state and split processing chunks. Both engines use fresh processing state per at-most-500 accepted packets, with each chunk's final/incomplete flush timed. Console logging is suppressed as in the original benchmark. This bounded policy is not a continuous-session benchmark.

Bun measures `LiveTelemetryPipeline` orchestration/normalization with null DB, WebSocket, and recorder adapters; Rust measures full `GameParser` parsing and production `Detector`/event processing in a release binary. No measured UDP replay, capture writes, database persistence, or shutdown. Engines run sequentially; JSON includes runtime/build provenance, fixture/workload hashes, raw samples, medians, accepted/processed counts, and count mismatches. Parse rates use source frames; processing rates use each engine's accepted packets. Equal input does not establish equal output/features; count mismatches and differing processing scopes preclude an unqualified speedup claim. Existing import/live/disk benchmarks remain separate.

Timings follow the awaited `processPacket`/`flushIncompleteLap` boundaries in Bun and detector feed/finish boundaries in Rust. Detached Bun followups are not a full-finalization completion guarantee.

After **all throughput trials** finish, the default memory pass runs one fresh process per selected game/engine, with three profile windows using the same frame limit and processing chunks. Profile timings are discarded. Terminal output shows stage timing medians and **median end-of-stage retained additional MiB** for both engines. Separate diagnostics label Bun **sampled post-GC maxima** and Rust **allocation peaks**, not equivalent peaks. JSON method `stage-code-memory-v4` releases completed chunk state before processing the next chunk and retains only final chunk state at stage end; every trial starts fresh. State construction remains outside throughput timing; cleanup of previous chunk state is timed. Parser state stays live but transient returned parse outputs are released. `--memory=off` prints `n/a`. Dedicated `raceiq-pipeline-memory` profiles leave production/throughput binaries uninstrumented.

Memory baselines follow fixture loading/decoding; processing baselines also follow preparation/cloning of full input packets. Loaded fixture buffers, prepared packets, IPC/base64, and report serialization are excluded. Parser/detector/pipeline state construction and stage work are included. Rust reports peak additional live **requested Rust allocation bytes**, excluding allocator overhead and direct C allocations. Bun reports **sampled post-GC live-heap growth** at bounded frame/chunk boundaries, holding current state/output alive; it misses temporary allocations between samples and is not exact allocator accounting. Ordinary Bun heap counters stay stale between collections and cannot measure transient peaks. Methods and engine processing scopes differ; do not compare these numbers as equivalent allocator peaks. Profile failures are explicit nonzero errors, never zero-valued memory substitutes. No RSS metrics or whole-process footprint claims.

Retained values are nonnegative **net growth above the prepared-input baseline**, not absolute state sizes. Zero means no net growth detected, not zero memory use: GC/runtime changes can offset allocations. Parser/pipeline state remains live at the final sample; transient returned parse outputs are released. Accounting and processing scopes still differ between engines.

“Parse” includes full presentation-object materialization, not only binary decoding. Rust constructs owned `serde_json::Value` maps and nested values; compact detector-facing parsing is a different workload and must not replace this stage silently.

### Full-output fixture gate

Before changing production parsers or detectors, capture a release baseline:

```sh
cargo build --release --locked --example pipeline-fixture --manifest-path native/recorder/Cargo.toml
bun apps/backend/test/benchmarks/pipeline-fixture-verify.ts --self-test
bun apps/backend/test/benchmarks/pipeline-fixture-verify.ts baseline
```

After changes, rebuild the example and run `bun apps/backend/test/benchmarks/pipeline-fixture-verify.ts verify`. Baseline mode overwrites its six files under `.omp/evidence/rust-pipeline-optimization/`; never recapture them after optimization to hide differences. Verify binds fixture and decoded-workload hashes and compares every accepted full packet, source-frame index/offset, and detector feed/final-flush event for the same 10,000-frame prefixes and 500-packet chunks. Only object-key order is ignored; fields, numbers, nulls, array order, acceptance and events must match.

The runner also reports Bun/native full-packet differences separately. Existing zero-capacity F1 optional-field and Kunos wall-clock/capture-timestamp differences are not normalized into false parity. This gate preserves native semantics; it does not establish cross-engine detector equivalence or verify packets beyond the selected prefix. Use whole-capture import verification and existing canonical fixture tests alongside it.

Native presentation maps use dense insertion-ordered storage with capacity reservations; F1 numeric state uses fixed arrays where layouts are fixed and reuses owned history sector maps. JSON object key order is not a wire contract. Measure the unchanged full-presentation stage rather than substituting the compact import path.


### Recording reconciliation

Race reconciliation streams normalized packets into its accumulator without serializing or hashing every decoded packet. Persisted provenance retains raw capture identity and processing versions; it no longer includes a decoded-stream fingerprint. Remaining `JSON.stringify` comparisons operate on derived result metadata and events, not the telemetry stream. Native JSON encoding and host JSON decoding remain separate replay costs.

Evaluate consumer-only improvements with identical native output and compare complete race-source observations and derived results before/after. Include actual native replay, raw capture hashing and SQLite persistence in a separate reconciliation smoke; do not label a consumer-only speedup as end-to-end recording finalization.


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
