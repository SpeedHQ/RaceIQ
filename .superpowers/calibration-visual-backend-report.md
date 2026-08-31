# Calibration visual backend

Implemented process-local calibration comparison history and endpoint.

- Records accepted live and stored fits with sequence, lapNumber, transform, RMSE, and points.
- Keeps latest 12 entries; resetLiveCalibration clears history.
- Added typed GET `/api/track-calibration/:ordinal/comparison`; existing status route unchanged.
- Focused tests: `bun test --config bunfig.unit.toml test/tracks/calibration.test.ts` (14 pass).

Commit: see git history.
