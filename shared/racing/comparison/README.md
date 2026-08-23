# Comparison

Core DTOs for lap comparison outputs used by compare workflows.

## Purpose

- Define serializable comparison payload shape.
- Keep corner and trace alignment structures colocated.
- Define the response shape expected by client lap-comparison rendering.

## Key modules

- `types.ts`
  - `AlignedTrace`
  - `CornerDelta`
  - `ComparisonData`
  - `LapMeta` and `SemanticTelemetrySample` type dependencies

## Browser vs Node boundary

- Pure type module, browser-safe.
- No Node runtime requirements.

## Dependency direction

- Imports `LapMeta` from `shared/racing/sessions/types` and `SemanticTelemetrySample` from `shared/telemetry/replay/contracts`.
- Client comparison components import `ComparisonData` plus generic semantic sample contracts directly.
- Server comparison endpoints produce this shape from resolver-backed replay.

## Add/extend safely

- Treat fields as API response fields: update the endpoint producer and client renderer together.
- Keep all trace arrays aligned by index and document any new length or ordering guarantee.
- Prefer direct import, e.g. `shared/racing/comparison/types`.
