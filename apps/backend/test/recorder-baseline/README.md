# Recorder behavioral baseline

Capture baseline before Bun recorder/detector cutover:

```sh
bun apps/backend/test/recorder-baseline/capture.ts --output=apps/backend/test/recorder-baseline/goldens/bun.json
```

Runner uses six real game fixtures plus existing Forza pit/race-off fixture from `fixtures.json`. It sets temporary `DATA_DIR` before dynamically importing runtime/test-support modules, then replays canonical captures, legacy IRIQDMP/LMUQDMP, and UDP frames through existing readers, parsers, and `LiveTelemetryPipeline`. The production `SparseSessionRecorderAdapter` writes into that isolated directory. Injected DB/WebSocket ports journal ordered session/lap insertion, deletion/retraction, and notifications. Test-local wrappers observe existing detector callback and provisional buffer without changing decisions. ACCTEST v2/v3 is explicitly marked unsupported because its current reader omits triplet source offsets. Segment markers are journaled and marked unsupported because live replay has no segment-control API; zero source records are also reported, never converted into fabricated parity.

Output includes fixture hashes, accepted/rejected source counts, telemetry signature digest, identity, ordered events with timing/validity/reason, source/output byte offsets and lap windows, sparse-byte and decoded-frame hashes, output header-count agreement, timestamped-frame count and timestamp hash. Ordered analysis samples and source windows use SHA-256 plus counts/endpoints to keep goldens compact; sample reordering changes those hashes. Capture paths/temp dirs omitted; deterministic CapturingDbAdapter sequence IDs retained for event/retraction references. Only Kunos synthesized `TimestampMS` and host `timestamp` are omitted from packet signatures; native timing remains preserved. `capturedAt` fixed.

Generated database `createdAt` values are omitted; native and deterministic database IDs remain preserved. Verify repeatability with two independent captures and `cmp`, not by comparing only aggregate lap counts.

Shared oracles listed in `fixtures.json`: sparse recorder tests `apps/backend/test/session-capture/{generic-sparse-recorder,kunos-sparse-recorder,lmu-sparse-recorder}.test.ts`, iRacing delayed-native-timing test `packages/game-iracing/test/e2e/iracing-recording-fixture.test.ts`, Forza provisional fixture test `apps/backend/test/telemetry/pipeline-live-issues.test.ts`.

## End-to-end performance baseline

Build optimized Rust release recorder once with `cargo build --release --locked --manifest-path native/recorder/Cargo.toml`, then run each engine without other build/test workloads:

```sh
bun run bench:recorder --engine=bun --mode=imports --output=.omp/checkpoints/recorder-bun-imports.json
bun run bench:recorder --engine=rust --mode=imports --output=.omp/checkpoints/recorder-rust-imports.json --baseline=.omp/checkpoints/recorder-bun-imports.json
```

Import mode preloads each canonical fixture into memory once and runs one warmup plus 20 measured trials per game. Bun uses production import parsing/detection with an in-memory DB adapter and null recorder; Rust uses the optimized release binary’s production decoder, parser, and detector through a persistent benchmark worker. Per-trial import results remain in memory; import timing excludes fixture file reads, backend startup, database writes, capture writes, and cleanup. Reports include input hashes, elapsed processing time, packet/lap outcomes, and engine-specific CPU/RSS estimates; those resource estimates are not directly comparable.

Import mode does not use HTTP routes, persisted SQLite rows, or capture files. Live mode retains FM/F1 UDP at native game-clock cadence proxies (1×/2×/4×), seeds an analysis session before timing, concurrently imports the same fixture, and exercises scoped review plus semantic-telemetry analysis HTTP routes. Seed and concurrent imports use `others` ownership; live recordings use `mine`. Finalized live capture/lap counts select persisted `mine` sessions, including sessions without laps. Legacy iRacing/LMU source counts use their original dump readers rather than canonical-only framing.

MoTeC, IBT, DuckDB/WAL, and ZIP archive import paths are intentionally excluded; this benchmark compares one canonical capture import per game, not every import format. Generated test fixtures are not substituted for unavailable real captures. Windows acquisition, acquisition-to-write/dashboard latency, receive/drop counters, and durability are not proved by this host replay. Sampled process-tree CPU/RSS and HTTP latency are estimates, not exact totals or dashboard latency.
