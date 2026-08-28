# Calibration visual comparison frontend

## Status

Implemented temporary, isolated calibration comparison UI:

- `TrackDebugPanel` fetches the generated RPC comparison endpoint with boundary and curb diagnostics.
- `TrackDebugCanvas` draws the current transformed outline in cyan and optional historical transformed outlines in muted amber, without a comparison-specific coordinate flip.
- `CalibrationComparisonSection` provides an accessible history checkbox plus numeric transform, lap, RMSE, and point-count legend.
- Comparison response typing is inferred from the generated Hono RPC client. Comparison-only code remains grouped for direct removal.

## Verification

- `bun test test/calibration-comparison-ui.test.tsx` — 3 passed, 0 failed.
- `bun build src/components/track/debug/TrackDebugPanel.tsx --outdir /tmp/raceiq-calibration-ui-smoke --target browser` — bundled successfully.
- React Doctor changed scope — 91/100, no issues found.
- Impeccable detector — no findings.
- Storybook browser smoke at 1200×760 — current and historical paths visually distinct; checkbox keyboard-accessible and hiding history removed amber paths while preserving current cyan path.

## Concerns

- Comparison history is process-local by backend contract, so the legend is intentionally empty after server restart until accepted fits accumulate.
- Project-wide typecheck and suites were intentionally left to integration validation.
