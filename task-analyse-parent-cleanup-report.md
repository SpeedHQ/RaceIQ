# Analyse parent cleanup

- Updated `client/src/components/analyse/LapAnalyse.tsx` to consume semantic frames from `useAnalyseSelections`.
- Removed local `currentPacket`, `currentDisplayPacket`, and `displayTelemetry` aliases.
- Passed semantic `currentFrame` and `semanticFrames` into workspace panel APIs while preserving playback, cursor, insights, sectors, and unavailable handling.
- Client typecheck passed: `bunx tsc -p client/tsconfig.json --noEmit`.
