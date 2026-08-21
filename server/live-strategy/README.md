# Live strategy

## Purpose

Computes live sector timing and pit-strategy estimates from normalized telemetry. Trackers keep session-local state and return display-ready data; telemetry orchestration owns lifecycle calls and broadcasting.

## Structure

- `sector-tracker.ts` resolves curated or game-native sector layouts, tracks sector transitions, and compares live pace with the fastest timed lap accepted by shared normal-pace eligibility.
- `pit-tracker.ts` estimates fuel range and tire life from bounded lap histories and optional distance-based wear curves.
- `tracker-math.ts` contains shared rolling-window, interpolation, threshold, and sector-boundary operations.

## Boundaries and invariants

- `server/telemetry` owns packet ordering, session reset order, valid-lap callbacks, and WebSocket publication. Trackers must not reorder or persist packets.
- Sector layouts come from `server/tracks` or the active game adapter. Native layouts and authoritative track lengths remain authoritative; ACC sector transitions use its native sector index.
- Pit history seeding reads laps through `server/db`; timed `fuel-burn` and `tire-analysis` eligibility select evidence, while active game policy decides comparability. Sector references update from completed live laps accepted by `normal-pace` eligibility. Estimates preserve five-lap fuel, three-lap tire, three-curve wear, and existing outlier windows.
- Lap boundaries, teleport recovery, threshold rounding, and unavailable-value sentinels are observable behavior. Keep reset and fallback semantics unchanged.

## Testing

Focused coverage lives in `test/live-strategy/sector-tracker.test.ts` and `test/live-strategy/pit-tracker.test.ts`. Use their test seams for deterministic tracker state, and cover boundary packets, reference interpolation, rolling histories, outlier rejection, and reset transitions when behavior changes.
