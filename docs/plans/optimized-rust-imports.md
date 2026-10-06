# Optimize Rust telemetry imports

Decision record: [Optimized Rust import data flow](../adr/0002-optimized-rust-imports.md).

## Requirements

Optimize production Rust recorder/importer using allocation-conscious Rust practices. Preserve accepted packet cadence, session boundaries and identity, lap timing/validity/reasons, source offsets and analysis recipes, supported capture formats, and full live telemetry output. Do not optimize by dropping telemetry or narrowing benchmark work. Preserve existing user changes. No compatibility aliases or separate legacy implementation.

## Design and ownership

- F1/ordinal owner: use typed detector-facing data without constructing presentation JSON on the production import path; keep full telemetry materialization for live consumers. Store only detector-required fields per sample. Own games/f1.rs, games/mod.rs, detection/ordinal.rs and necessary detector/import dispatch changes. Shared public APIs remain usable by live/replay callers; migrate changed callers.
- LMU owner: preindex catalog resolution with unchanged ambiguity/tier semantics; cache unchanged identity, use generated layout constants instead of dynamic JSON field lookup, and borrow decoded source-frame slices rather than copying shared memory. Own games/lmu.rs and games/catalog.rs.
- Kunos owner: remove previous/incoming packet deep copies and whole-lap copies; retain compact typed policy samples, borrow full boundary append packets, and preserve existing logical sample cadence and exact recipe semantics. Own detection/kunos.rs.
- Integration owner: remove decoder checkpoint frame cloning by referring to already-owned decoded records; represent sparse source identity as borrowed typed data instead of formatting temporary strings. Preserve checkpoint-distance and source-identity validation.

No changes to detector policy or wire/source schemas. Avoid speculative tuning, unsafe code, per-frame reference counting, and benchmark-only shortcuts.

## Verification

Capture stable complete pre-change Rust results on six canonical fixtures, excluding only generated engineSessionId fields. Build optimized release once after workers finish. Run Rust suite and affected project contract tests. Exercise actual persistent production import worker on every fixture, compare complete semantic digests including ordered events/recipes to baseline, and measure one warmup plus multiple trials. Verify full live F1 packet path and detector-facing projection against same source stream. Keep evidence under .omp/evidence/optimized-rust-imports/. Update recorder performance documentation and Unreleased changelog after proof.

## Further optimization and memory comparison

Profile remaining production-path costs against the current optimized release, then remove demonstrated redundant parsing, allocation, or copying without changing six-fixture outcomes. Prioritize ACC and iRacing; retain improvements only with measured evidence. Native implementation owner owns Rust modules. Benchmark owner owns `apps/backend/test/benchmarks/recorder.bench.ts` and its benchmark helpers; no shared edits.

Display Bun and Rust memory usage, absolute MiB difference, and percentage difference alongside import timing. Use matching isolated-process RSS measurement boundaries for new comparisons; label RSS as sampled process footprint, not allocated bytes. Reject or explicitly mark legacy reports whose measurement methods differ. Keep timing boundaries unchanged and exclude memory instrumentation from timing trials where it perturbs throughput.

Capture before/after complete Rust outcomes and fresh timing/memory reports for all six fixtures. Verify ordered events, identity, lap validity/timing, offsets, ranges, overrides, and append packets after normalizing only generated session IDs. Run applicable native and benchmark gates once after implementation, smoke actual benchmark output, then update benchmark README and changelog. Evidence and current progress belong under `.omp/evidence/rust-import-performance-memory/` and `.omp/checkpoints/rust-import-performance-memory.md`.

## Typed production hot-path cutover

The next pass removes dominant redundant work rather than stopping at per-packet micro-optimizations. Use typed detector inputs for ACC, AC Evo, and iRacing; avoid dynamic presentation maps, formatted keys, per-sample identity strings, and repeated SDK variable-name lookup in detection. Borrow source bytes and immutable metadata where lifetimes permit. Preserve complete live/replay telemetry and materialize full Kunos boundary append packets only when required. Preserve iRacing delayed authoritative timing, original deferred cadence, LastLap overrides, identity changes, and EOF/inactivity behavior through compact typed retained state.

Ownership: Kunos owner edits `games/kunos.rs` and `detection/kunos.rs`; iRacing owner edits `games/iracing.rs`, `detection/iracing.rs`, and necessary typed ordinal interfaces in `detection/ordinal.rs`; decoder owner edits `formats/` and `imports/` to remove measured record-copy/retention and result-tree duplication costs. Coordinator owns shared parser/detector dispatch, integration, plan/ADR/checkpoint, and verification. Keep one implementation for each policy; full-JSON input adapters share typed state transitions, not duplicated detector implementations.

No unsafe code, alternate benchmark-only parser, dropped output, approximate policy, or speculative parallelism. Avoid heap allocation in steady-state detector input and SDK scalar projection unless source schema/state changes require it. Keep exact numeric and missing-field semantics. Exercise typed/full packet paths on canonical fixtures and focused transition regressions; compare complete six-fixture outcomes against the previous verified artifacts. Build and run project gates after worker integration, then measure release throughput and isolated RSS using existing benchmark commands. Evidence lives under `.omp/evidence/rust-typed-hotpaths/`; reuse `.omp/checkpoints/rust-import-performance-memory.md`.
