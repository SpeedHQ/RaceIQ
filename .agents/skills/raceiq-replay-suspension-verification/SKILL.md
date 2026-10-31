---
name: raceiq-replay-suspension-verification
description: "Verify RaceIQ Replay/Spectate suspension rendering, world-space spring anchors, chassis motion, and comparison-camera visibility without confusing schematic markers with 3D cars."
---

# RaceIQ replay suspension verification

## Scope discovery

- Active single-lap Replay and Compare → Spectate use `packages/lap-replay/ui/SpectateSceneRuntime.ts`. Do not assume the older `packages/scene-3d/src/wireframe/SceneRuntime.ts` drives these pages.
- Shared display normalization lives in `packages/scene-3d/src/suspension.ts`. Preserve native normalized travel and specified game ranges; observed lap extrema are display-only, not physical limits or wheel load.
- Reuse `SuspensionSpring.tsx` resources and dispose them during model replacement and runtime disposal.

## Coordinate invariant

`updateRibbonPool` computes camera-facing ribbon widths and near-plane clipping in world coordinates. Replay cars move and yaw in parent groups. Transform spring endpoints with the car group's current world matrix before passing them to scene-level spring resources. Passing local endpoints while using the world camera produces incorrect placement or widths.

## Real-app verification

Reuse the existing Playwright scenarios:

- `packages/lap-replay/test/e2e/analyse/workspace.spec.ts`: AMS2 reduced-rate Polo replay scenario.
- `packages/lap-replay/test/e2e/compare/spectate-preferences.spec.ts`: AMS2 paired suspension scenario.
- Use the actual app and recorded telemetry; `forceWebGL=true` permits verification without native WebGPU.
- Scene canvas diagnostics include `data-a-suspension-visible-count`, `data-b-suspension-visible-count`, `data-a-body-heave`, corresponding roll/pitch fields, model pixel sizes, render time, camera phi, and zoom blend.
- Zoom into actual 3D cars before asserting four springs. Zoomed-out schematic markers intentionally hide cars and springs.
- Compare camera auto-fit enforces enough distance to contain both recorded poses. Widely separated cars may prevent close 3D inspection regardless of wheel input. Use position lock when available, or choose deterministic nearby poses from coherent recordings. Do not weaken spring assertions to accommodate an unsuitable fixture.
- The uploaded Polo race fixture used laps four and two from the same session near 47.75 seconds for close paired inspection. Treat this as fixture-specific, not a universal timestamp; resolve IDs from metadata.
- Verify heave changes across seeks or playback for each car. Rotate the camera and assert springs remain visible. Overhead views show circular spring tops; a tilted screenshot reveals coils in profile.

## Verification discipline

- Extend unit tests in `packages/lap-replay/test/unit/spectate-runtime.test.ts` for native-normalization precedence, per-lap ranges, invalid-data hiding, and world-space spring anchors.
- Run applicable focused tests, changed-file lint, changelog checks, and repository-required `bun run typecheck`.
- Use one targeted retry after an identified browser failure; prefer the existing Playwright harness as an independent fallback rather than repeatedly reloading a stalled browser tab.
- Keep temporary local E2E configuration outside tracked changes where possible. Host autocommit may snapshot workspace files during task completion; remove temporary scaffolding before publication and inspect the staged diff.
