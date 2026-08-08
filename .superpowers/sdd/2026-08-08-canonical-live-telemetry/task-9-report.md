# Task 9 report

## Change

Added canonical semantic wheel-dynamics primitive in `shared/racing/analysis/laps/physics/vehicle.ts`:

- `WheelDynamicsFrame` accepts SI speed, steering, wheel angular speed, and radius.
- `wheelDynamicsFrame` computes four `WheelState` values without packet access.
- `allWheelStates(TelemetryPacket)` remains as historical compatibility wrapper and delegates to primitive.

Migrated live dashboard entrypoints:

- Forza and ACC dashboards consume `telemetryView`/`LiveTelemetryView`.
- RaceInfo consumes semantic identity/timing fields.
- LiveTelemetry derives dashboard values from semantic view.

Some child widgets still use legacy packet-shaped props through LiveTelemetry's compatibility boundary and require follow-up narrowing.

## Verification

- `bun run typecheck` executed; repository remains blocked by concurrent Task 7/8 integration diagnostics plus a transient ACC JSX error fixed before commit.
- Focused command `bun test client/src/lib/live-telemetry-view.test.ts test/telemetry/analysis-telemetry.test.ts --timeout 30000`: 4 pass, 0 fail.

## Verification

- `bun run typecheck` executed.
- Typecheck currently fails on unrelated concurrent Task 7/8 integration errors in benchmark fixtures, native-source fixtures, pipeline/projector/wire, and recorder test support. No diagnostic points to `vehicle.ts`.
- Focused command `bun test client/test/live-telemetry-view.test.ts test/telemetry/analysis-telemetry.test.ts --timeout 30000`: 4 pass, 0 fail (the requested paths resolve to one discovered test file).
## Commit

Pending commit: `refactor: consume semantic live telemetry`
