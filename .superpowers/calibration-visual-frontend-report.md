# Calibration visual comparison frontend

## Status

Implemented temporary, isolated calibration comparison UI:

- `TrackDebugPanel` fetches the generated RPC comparison endpoint with boundary and curb diagnostics.
- `TrackDebugCanvas` applies the inverse calibration transform (outline space → source space), drawing current transformed outline in cyan and optional historical transformed outlines in muted amber without an additional axis flip.
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
- Broader integration suites remain for integration validation; pre-commit lint and full TypeScript typecheck passed.

## Review correction

Review identified that the initial overlay used the stored source-to-outline fit in the forward direction. Rendering now matches backend `transformToSourceSpace`: subtract translation, rotate by the negative angle, and divide by scale. A non-identity regression test proves outline point `(6, 22)` maps back to source point `(1, 2)` for a 2×, 90° fit translated by `(10, 20)`. Focused tests and the Storybook show/hide smoke passed after correction.
