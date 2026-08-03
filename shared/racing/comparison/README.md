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
  - `LapMeta` and `TelemetryPacket` type dependencies

## Browser vs Node boundary
- Pure type module, browser-safe.
- No Node runtime requirements.

## Dependency direction
- Imports `LapMeta` from `shared/racing/sessions/types` and `TelemetryPacket` from `shared/telemetry/types`.
- `client/src/components/LapComparison.tsx` imports `ComparisonData` directly.
- The server comparison endpoint must produce this shape, although its implementation currently uses local calculation types.

## Add/extend safely
- Treat fields as API response fields: update the endpoint producer and client renderer together.
- Keep all trace arrays aligned by index and document any new length or ordering guarantee.
- Prefer direct import, e.g. `shared/racing/comparison/types`.
