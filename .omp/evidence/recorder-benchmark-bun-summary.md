# Recorder import benchmark evidence

Command: `bun run bench:recorder --engine=bun --mode=imports --output=.omp/checkpoints/recorder-bun-imports.json`

Completed 2026-10-05. Each available import fixture has one warmup and 100 measured runs. Values are median elapsed seconds, median sampled process-tree CPU lower-bound seconds, and median sampled peak process-tree RSS bytes.

| Import case | Trials | Elapsed s | CPU lower bound s | Peak RSS bytes |
|---|---:|---:|---:|---:|
| FM 2023 | 100 | 0.109890416 | 0.25 | 312918016 |
| F1 2025 | 100 | 9.258528583 | 9.93 | 2094448640 |
| ACC | 100 | 0.922151125 | 1.23 | 945913856 |
| AC Evo | 100 | 0.299059334 | 0.51 | 567410688 |
| iRacing | 100 | 0.320597833 | 0.55 | 508461056 |
| LMU | 100 | 0.310047166 | 0.52 | 440172544 |
| MoTeC ZIP | 100 | 1.230564541 | 1.67 | 575193088 |

Blocked due to absent originals: IBT, DuckDB/WAL, RaceIQ multi-capture ZIP. Existing full per-trial output, fixture hashes, import outcomes, input/persisted capture metrics: `.omp/checkpoints/recorder-bun-imports.json`.

Resource caveat: CPU is a 100ms `ps` process-tree sampled lower bound; RSS is sampled peak. Neither is exact. Rust benchmark was invoked separately and rejected because bundled Rust production engine/client is unimplemented; no Rust numbers exist.