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

Import mode preloads each canonical fixture into memory once and runs one warmup plus 20 measured trials per game. Bun uses production import parsing/detection with an in-memory DB adapter and null recorder; Rust uses the optimized release binary’s production decoder, parser, and detector through a persistent benchmark worker. Per-trial import results remain in memory; import timing excludes fixture file reads, backend startup, database writes, capture writes, and cleanup. Reports include input hashes, elapsed processing time, packet/lap outcomes, and engine-specific CPU/RSS estimates. Those throughput-trial resource estimates are not directly comparable; separate isolated-process RSS measurements provide the memory comparison below.

### Optimized Rust import path

Production imports construct typed F1, Kunos, and iRacing detector inputs instead of materializing full presentation JSON per packet. Detectors retain compact policy samples and source offsets; full Kunos boundary append packets and existing logical sample cadence remain unchanged. Live and replay consumers still receive complete telemetry JSON. LMU uses indexed catalog resolution, parser-local identity caching, generated layout constants, and borrowed source-frame slices. The shared lending capture decoder borrows raw payloads and reconstructs sparse chains in one reusable buffer.

Release-worker verification used the same six canonical fixtures, one warmup and 20 measured imports per fixture, with no concurrent build/test workload. Previously reported medians are retained as the comparison baseline; Bun was not rerun:

| Fixture | Reported Bun median | Reported Rust median | Optimized Rust median |
| --- | ---: | ---: | ---: |
| FM 2023 | 0.006 s | 0.009 s | 0.011 s |
| F1 2025 | 0.648 s | 7.109 s | 0.399 s |
| ACC | 0.109 s | 0.830 s | 0.404 s |
| AC Evo | 0.046 s | 0.133 s | 0.075 s |
| iRacing | 0.046 s | 0.143 s | 0.134 s |
| LMU | 0.031 s | 1.283 s | 0.099 s |

All six complete Rust result hashes match the pre-change baseline after removing only generated `engineSessionId` fields. Comparison includes ordered events, identities, lap times, validity/reasons, source offsets, ranges, overrides, and full append packets—not just lap counts. The canonical F1 typed/full parser check also accepts the same 184,333 packets and emits identical detector events. F1 is now faster than the reported Bun median; other fixtures still favor Bun. Small FM timings showed no improvement. Rust/Bun outcome schemas and persistence work differ, so timing comparisons alone do not establish cross-engine lap-result parity.

Detailed trial timings and hashes: `.omp/evidence/optimized-rust-imports/optimized.json`. Reproduce timing with the import benchmark command above; exercise typed/full F1 behavior with `cargo test --release --locked --manifest-path native/recorder/Cargo.toml canonical_f1_fixture_typed_full_equivalence -- --ignored`.

### Further optimization and memory comparison

ACC caches catalog identity resolution until car or track names change, preserving current source ordinals for unresolved names. iRacing uses static tire source/output field names instead of formatting them per packet. Complete normalized Rust results remain identical for all six fixtures, including ordered events and full analysis recipes.

Fresh measurements: one warmup plus 20 throughput trials per fixture and engine. Memory uses one separate fresh process per fixture, with the same own-PID `ps` RSS sampler at 100 ms plus initial/final snapshots. Bun's child preloads input and retains its import outcome through the final snapshot; Rust's footprint also includes stdio/base64 request handling and result serialization. These are sampled whole-process footprints, not allocator peaks or identical cross-engine outcome schemas. Brief peaks can be missed. Idle RSS is reported for context, not subtracted as allocated memory. Memory sampling does not overlap throughput trials.

| Fixture | Bun median | Rust median | Bun RSS MiB | Rust RSS MiB | Rust − Bun MiB | RSS difference |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| FM 2023 | 0.005 s | 0.010 s | 110.6 | 17.4 | -93.2 | -84.3% |
| F1 2025 | 0.633 s | 0.353 s | 1200.0 | 929.6 | -270.3 | -22.5% |
| ACC | 0.109 s | 0.319 s | 304.9 | 200.4 | -104.5 | -34.3% |
| AC Evo | 0.040 s | 0.064 s | 245.8 | 140.8 | -105.0 | -42.7% |
| iRacing | 0.049 s | 0.097 s | 194.4 | 44.2 | -150.2 | -77.2% |
| LMU | 0.029 s | 0.085 s | 189.6 | 46.2 | -143.4 | -75.6% |

The separate unsampled before/after Rust timing series measured ACC at 0.440 → 0.328 s and iRacing at 0.148 → 0.101 s. Untouched games also varied between runs, so these observations are not isolated causal speedup estimates. Bun remains faster on the non-F1 fixtures.

