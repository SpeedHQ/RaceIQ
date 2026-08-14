# Lap detection

## Purpose

Own shared lap-detector contracts and the ordinal-based detector used by Forza Motorsport, F1 2025, and the iRacing timing wrapper. It turns normalized telemetry into session and lap boundaries, persists completed or incomplete laps, and publishes lifecycle callbacks.

## Structure

- `types.ts` defines detector construction, callbacks, and the interface consumed by game adapters and the live telemetry pipeline.
- `boundaries.ts` contains pure session, lap-number, restart, and final-lap boundary decisions.
- `detector.ts` owns mutable ordinal-detector state, structural validity, independent lap classification, quality and sector evaluation, persistence metadata, fuel and tire history, and callback dispatch.

## Boundaries and invariants

Game adapters select or wrap detectors; this folder does not parse game protocols. Telemetry supplies normalized packets and raw-file offsets, while database, lap-analysis, experiment reconciliation, and track-data modules own persistence and derived artifacts.

Boundary ordering is significant: session rollover finalizes the buffered lap before session-start callbacks; restart and rewind decisions precede lap-number completion. Lap numbering comes from normalized `LapNumber`. Structural invalid reasons retain detector-state precedence; recording quality and pace classification are persisted separately and must not rewrite validity. Byte offset and frame count are captured with the completed buffer. In `LapDetector`, valid-lap completion callbacks run before asynchronous save notifications.

## Testing

Exercise `boundaries.ts` with synthetic packets for identity changes, resets, skips, rewinds, and final-lap timing. Detector checks should use a controlled `DbAdapter` and callbacks, asserting lap number, validity reason, persistence metadata, and callback order for normal, skipped, incomplete, stale, and session-rollover paths.
