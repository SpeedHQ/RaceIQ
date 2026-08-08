
## Review remediation

Amended guards now recursively reject bigint, non-finite numbers, and non-canonical nested frame values; enforce sparse state/freshness maps; and validate native packet `gameId` against `KNOWN_GAME_IDS` plus finite numeric `TimestampMS`.

Focused rerun: `DATA_DIR="$PWD/.data-test" bun test test/telemetry/live-contracts.test.ts --timeout 30000` — 4 passed, 0 failed, 17 expectations.
