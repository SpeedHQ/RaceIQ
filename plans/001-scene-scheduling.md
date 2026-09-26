# Plan 001: Schedule complete scene frames and stop idle rendering

## Status
- Priority: P1; effort: L; risk: MED; category: perf.
- Planned at: `7cb5fdd53`, 2026-09-22.
- Depends on: 003-persistent-lines.md and 004-wheel-label-refresh.md. These provide imperative geometry and label updates before the telemetry cutover.
- Status: Superseded by the imperative Three.js WebGPU scene cutover on 2026-09-26. This document describes an unimplemented R3F approach; actual measurements are in [render-performance-benchmarks.json](render-performance-benchmarks.json).

## Goal and boundaries
Cap the whole 3D update/render transaction, not just WebGL draws. Stop rendering settled, paused scenes. Keep the current Three.js/R3F/Drei stack. Do not modify GLBs, model triangles/topology, mesh visibility rules, CarBody materials, model optimizer scripts, or model configuration. Do not change the 2D charts' playback timing or introduce a new global store.

## Current state
- `client/src/components/CarWireframe.tsx:153-158`: `<Canvas ... dpr={[1, 1.5]} frameloop="always">`.
- `CarWireframe.tsx:193-234` replaces `gl.render`; `if (now + 1 < gate.nextRenderAt) return` skips draws after R3F callbacks have already run. It also owns FPS display and GPU diagnostics.
- `client/src/components/analyse/AnalyseVizPanel.tsx:51-61` polls `cursorRef` with requestAnimationFrame and updates React state. Its custom comparator at lines 24-35 ignores cursor props; changing this lifecycle requires changing that comparator.
- `CarWireframe` accepts cursorRef/telemetryRef but does not consume them. CarScene receives frame/cursor props and updates its entire telemetry-dependent subtree.
- `client/src/components/wireframe/Wheel.tsx:63-67` integrates last known rotationSpeed using wall-clock delta, even after playback pauses.
- `CameraControllers.tsx:12-25` uses fixed `diff * 0.04` smoothing; it becomes frame-rate dependent when cadence changes.
- `client/src/hooks/useLapPlayback.ts:54-111` already owns playback time/cursor. It remains authoritative; rendering must not advance playback itself.
- Boundary walls and trails already use persistent resources and explicit disposal; follow TrackElements/TireTrails ownership patterns.

## Scope
Modify CarWireframe, CarScene, CameraControllers, Wheel, the dynamic consumers in `client/src/components/wireframe/` as needed to read a coherent scheduled snapshot, and analysis prop plumbing in LapAnalyse, AnalyseWorkspacePanels, AnalyseTopSection, AnalyseVizPanel. Update `client/src/components/onboarding/steps/WelcomeStep.tsx` and `client/src/routes/fm23/cars_.$carOrdinal.tsx`. A narrowly scoped `client/src/components/wireframe/SceneFrameDriver.tsx` and pure timing helper/test are permitted. No CarBody/classify-mesh edits.

All three consumers must migrate: analysis playback, looping onboarding demo (including recording hooks), and static car viewer. Run LSP references before changing exported props; update every discovered consumer.

## Implementation
1. Capture the current surface before edits. Use `bun run dev`, launched through the host's service supervisor. Open the actual reported URL with browser automation. Record idle/playback/seek screenshots, frame callback/draw counts, and recording behavior. Do not infer readiness from process creation. Inspect recording callers of `__setFrame`, `__pauseAnimation`, and `__recording`; preserve their timing contract.
2. Introduce one explicit scene source contract: stable latest-frame/history/cursor refs plus active playback state, playback speed and seek generation. Pass source state from LapAnalyse through the existing topSectionProps chain. Onboarding must expose running/paused state and seek generation from its existing controls. Static viewer is explicitly inactive. Do not infer paused state from speed or packet arrival frequency.
3. Give each Canvas one manual frame owner using R3F `frameloop="never"` and its documented per-root `advance` API. Consult official API documentation for timestamp units. Schedule accepted frames at the existing 15-120 FPS cap with deadline accumulation, no catch-up burst. Read one latest snapshot before advance; all 3D consumers use that same snapshot. Retain refs for deadlines/scratch objects; do not commit React state on every telemetry tick. React owns structure/settings/model selection, not the live transforms, colors, and line buffers.
4. Migrate telemetry-driven updates completely: body attitude, wheel steering/spin/material colors, grid phase, springs/load trail, track/input buffers and tire trails. Use the imperative update paths from plans 003/004. Cache per-history data and reuse scratch objects. Derive wear-rate updates from new telemetry samples only, not effect rerenders. Preserve existing telemetry semantics; if an unrelated correctness defect prevents parity, report it rather than silently incorporating a separate repair.
5. Wake the driver on playback, source/seek/config changes, model load, resize, theme/unit changes and camera interaction. Continue while controls damping or chase-camera convergence needs frames; stop once settled. Connect controls change/start/end events to the driver; Drei invalidate alone does not run a manual root. Suspend when the 3D view/document is inactive. Resume with latest snapshot and reset wall-clock anchor, never integrate the hidden interval. Camera smoothing must use elapsed time rather than fixed per-tick factors.
6. Freeze wheel spin on pause, use playback-scaled elapsed time while playing, and reset integration anchors after seeks/resume. Recording must render requested explicit frames at fixed quality, without FPS gating or incidental free-running advancement. Preserve deterministic requested-frame capture and the existing recording hooks.
7. Remove the gl.render monkey patch and obsolete 3D React cursor polling after migration. Preserve 2D/DOM overlays with a separately scoped display cadence; removing 3D polling must not freeze Vitals2D, BodyAttitude or GForceCircle. Fix memo comparators so pause, seek and source replacement wake the scene. Retain FPS/diagnostic reporting at the completed-draw boundary, with no production instrumentation added solely for the benchmark.

## Verification
Commands from repository manifests: `bun run dev` starts the application; `bun run typecheck` and `bun run lint` must exit 0 after integration. Run these once after dependent source edits settle, not per file. Existing timing regression: `bun test client/test/lap-playback-timing.test.ts` must pass.

Use a disposable browser probe to assert:
- After camera settling, paused/static scene has zero recurring scene advances/draws over a 2-second observation; a seek or camera move still changes pixels.
- At 30 FPS cap on a display running at least 60 Hz, advances and actual draws over 5 active seconds are at most 152; count both, not only gl.render.
- 15/30/60/120 cap changes, play/pause, backward seek, lap replacement, 2D/3D switching, visibility changes and StrictMode/remount do not create duplicate drivers or stale data.
- Wheel spin stops at pause; resume has no hidden-time jump; 0.5x/2x playback and camera settling remain consistent.
- Onboarding explicit frame capture renders the requested snapshot before capture; static car viewer remains interactive.
Keep only pure timing regression tests for deadline drift, pause/resume and seek transitions; follow Bun test conventions in client/test/lap-playback-timing.test.ts. Do not add source-string tests.

## Done / stop / maintenance
Done: all consumers migrated, legacy gate gone, proof above recorded, models unchanged, typecheck/lint pass, temporary probes removed. Update release notes under the repository release-note workflow only after behavior is verified, then mark this plan DONE in plans/README.md. Do not commit/push unless asked.
Stop if recording requires a second frame owner, if ref mutation has no reliable wake event, or if maintaining parity requires model changes. Resolve within the existing source lifecycle rather than adding polling fallbacks. Future animated components must register their active/settling needs with the single driver.
