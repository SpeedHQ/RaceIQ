Goal: Compare memory-only Bun/Rust parser+detector with one canonical fixture/game and 20 measured runs/game.
Acceptance: Preload fixtures; one warmup + 20 measured imports/game; outputs stay in memory; no per-trial server/storage/DB writes; compare per-game semantic hashes and report measured time/CPU/RSS without invented claims.
Workspace: /Users/acoop/orca/workspaces/RaceIQ/rust-recorder
Checkpoint: /Users/acoop/orca/workspaces/RaceIQ/rust-recorder/.omp/checkpoints/recorder-benchmark.md
Constraints: User replaced earlier file-output requirement: benchmark inputs and semantic outputs memory-resident. Bun uses production importer/parser/detector; Rust uses production decoder/parser/detector. CPU/RSS methods differ and estimates are not directly comparable.

[x] Memory-only benchmark runner, warmup + 20 trials/game, persistent Rust worker, engine-specific estimates.
[x] Fixed Bun isolation: DB setup writes delegated through DbAdapter; memory imports skip history seeding. `bun run typecheck` passed.
 [x] Bun and Rust each completed 20 measured memory-only imports for all six fixtures. Reports: `.omp/checkpoints/recorder-bun-imports-20-outcomes.json`, `.omp/checkpoints/recorder-rust-imports-20-outcomes.json`.
 [x] Timing/CPU/RSS estimates recorded per case. Rust timings exceed Bun across all six; CPU/RSS methodologies differ and are not directly comparable.
 [x] Compared normalized results structurally: packet and lap counts match each game; outcome details differ on all six. Rust iRacing marks laps invalid where Bun marks valid; Rust normalized lap car/track IDs are null while Bun carries IDs. Do not claim parity or comparative speedup.
 [x] Updated outcome SHA-256 serialization to sort object keys; `bun run typecheck` passed. Prior report hashes predate this change.
 [x] Changelog/README describe 20 trials. Changelog test: 11 pass.
 [ ] Next: decide whether outcome parity work belongs to separate task; report current measured results and blockers.
 Relevant: `apps/backend/test/benchmarks/recorder.bench.ts`, `apps/backend/test/recorder-baseline/README.md`, `CHANGELOG.md`.
 Decisions: 20 measured imports/game; optimized Rust release binary; no claims of cross-engine semantic parity. Resource metrics are estimates and CPU/RSS methods differ.
 Blockers: normalized outcomes differ on every game, including validity and car/track identity fields. Stable-hash change not reflected in saved benchmark report.
