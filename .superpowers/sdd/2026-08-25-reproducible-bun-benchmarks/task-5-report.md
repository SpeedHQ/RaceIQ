# Task 5 report

## Changes

- Added `scripts/quality/process-bench.ts` parent runner for replay timing and retained-heap child processes.
- Aggregates finite timing p50/p99 and seven retained-heap samples; preserves raw process reports and runtime/CPU context in comparator-compatible JSON.
- Added comparator robust MAD diagnostics from preserved process timing reports without dropping or clipping samples.
- Rejects empty, non-numeric, infinite, NaN, and negative values for all three threshold flags, printing usage with the error.

## Verification

- `bun test test/tooling/bench-compare.test.ts --timeout 60000`: 12 pass, 0 fail.
- `bun run scripts/quality/process-bench.ts --suite=replay --revision=smoke --processes=7 --warmups=1 --iterations=1 --output=/tmp/replay-process-report.json`: succeeded.
- Smoke report: both replay keys have finite p50/p99 and exactly seven retained-heap samples; no `stats.heap`; no `alloc` text.
- `bun scripts/quality/bench-compare.ts /tmp/replay-process-report.json /tmp/replay-process-report.json --include=replay/ --fail-on-regression`: exit 0.
- Added paired-comparator tests for raw process report shapes, high-variance MAD diagnostics, and invalid threshold values (`NaN`, `Infinity`, negative, non-numeric, and empty).

## Concerns

With zero warmups, a child retained-heap sample can legitimately be negative under Bun GC timing and is rejected by the child contract. Smoke uses one warmup; invalid samples remain hard failures rather than clipped or hidden.
