# Task 4 report

Status: complete.

## Files

- Added `test/benchmarks/replay-process-bench.ts` with fixed capture loading, adapter initialization, packet/envelope preflight assertions, exact aliases, and deterministic `REPLAY_BENCH_CASE` selection.
- Removed replay fixture loading, Mitata timing group, and retained registration from `test/benchmarks/pipeline.bench.ts`.

## Focused smoke

Commands:

```sh
REPLAY_BENCH_CASE=parse bun run test/benchmarks/process-bench-child.ts timing ./test/benchmarks/replay-process-bench.ts 0 1
REPLAY_BENCH_CASE=resolve bun run test/benchmarks/process-bench-child.ts retainedHeap ./test/benchmarks/replay-process-bench.ts 0 1
```

Observed JSON output:

- timing: `{"iterations":1,"warmupIterations":0,"samplesNs":[94950334]}`
- retained heap: `{"retainedHeap":3730}`

Parser logs were redirected to stderr by child runner; each command emitted one JSON report line on stdout.

## Concerns

- Replay fixture setup initializes game adapters and performs gzip/file loading before timed iterations, as required. No SQLite, replay I/O, or production function changes made.
- Full benchmark/tooling suites intentionally not run; parent task owns broad validation.
