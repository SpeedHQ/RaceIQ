# Analyse visual leaf migration

Migrated `BodyAttitude` to consume `SemanticAnalysisFrame` and read canonical catalog IDs `motion.roll`, `motion.pitch`, and `motion.yaw`. Missing values remain explicitly unavailable via zero-angle rendering (no packet fallback).

Migrated `GForceCircle` to accept an optional semantic frame and read `motion.acceleration-x` / `motion.acceleration-z`. Live telemetry view remains supported for raw/live boundaries. Missing semantic acceleration suppresses the dot and displays `—` readouts instead of fabricating acceleration values.

## Required parent wiring

`AnalyseVizPanel` must stop passing `currentPacket`/`currentDisplayPacket` to these leaves and pass the cursor `SemanticAnalysisFrame` instead:

- `<BodyAttitude frame={currentFrame} />`
- `<GForceCircle frame={currentFrame} />`

`CarWireframe` remains packet-shaped because its direct rendering graph (`CarScene`, `CameraControllers`, `CurbMarkers`, `InputOverlay`, `TireTrails`, and `TrackElements`) still consumes packet fields. Completing that cutover requires parent changes to provide semantic frame/catalog data and coordinated migration of that helper graph; no Analyse parent/workspace files were edited per scope.

TypeScript check: `bunx tsc -p client/tsconfig.json --noEmit` passed.