Run the commands above with a fresh Bun report as `--baseline` for Rust. Terminal output shows baseline/current RSS and absolute/percentage differences; JSON keeps the stable `memoryMethod`, individual memory results, and comparison observations. Old reports lacking the matching method show `N/A (incomparable)` rather than misleading RSS deltas.

Evidence: `.omp/evidence/rust-import-performance-memory/{bun,rust,summary,native-before-timing,native-after-timing}.json`. Reusable complete-result check: `bun .omp/evidence/rust-import-performance-memory/capture-results.ts verify`. The changed ACC/iRacing production replay/import contracts also pass.

### Typed production hot-path cutover

Kunos advances parser state once and borrows source/static storage; full presentation is materialized only for actual boundary append packets during import detection. iRacing preindexes SDK scalar handles at schema changes and retains compact deferred samples instead of packet JSON. Full-input adapters share these same detector transitions. The existing literal-key authoritative timing gate is preserved, including its distinction from nested presentation fields.

Production import and replay use the same lending decoder as the owned decoder wrapper: raw frames borrow input, sparse frames reuse reconstruction storage, plain inputs remain borrowed, and gzip retains only decompressed bytes. Imports no longer retain an expanded source-record vector. Result construction moves trees where possible; schema-required duplicate event/lap information remains unchanged.

Fresh one-warmup/20-trial throughput reports and separate own-PID sampled RSS runs:

| Fixture | Bun median | Rust median | Bun RSS MiB | Rust RSS MiB | Rust − Bun MiB | RSS difference |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| FM 2023 | 0.006 s | 0.008 s | 111.9 | 14.0 | -97.9 | -87.5% |
| F1 2025 | 0.694 s | 0.298 s | 1160.3 | 574.3 | -586.0 | -50.5% |
| ACC | 0.101 s | 0.050 s | 303.1 | 72.1 | -231.0 | -76.2% |
| AC Evo | 0.047 s | 0.016 s | 246.1 | 81.9 | -164.1 | -66.7% |
| iRacing | 0.052 s | 0.019 s | 196.6 | 40.1 | -156.5 | -79.6% |
| LMU | 0.038 s | 0.085 s | 173.1 | 42.0 | -131.2 | -75.8% |

The matched unsampled Rust-only before/after series measured F1 at 0.381 → 0.308 s, ACC at 0.340 → 0.054 s, AC Evo at 0.069 → 0.017 s, and iRacing at 0.100 → 0.019 s. FM and LMU showed no meaningful improvement in that series. Rust now measures faster than Bun for F1, ACC, AC Evo, and iRacing; FM and LMU still favor Bun. These are workload observations, not an isolated language comparison or identical cross-engine result schemas. RSS limitations above still apply.

Evidence: `.omp/evidence/rust-typed-hotpaths/{bun,rust,summary,before,after,verify}.json`. `summary.json` compares both fresh reports; the Rust CLI report's embedded comparison references the preceding Bun report. Reproduce complete-result parity with `bun .omp/evidence/rust-typed-hotpaths/verify-imports.ts verify`. Run canonical typed/full F1, Kunos, and iRacing checks with `cargo test --release --locked --manifest-path native/recorder/Cargo.toml canonical_ -- --ignored`. All six complete Rust outcomes match the previous verified baseline. Production replay/import checks pass for all six games plus MoTeC ZIP, including complete lap recipes and storage metadata.


### Separate parsing and pre-parsed processing

```sh
cargo build --release --locked --manifest-path native/recorder/Cargo.toml
bun run bench:pipeline-stages --engine=both --output=.omp/evidence/pipeline-stage-benchmark/paired.json
```

This comparison mirrors the original Bun benchmark's separate stages, not the memory-only whole-import workload above. Defaults: up to 10,000 source frames per canonical fixture, one warmup plus 20 measured trials per stage; fresh processing state per 500 accepted packets, final flush included. Fixture loading, native IPC, packet preparation/cloning, and initial state construction are untimed; console logging is suppressed. No disk persistence, UDP pacing, or shutdown in measured work.

