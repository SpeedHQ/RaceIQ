# Disk-backed import benchmark

ADR: [Production disk-backed imports](../adr/0003-disk-recording-benchmark.md).

## Requirements

Benchmark imports from disk, including production capture writes, SQLite persistence, and finalisation. Replace the added UDP recording mode; preserve existing memory-only imports and concurrent live benchmarks. No UDP replay or production changes.

## Implementation

- Add `--mode=disk-imports`, using a fresh isolated process and real disk-backed database per trial.
- Read the canonical fixture from disk inside timing, then exercise the production import route with default sparse storage. Include upload staging, parse/detection, capture writes, lap derivation, database persistence, and import finalisation.
- Initialize database/game adapters and the selected engine before timing. Rust uses the optimized release recorder explicitly. Exclude process/engine setup, post-import validation, engine teardown, and cleanup.
- Validate persisted sessions/laps and decode saved captures outside timing. Reject missing artifacts, malformed output, failed imports, and nonzero child exit.
- Default to one warmup and five measured trials per game. Allow disk-import-only game, trial count, and storage-root options. Cover all six existing canonical fixtures, not only FM/F1.
- Report elapsed time, accepted packets, persisted captures/records/laps, and sampled process-tree CPU/RSS. OS cache remains enabled; file sizes are not physical device traffic or fsync durability evidence.

## Acceptance

Run both engines against complete canonical fixtures and observe finalized readable captures plus real persisted database rows. Typecheck changed backend benchmark. Exercise CLI validation and failed-storage exit behavior. Document commands, timing boundaries, and filesystem/cache limitations. Existing import/live mode defaults remain unchanged. No cross-engine semantic parity claim without supporting evidence.
