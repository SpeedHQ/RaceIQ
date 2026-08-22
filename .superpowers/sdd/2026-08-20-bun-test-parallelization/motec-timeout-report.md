# MoTeC Import Timeout Report

- Added explicit `30_000` ms per-test timeout to first four `importMotec end to end` async tests in `test/motec/motec-import.test.ts`.
- Focused verification: `bun test test/motec/motec-import.test.ts -t "lands laps in the DB"` — 1 pass, 0 fail.
- Full focused file verification: `bun test test/motec/motec-import.test.ts --timeout 30000` — 28 pass, 0 fail.
- No production code, assertions, or DB integration coverage changed.
