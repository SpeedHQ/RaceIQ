# Task 2 Report: Fixed-Iteration Timing Child

## Files
- `test/benchmarks/process-bench-child.ts`: timing child CLI. Loads runtime-selected fixture, calls `setup()` once, runs unmeasured warmups, then exact measured iterations using `Bun.nanoseconds()`. Emits one JSON line on stdout; diagnostics/errors go to stderr.
- `test/tooling/process-bench.test.ts`: focused child integration coverage plus existing contract tests.

## Tests
`bun test test/tooling/process-bench.test.ts --timeout 60000`

Result: 8 passed, 0 failed, 11 expectations.

Coverage includes setup ordering, warmup exclusion, exact sample count, finite samples, and existing report validation.

## Output
Timing report conforms to `TimingChildReport`: `iterations`, `warmupIterations`, and `samplesNs`. Child output is exactly one JSON report line.

## Concerns
Fixture module must export `runIteration()` and may export async or synchronous `setup()`. Runtime module loading is intentional because fixture selection is a child CLI argument. Timing callback performs no GC or heap reads.
