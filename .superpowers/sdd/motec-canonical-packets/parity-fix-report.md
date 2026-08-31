# MoTeC canonical packet parity fixes

- Corrected source-frequency ROTY reconstruction by estimating per-lap bias from integrated source angular rate and removing it before heading integration.
- Preserved ACC suspension travel in meters after shared preparation normalization; removed duplicate conversion in canonical packet mapping.
- Restored ACC lap timing fields (`CurrentLap`, `CurrentRaceTime`) to seconds.
- Restored `importMotec` `tuneId` stamping across every imported lap using existing `updateLapTune` DB query.
- Restored AC Evo alignment outline import and retained existing orientation/alignment behavior.

Verification: `bun run typecheck`; focused MoTeC suite run during fix. Remaining open-window orientation test requires follow-up alignment investigation; no assertions weakened.
