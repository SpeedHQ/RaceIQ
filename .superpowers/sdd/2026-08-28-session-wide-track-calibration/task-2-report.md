# Task 2 Report

Implemented session-wide calibration fitting in `server/tracks/calibration.ts`.

- Pairs bounded progress-bin representatives with outline points using normalized arc position.
- Fits scale, rotation, and translation over combined evidence.
- Performs two residual-trimming passes to resist isolated telemetry outliers.
- Preserves bounded evidence and existing calibration APIs/precedence.
- Added focused coverage for two lateral-line laps, outlier resistance, and insufficient evidence.

Focused verification: `bun test test/tracks/calibration.test.ts` — 8 pass, 0 fail.
