# Plan 005: Adapt pixel ratio without mistaking FPS caps for overload

## Status
- Priority: P2; effort: M; risk: MED; category: perf.
- Planned at: `7cb5fdd53`, 2026-09-22. Depends on: 001-scene-scheduling.md. Status: TODO.
- Planning only. No runtime bottleneck or FPS improvement measured.

## Goal / boundaries
Offer automatic resolution reduction within the current quality range when an actively rendered scene persistently misses its achievable frame budget. Never change models, triangles, topology, mesh counts, model materials/visibility, track sample density, or the user's FPS setting. Do not add a new graphics settings UI or renderer dependency.

## Current state
`client/src/components/CarWireframe.tsx:156-158` sets antialias=false, dpr={[1,1.5]}, frameloop=always. Its renderer gate clamps renderFpsCap to 15-120 and bypasses that cap when window.__recording is true. `client/src/stores/telemetry.ts:23,63` defines renderFpsCap and defaults it to 60. Plan 001 replaces the renderer patch with a single whole-frame driver.

Reducing DPR from 1.5 to 1 reduces drawing-buffer pixel area by 55.6%; this is not an FPS estimate. A naive FPS monitor would misclassify deliberate 15/30 FPS caps, paused scenes or a 60 Hz display with a 120 FPS setting as GPU overload.

Official guidance: https://r3f.docs.pmnd.rs/advanced/scaling-performance . Use setDpr on the existing R3F root; do not remount Canvas. Match current settings ownership: useSettings remains authoritative for cap, adaptation is ephemeral per Canvas.

## Scope
CarWireframe.tsx and SceneFrameDriver introduced by plan 001; a small pure adaptive-resolution policy helper and focused client/test test are permitted. Resize/resolution integration with PersistentLine from plan 003 is in scope if needed. No new settings schema or package changes.

## Steps
1. Capture target-cap, display-refresh and accepted-frame timing separately in the existing driver. Measure refresh only while active; derive achievable target as min(user cap, observed display refresh). Exclude loading, resize, hidden/inactive state, pause and recording. Use deadline misses/achieved cadence, not raw FPS alone. Discard warm-up samples and reset windows after cap changes. CPU gl.render duration is not GPU time: do not label it as GPU cost.
   Verify: a deterministic policy test supplies synthetic 60 Hz ticks with a 30 FPS cap and with a 120 FPS cap; neither stable sequence triggers a reduction. Paused/hidden periods contribute no overload samples.
2. Use bounded levels within the existing range: 1, 1.25, 1.5, clipped/deduplicated at clamp(devicePixelRatio,1,1.5). Start at the current upper bound. After two consecutive active 2-second windows below 85% of achievable cadence, reduce one step; use a 5-second cooldown. After ten active seconds at >=97% of achievable cadence, allow one upward probe. Revert a failed probe and delay another for at least 30 active seconds. These are initial policy constants, not measured optimal values. A lower-DPR probe that provides no improvement should restore prior quality and back off rather than permanently degrading a CPU-bound scene. Do not create another independent RAF loop.
   Verify: fake-time behavior tests cover sustained overload, brief spikes, recovery, oscillation prevention, device DPR=1 and cap changes. Run `bun test client/test/adaptive-resolution.test.ts` if this test is added; assertions concern output resolution/transitions, not private fields.
3. Apply DPR through the root, update line material resolution after drawing-buffer changes, and preserve existing CSS dimensions and pointer mapping. Freeze adaptation during recording and use the original clamped device DPR before the captured frame renders. Reset sampling after recording, resize, visibility changes and source changes. Requested deterministic captures must not differ depending on previous overload history.
   Verify: actual browser smoke checks text/line readability, camera interactions, resize, paused-to-active transition and recording. Use the existing recording hook, not a fake substitute.

## Final verification
Run `bun run typecheck` and `bun run lint` once after all implementation edits settle. Start `bun run dev` through service supervisor and inspect the real 3D scene. Disposable browser instrumentation must record CSS size, drawing-buffer size, accepted cadence and chosen DPR:
- Lowering 1.5 to 1 changes buffer area to approximately 4/9 (rounding allowed), without changing model topology or selected meshes.
- Deliberate cap=30 on stable 60 Hz ticks does not downshift.
- A reproducible render-load scenario downshifts only after sustained misses; no arbitrary permanent production stress code.
- Camera motion and thick lines stay correctly sized; recording starts at baseline quality regardless of prior adaptation.
No success claim based only on a changed DPR number: record whether frame pacing actually improves in the loaded scenario. If environment cannot produce reliable render pressure, report that limitation while keeping deterministic policy evidence distinct from runtime proof.

## Done / stop / maintenance
Done: policy behavior verified, actual pixel-size and visual checks pass, recording deterministic, model assets unchanged. Remove probes, follow release-note workflow after verification, mark plans/README.md DONE. No commit/push unless asked.
Stop if timing cannot distinguish cap/display limits from overload; keep fixed current DPR rather than shipping blind FPS-based degradation. Future scheduler changes must preserve these timing distinctions; do not treat lack of idle frames as low performance.
