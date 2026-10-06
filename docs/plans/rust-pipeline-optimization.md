# Rust pipeline optimization

ADR: [Preserve fixture semantics while optimizing](../adr/0005-rust-pipeline-optimization.md).

## Requirements

First verify Rust output still matches canonical input fixtures. Then aggressively optimize production parsing and detector processing, retaining full presentation output, packet acceptance, state resets, timestamps, detector events and import manifests. Preserve unrelated workspace changes; no commits requested.

## Approach

1. Verify existing six-fixture complete normalized import manifests. Add a release differential harness capturing full parser outputs and detector events from identical decoded fixture records before changes. Compare all fields, nulls and ordering after changes; normalize only object-key order and documented nondeterministic identifiers. Compare Bun output where contracts agree and disclose existing differences rather than masking them.
2. Measure unchanged release stages on all six canonical fixtures, 10,000 source frames, one warmup and 20 trials, memory sampling separate.
3. Optimize measured presentation allocation/state work and detector hot paths. Keep benchmark workload and full-output contract unchanged. Retain only measured improvements; avoid unsafe decoding or algorithmic shortcuts.
4. Run release differential fixture verification, existing Rust tests, backend typecheck when affected, full import-manifest comparison, and paired stage/memory benchmark. Document scope, speedups and limits.

## Acceptance

Pre-change fixture correctness evidence exists before production edits. Post-change full packets/events and complete normalized import manifests equal pre-change outputs for all six fixtures. Release runtime demonstrates measured improvement, with regressions investigated and rejected changes reverted. Existing gates pass. No claims of Rust/Bun feature equivalence from detector-only timings.
