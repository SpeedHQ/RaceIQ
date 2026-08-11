# Analyse Dynamics Metric Order

## Goal

Keep dynamic vehicle metrics under their semantic section instead of duplicating them in the compact cursor summary.

## Scope

Change only Analyse right-panel presentation. No telemetry IDs, resolver behavior, API contracts, or metric calculations change.

## Layout

`MetricsPanel` retains primary cursor values: speed, RPM, gear, throttle, steer, brake, game-supported powertrain values, and fuel.

Remove from `MetricsPanel`:

- Lateral slip
- Grip Ask
- Suspension travel

`AnalyseDataPanel` continues rendering `AnalyseDynamicsPanel` below the `Dynamics` heading. Its existing subsection order remains:

1. G-Force
2. Traction / temperature / surface
3. Grip Ask
4. Slip, including lateral slip where supported and slip ratio
5. Wheels
6. Suspension

No new abstraction or shared layout component is needed. Existing `AnalyseDynamicsPanel`, `AnalyseTireWheelsPanel`, and `AnalyseSuspensionPanel` remain responsible for their current sections.

## Verification

- Focused client UI tests assert removed summary rows and retained Dynamics labels.
- Client build passes.
- Browser smoke confirms summary excludes the three rows and Dynamics contains them below its heading.
