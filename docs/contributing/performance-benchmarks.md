# Performance benchmarks

RaceIQ keeps performance measurements separate from ordinary tests. `bun run bench` runs parser/pipeline benchmarks; `bun run bench:replay-io` measures end-to-end replay storage and I/O. Process-isolated benchmark tooling lives in `scripts/quality/process-bench.ts` with fixtures under `test/benchmarks/`.

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
bun test test/tooling/process-bench.test.ts --timeout 60000
bun test test/tooling/bench-compare.test.ts --timeout 60000
```

Run a small process smoke test:

```sh
bun run scripts/quality/process-bench.ts --processes=2 --retained-processes=7 --warmups=1 --iterations=5
```

Use `bun run bench` for parser/pipeline guardrails and `bun run bench:replay-io` for storage measurements. Do not fold benchmarks into ordinary test manifests; setup, inputs, and measured boundaries must stay explicit.
