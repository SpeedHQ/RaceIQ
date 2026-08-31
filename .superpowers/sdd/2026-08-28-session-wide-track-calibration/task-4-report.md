# Task 4 Report

Audited static/live calibration lifecycle and added narrow live-state isolation.

- `feedCalibrationPosition` detects lap-counter rollback (session/import boundary), discards prior live transform and progress evidence, and retains static alignment cache.
- Exported `resetLiveCalibration(trackOrdinal)` clears only live state, preserving static fallback.
- `LiveTelemetryPipeline` calls reset at detector `onSessionStart`, handling same-lap-number sessions.
- `transformToSourceSpace` precedence and geometry route payloads unchanged.
- Added focused tests for static fallback after live reset and lap-counter session isolation.

Focused verification:
- `bun test test/tracks/calibration.test.ts test/telemetry/live-pipeline-calibration.test.ts`: 13 passed, 0 failed.
- Static fallback test confirms reset leaves cached transform usable while live status is cleared.

Commits: `47d8fbfe6`, `21c221143`
