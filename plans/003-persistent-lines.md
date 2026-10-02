# Plan 003: Reuse dynamic line geometry and transform static springs

## Status
- Priority: P1; effort: M; risk: MED; category: perf.
- Planned at: `7cb5fdd53`, 2026-09-22. Depends on: 002-pedal-overlay-index.md. Status: superseded by the 2026-09-26 WebGPU cutover.
- Historical R3F proposal, not an implementation guide for the current runtime. See [cutover measurements](render-performance-benchmarks.json).

## Goal / boundaries
Stop replacing line geometry on each telemetry update. Preserve screen-space thickness, color gradients, transparency, ordering, endpoint appearance and disconnected runs. Absolutely no changes to car model triangles, topology, assets, materials, visibility rules or optimizer scripts. Do not decimate track samples. Keep Three.js/three-stdlib; do not introduce another rendering package or redesign the scene.

## Current state
- `client/src/components/wireframe/TrackElements.tsx:25-36` produces new filtered segment arrays and passes them to `<Line key={segment.sourceStartIndex} points={segment.points} ... />`.
- `InputOverlay.tsx:112-116` renders a separate Drei Line for each visible pedal run. Plan 002 changes CPU selection, not this render representation.
- `SuspensionSpring.tsx:24-33` regenerates 73 helix points as height changes. Coil and damper are separate thick lines.
- `CarScene.tsx:421-475` creates fresh point arrays for crosshairs, load trail and static drivetrain.
- Drei v10.7.8 Line uses `useMemo(..., [points, segments, vertexColors, itemSize])` to create LineGeometry and disposes it when replaced: https://github.com/pmndrs/drei/blob/v10.7.8/src/core/Line.tsx . Consult public source/docs, never node_modules for usage research.
- Existing lifecycle pattern: TrackBoundaryEdges allocates wall geometry once, mutates it in layout effects, disposes it on unmount (`TrackElements.tsx:62-108`). TireTrails similarly retains instanced resources. Match this explicit ownership.

## Scope
TrackElements, InputOverlay, SuspensionSpring, CarScene; related pure helpers in client/src/lib/wireframe-utils.ts and the helper from plan 002. One focused reusable component/helper `client/src/components/wireframe/PersistentLine.tsx` is allowed for the shared line-buffer lifecycle. New tests only for boundary/run correctness, under client/test. Do not modify CarBody or existing model resources.

## Steps
1. Capture fixed-pose screenshots with springs, track, racing line, drivetrain and pedal overlays enabled. Inspect public three-stdlib/Three documentation for Line2/LineGeometry instance attributes and count semantics. Keep the same thick-line shader path; ordinary WebGL line primitives do not preserve current widths.
   Verify: `bun run dev` through service supervisor; actual scene screenshots at near/far zoom and front/three-quarter views exist before edits.
2. Implement a persistent thick-line resource with explicit create/update/dispose boundaries. Maintain typed attribute capacity, update live ranges in place, and control the correct line instance count. Do not repeatedly call setters that replace underlying buffers. Empty/short runs draw nothing and cannot display stale tail data. Grow capacity geometrically only on genuine overflow and release replaced resources. Bounds must cover only active geometry or be managed explicitly; capacity zeros must not corrupt culling. Update pixel resolution after resize/DPR changes.
   Verify: throwaway CPU probe exercises grow, shrink, empty, grow-again and disposal. Add behavioral regression only for visible segment topology/color continuity and stale-tail errors. Buffer allocation counters belong in the disposable probe, not source-string or identity-only permanent tests.
3. Pool resources by active run slots rather than sourceStartIndex; source indices shift as the window moves. Update each run without bridging separate runs. Migrate TrackLine, pedal runs, and dynamic load trail/crosshairs. Preserve current line joins/caps: batching into disconnected segments is not acceptable if it changes their appearance. Reuse existing wall buffers; do not rebuild wall geometry. Expose narrow imperative update methods so plan 001 can drive the same buffers without React commits.
   Verify: `bun test client/test/wireframe-input-overlay.test.ts test/client/wireframe-utils.test.ts` passes; screenshot comparison confirms identical run boundaries and widths, especially loopbacks and short pedal runs.
4. Build each spring helix once in normalized height coordinates, preserve its radius, and update vertical scale/translation plus color. Handle zero/negative heights without NaN. Keep damper endpoints' extra 0.05 m extensions independent of spring scale. Hoist/memoize fixed drivetrain points by car dimensions. Load-dot heights and spring crosshairs must still follow suspension.
   Verify: browser smoke covers asymmetric compression, zero travel, large travel and car selection change; line width remains screen-space constant.

## Final verification
Run `bun run typecheck` and `bun run lint` once after dependent changes settle. Launch `bun run dev` and inspect actual UI. A disposable 30-second warmed-up playback probe should show no ongoing line geometry creation/disposal with stable visible run count/capacity; capacity transitions are allowed. Repeated toggle/unmount/remount must return resource counts to a stable baseline, not grow monotonically. Inspect GPU frame capture or renderer counters to verify draw counts did not unexpectedly multiply. No FPS claim without measurement.

## Done / stop / maintenance
Done: migrated lines keep resources stable, shrinking/empty data clears old segments, spring geometry no longer regenerates on compression, visual checks pass, model assets untouched. Remove probes, follow release-note workflow for verified user-visible behavior, mark index DONE. No commit/push unless requested.
Stop if thick-line APIs cannot preserve joins/caps or require package changes; report before replacing them with visually different primitives. Do not adopt a world-coordinate/chunk-transform rewrite in this plan: it has extra clipping/precision risk and is not necessary for buffer reuse. Future callers must respect owned-resource disposal and active-count semantics.
