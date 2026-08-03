# Lap analysis

Shared, deterministic telemetry analysis used by server-side profiling and user-facing lap summaries.

## Modules

- `frame-time.ts` derives per-frame durations from packet timestamps.
- `time-loss.ts` contains conservative, within-event time-loss estimators.
- `driving-style.ts` summarizes continuous driving-style measurements for one lap and aggregates them across laps.
- `physics/vehicle.ts` contains vehicle-dynamics primitives for slip, grip utilization, balance, suspension, and wheel state.
- `insights/analyze.ts` orchestrates the detector pipeline.
- `insights/driving-core.ts` and `insights/driving-advanced.ts` detect driving events.
- `insights/tires.ts`, `insights/suspension.ts`, and `insights/mechanical.ts` detect component-specific conditions.
- `insights/types.ts` defines insight contracts and event-grouping helpers.

## Runtime boundary

This directory is browser-safe: modules perform no filesystem, database, network, clock, or UI work. They consume normalized `shared/telemetry/types` packets and game capabilities from `shared/games`. Keep presentation and persistence in their respective client and server layers.

Dependency flow is:

`shared/games` + `shared/telemetry` -> `shared/lap-analysis` -> client/server consumers

## Extending analysis

- Put reusable physical calculations in `physics/vehicle.ts`, not in a detector or UI component.
- Add detectors beside the matching signal family, then call them explicitly from `insights/analyze.ts`.
- Build lap-wide context once in `analyzeLap`; pass it into detectors rather than rescanning telemetry independently.
- Keep outputs conservative: `timeLossS` is optional, overlapping losses are not additive, and unavailable measurements are not zero.
- Keep functions deterministic and import explicit leaf modules, for example `shared/lap-analysis/insights/analyze`; do not add a barrel.
