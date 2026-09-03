Command: `REPLAY_BENCH_CASE='replay/full seed metadata scan' bun test/benchmarks/replay-process-bench.ts`

Result: completed successfully. Existing replay/parse and replay/resolve cases ran; extended harness initialized seed metadata, late-F1, separated same-session, and cross-session cases with digest preflight before timing. No benchmark assertion failed.

Command: `bun run bench:replay-io`
Result: completed successfully; replay I/O results written by harness.
