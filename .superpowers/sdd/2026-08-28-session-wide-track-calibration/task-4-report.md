# Task 4 Report

Audited static/live calibration lifecycle and added narrow live-state isolation.

- `feedCalibrationPosition` now detects lap-counter rollback (session/import boundary), discards prior live transform and progress evidence, and retains static alignment cache.
- Added exported `resetLiveCalibration(trackOrdinal)` for explicit lifecycle boundaries; it clears only live state, preserving static fallback.
- `transformToSourceSpace` precedence and geometry route payloads unchanged.
- Added focused tests for static fallback after live reset and lap-counter session isolation.

Focused verification:
- `bun test test/tracks/calibration.test.ts`: 11 passed, 0 failed.
- Static fallback test confirms reset leaves cached transform usable while live status is cleared.

- Commit: `45a1638b3`
