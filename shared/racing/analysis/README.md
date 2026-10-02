# Analysis telemetry

Shared analysis telemetry capability contracts used by analysis panels and derived calculations.

## Purpose
- Define canonical analysis telemetry capabilities.
- Provide per-game overrides with a stable fallback.
- Keep analysis renderers and compute logic aligned on one metadata model.

## Key modules
- `telemetry-capabilities.ts`
  - `DEFAULT_ANALYSIS_TELEMETRY`
  - `resolveAnalysisTelemetry(adapter)`

## Browser vs Node boundary
- Pure TypeScript, browser-safe.
- No file IO, timers, or environment reads.

## Dependency direction
- Uses `GameAdapter` and `AnalysisTelemetryModel` from `shared/games/types.ts`.
- Client analysis panels import `shared/racing/analysis/telemetry-capabilities` directly (`client/src/components/analyse/*`).

## Add/extend safely
- Add new metrics by extending `AnalysisTelemetryMetric`/`AnalysisTelemetryModel` in `shared/games/types.ts` first.
- Extend `DEFAULT_ANALYSIS_TELEMETRY` only for stable cross-game defaults.
- In `resolveAnalysisTelemetry`, merge adapter overrides only when semantics changed, never replace defaults with `undefined`.
- Keep adapter overrides optional through `Partial<AnalysisTelemetryModel>` so defaults remain authoritative.
