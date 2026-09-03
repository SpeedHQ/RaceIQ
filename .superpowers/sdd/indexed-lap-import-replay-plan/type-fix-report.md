# Indexed Lap Import Replay Type Fix Report

- Replaced incorrect `getAllServerGames` import with registry export and typed benchmark game IDs as `GameId`.
- Added explicit registry/normalization imports to indexed import oracle test.
- Existing benchmark harness import retained: `runMitataBenchmarks` from `./mitata-harness`.
- Callback parameter now receives inferred `ServerGameAdapter` type from registry.

Verification:
- `bun run typecheck` — passed.
- `bun test test/session-capture/lap-index-import.test.ts --timeout 180000` — 2 passed, 0 failed.
