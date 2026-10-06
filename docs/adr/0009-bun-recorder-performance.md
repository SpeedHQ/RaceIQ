---
status: proposed
---
# Extract Bun performance improvements without Rust migration

Rust migration is halted. Preserve its independently useful shared reconciliation optimization and measurement tooling without introducing native implementation or build requirements into main.

Extract decoded-packet fingerprint removal and adapt stage, memory, import and recording benchmarks to Bun-only operation. Retain raw capture identity and processing provenance. Benchmark tooling does not itself improve runtime performance; it enables scoped optimization and regression measurement.

Use the existing Mitata harness for parser/pipeline throughput rather than introducing a second hand-timed microbenchmark convention. Keep isolated memory sampling and paced end-to-end import/recording measurements separate because their lifetimes and timing boundaries differ.

Do not include native transport/range/allocator changes or speculative grid caching. Existing consumer-only measurements do not establish an end-to-end Bun recording speedup.

Plan: [Extraction requirements and verification](../plans/bun-recorder-performance.md).
