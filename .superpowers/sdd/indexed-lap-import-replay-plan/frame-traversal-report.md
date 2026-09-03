# Frame Traversal Report

- Focused command: `bun test test/games/f1-2025/f1-indexed-replay.test.ts test/games/ac-evo/ac-evo-batch-decode.test.ts --timeout 180000`
- Result: 4 pass, 0 fail, 29 assertions, 4.41s.
- Benchmark syntax command: `bun build test/benchmarks/replay-io.bench.ts --no-bundle --outdir /tmp/raceiq-bench-check`
- Result: transpiled successfully in 4ms.
- Replay storage now loads cached decompressed capture/index, resolves raw offsets through `frameIndex.byOffset`, omits unaligned batched offsets, primes only stateful prefixes, and full-parses requested ranges plus one trailing frame.
- Same-session batched traversal uses one sequential indexed pass and stops after final trailing frame.
- Replay I/O benchmark cache-identity case removed; remaining case clears source cache and validates envelope count before timing.
