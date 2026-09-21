# Live strategy

## Purpose

Computes live sector timing and pit-strategy estimates from normalized telemetry. Trackers keep session-local state and return display-ready data; telemetry orchestration owns lifecycle calls and broadcasting.

## Structure

- `sector-tracker.ts` resolves curated or game-native sector layouts, tracks sector transitions, and compares live pace with the fastest valid reference lap.
- `pit-tracker.ts` estimates fuel range and tire life from bounded lap histories and optional distance-based wear curves.
- `tracker-math.ts` contains shared rolling-window, interpolation, threshold, and sector-boundary operations.

## Boundaries and invariants

- `server/telemetry` owns packet ordering, session reset order, valid-lap callbacks, and WebSocket publication. Trackers must not reorder or persist packets.
- Sector layouts come from `server/tracks` or the active game adapter. Native layouts and authoritative track lengths remain authoritative; ACC sector transitions use its native sector index.
- Pit history seeding reads laps through `server/db`, but the active game policy decides whether fuel and tire histories are comparable. Estimates preserve five-lap fuel, three-lap tire, three-curve wear, and existing outlier windows.
- Lap boundaries, teleport recovery, threshold rounding, and unavailable-value sentinels are observable behavior. Keep reset and fallback semantics unchanged.

## Live Engineer boundary

`server/telemetry/live-projector.ts` resolves semantic frames; `live-engineer-semantic-input.ts` owns availability and alignment; voice and spotter trackers consume semantic values only. Browser clients own Radio switches, queueing, preemption, playback, and volume. See [Opponent Callout Capabilities and Phasing](../../docs/architecture/decisions/opponent-callout-capabilities-and-phasing.md) for accepted capability status, replay limits, and phased delivery gates.

Opponent pace is implemented and production-supported for F1 25, ACC, and iRacing behind `RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER=true` plus game inclusion in `RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS`. Spotter is implemented and production-supported for ACC and iRacing only; F1 25 geometry detection is implemented but not production-enabled. ACC opponent recording remains unavailable because canonical capture excludes Broadcast UDP; AC Evo and FM opponent callouts remain unavailable without complete source-backed competitor feeds.

## Testing

Focused coverage lives in `test/sector-tracker.test.ts` and `test/pit-tracker.test.ts`. Use their test seams for deterministic tracker state, and cover boundary packets, reference interpolation, rolling histories, outlier rejection, and reset transitions when behavior changes.