Bun times full-presentation parsing and `LiveTelemetryPipeline` orchestration; release Rust times full-presentation `GameParser` parsing and `Detector`/event processing. JSON retains raw timings, median rates, source/workload hashes, and per-engine accepted/processed counts. Architectural scopes and packet-count differences are explicit; this does not establish feature/semantic parity or continuous-session performance. Options and boundaries: [Performance benchmarks](../../../../docs/contributing/performance-benchmarks.md#bunrust-processing-stages).

Memory reporting defaults on and runs separately after all timing trials: fresh process per game/engine, one warmup plus three profile trials, same workload/chunks. The terminal table lists baseline and sampled peak MiB; JSON records own-engine PID RSS bytes/MiB, target/host PIDs and method. Rust excludes its Bun host. POSIX `ps` samples approximately every 100 ms plus initial/final snapshots; peaks include runtime, input/preparation and both stages, not isolated heap allocation. Short peaks may be missed; processing/output scopes differ. Use `--memory=off` for timing-only runs.

### Production disk recording

```sh
bun run build:recorder
bun run bench:recorder --engine=bun --mode=recording --storage-root=/path/on/target/disk --output=.omp/evidence/recording-bun.json
bun run bench:recorder --engine=rust --mode=recording --storage-root=/path/on/target/disk --output=.omp/evidence/recording-rust.json --baseline=.omp/evidence/recording-bun.json
```

Recording mode launches an isolated production backend for each trial, selects the requested recorder engine, and replays the canonical FM/F1 UDP captures. Unlike `live`, it does not seed/import sessions or run concurrent import/review/analysis requests. Production capture writers and SQLite persist real recordings under a fresh temporary directory on `--storage-root` (default: OS temporary directory). Trial directories are removed after validation; JSON reports remain.

Like existing `live` mode, this starts the backend from source. The runtime selects the Rust **debug** binary built by `build:recorder`; building only the release binary for memory-import benchmarks does not prepare recording mode. These runs exercise production recording code and persistence, but do not measure optimized packaged-release performance.

Lifecycle verification used one warmup plus one measured trial/game at 4x. Bun FM/F1 and Rust FM produced readable finalized captures. Rust F1's accelerated debug run failed with `terminal source queue exhaustion: payload queue or byte bound exceeded`; this is a failed recording case, not a valid performance sample. The harness preserves backend diagnostics and cancels replay when the backend exits. Reports: `.omp/evidence/disk-recording-benchmark/{bun,rust,rust-f1-diagnostic}.json`.

Default: one warmup plus five measured trials per game at 1x game-clock cadence. Recording-only options: `--game=fm-2023|f1-2025`, `--trials=<positive integer>`, `--speed=<positive multiplier>`, and `--storage-root=<directory>`. For a focused smoke run:

```sh
bun run bench:recorder --engine=bun --mode=recording --game=fm-2023 --trials=1 --speed=4 --output=.omp/evidence/recording-smoke.json
```

Each sample reports:

- `replayWriteSeconds`: source fixture read/decoding, paced UDP replay, and overlapping production writes.
- `receiveDrainSeconds`: actual elapsed time for a 400 ms receive-drain allowance after the sender finishes.
- `finalizationSeconds`: SIGINT to clean backend exit, including production recording finalisation and backend shutdown.
- `elapsedSeconds`: sum of those three phases. Startup, post-shutdown validation reads, report writes, and cleanup are excluded.
- Finalized capture bytes/records, persisted session/lap counts, sampled process-tree peak RSS, and sampled CPU lower bound. Reports retain individual samples and phase medians; `--baseline` compares matching game/speed keys.

Forced/nonzero shutdown, missing finalized session captures, and empty/unreadable capture output fail the trial; recording mode exits nonzero for failed or blocked cases. Validation reads saved `mine` sessions and capture files after backend exit.

This measures the production recording lifecycle, not isolated device bandwidth: pacing dominates elapsed time at 1x. OS page cache is enabled; reported capture bytes are logical output sizes, not physical disk traffic or fsync durability proof. Choose the target filesystem explicitly; a RAM-backed temporary directory does not measure physical disk. Faster replay increases load and may lose UDP packets; sender completion and the drain allowance do not prove every datagram was received. Sparse output record counts need not equal datagrams sent. Shared-memory acquisition for ACC, AC Evo, iRacing, and LMU still requires Windows; host coverage here is FM/F1 UDP only.

Import mode does not use HTTP routes, persisted SQLite rows, or capture files. Live mode retains FM/F1 UDP at native game-clock cadence proxies (1×/2×/4×), seeds an analysis session before timing, concurrently imports the same fixture, and exercises scoped review plus semantic-telemetry analysis HTTP routes. Seed and concurrent imports use `others` ownership; live recordings use `mine`. Finalized live capture/lap counts select persisted `mine` sessions, including sessions without laps. Legacy iRacing/LMU source counts use their original dump readers rather than canonical-only framing.

MoTeC, IBT, DuckDB/WAL, and ZIP archive import paths are intentionally excluded; this benchmark compares one canonical capture import per game, not every import format. Generated test fixtures are not substituted for unavailable real captures. Windows acquisition, acquisition-to-write/dashboard latency, receive/drop counters, and durability are not proved by this host replay. Sampled process-tree CPU/RSS and HTTP latency are estimates, not exact totals or dashboard latency.
