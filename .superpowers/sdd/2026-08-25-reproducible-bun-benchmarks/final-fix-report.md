# Final fix report

Implemented final review fixes:

- Added independent `--retained-processes` option (default 7), with CI explicitly passing `--retained-processes=7` while timing process count remains separate.
- Redirected child stdout and console diagnostics before fixture import; restored stdout only for JSON emission, leaving errors on stderr.
- Changed parent timing aggregation to compute each child p50/p99 first, then median those summaries; raw child samples remain unchanged.
- Cast Mitata stats through `unknown` before attaching retainedHeap for repository TypeScript compatibility.

Verification:

- `bun test test/tooling/process-bench.test.ts --timeout 60000` — pass (8 tests).
- `bunx tsc --project scripts/tsconfig.json --pretty false` — pass.
- Process smoke invoked with two timing processes and seven retained processes. Harness correctly exercised independent sampling, but run encountered an invalid negative retained-heap delta (`-841`) and rejected it as designed; no false report was emitted.
