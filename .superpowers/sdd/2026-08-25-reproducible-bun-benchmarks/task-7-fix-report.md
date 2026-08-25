# Task 7: Fix process benchmark report keys

## Change

`process-bench.ts` now emits comparator benchmark entries with `group: 0` and short aliases under the `replay` layout, producing exact keys `replay/parse 20,000 raw lap frames` and `replay/resolve 20,000 canonical envelopes`. Raw per-process timing and retained-heap maps keep full composite keys for diagnosis.

## Verification

- `bun run typecheck:scripts` passed.
- `bun test test/tooling/bench-compare.test.ts --timeout 60000` passed: 12 tests, 0 failures.
