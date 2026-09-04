F1 state-only priming implemented in `server/games/f1-2025/f1-state.ts` and adapter entrypoint.

Verified:
- `bun test test/games/f1-2025/f1-telemetry-contract.test.ts --timeout 60000`: 3 pass, 0 fail.
- `bun test test/games/f1-2025/f1-indexed-replay.test.ts --timeout 180000`: 2 pass, 0 fail.
