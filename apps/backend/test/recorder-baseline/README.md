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

Run `bun run bench:recorder --engine=bun --mode=both --output=.omp/checkpoints/recorder-bun-baseline.json` without other build/test workloads. Every supported case uses one warmup and five measured trials in isolated data directories; reports retain individual trials and fixture hashes.

Imports use actual HTTP routes and persisted SQLite rows/files. Live trials use FM/F1 UDP at native game-clock cadence proxies (1×/2×/4×), seed an analysis session before timing, concurrently import the same fixture, and exercise scoped review plus semantic-telemetry analysis HTTP routes. Seed and concurrent imports use `others` ownership; live recordings use `mine`. Finalized live capture/lap counts select persisted `mine` sessions, including sessions without laps, so imported empty sessions cannot inflate live counts. Legacy iRacing/LMU source counts use their original dump readers rather than canonical-only framing.

Missing original IBT, DuckDB/WAL, and RaceIQ ZIP fixtures remain explicit benchmark blockers; generated test fixtures are contract evidence only. Windows acquisition, acquisition-to-write/dashboard latency, receive/drop counters, and durability are not proved by this host replay. Sampled process-tree CPU/RSS and HTTP latency must not be relabeled as exact resource totals or dashboard latency.
