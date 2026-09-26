# Plan 004: Refresh wheel card textures at display cadence

## Status
- Priority: P2; effort: S-M; risk: LOW; category: perf.
- Planned at: `7cb5fdd53`, 2026-09-22. Depends on: none. Status: superseded by the 2026-09-26 WebGPU cutover.
- Historical R3F proposal, not an implementation guide for the current runtime. See [cutover measurements](render-performance-benchmarks.json).

## Goal / constraints
Keep sprite placement smooth while refreshing telemetry text/color at at most 10 Hz during ordinary playback. Unchanged display content must not repaint or upload. Explicit seeks, paused edits, units/theme changes and recording requests must show the current values immediately on the next rendered frame. Do not change model assets/triangles/topology/materials, label design, font scale, row semantics, or the telemetry values themselves.

## Current state / conventions
`client/src/components/wireframe/WheelLabels.tsx:87-97` memoizes rows from formatted text and colors. Lines 99-112 allocate one CanvasTexture/SpriteMaterial per card; lines 114-172 redraw the whole card when rows change and execute `texture.needsUpdate = true`. Four 480-pixel-wide four-row textures contain approximately 2.75 MiB of base RGBA data per collective refresh, excluding mipmaps; this is not measured driver traffic. Lines 187-193 separately update sprite scale from camera distance. Material/texture disposal already exists at lines 174-180; preserve it.

Use the existing semantic canvas adapter (`client/src/lib/rendering/css-canvas.ts`) and existing color helpers. Do not replace theme tokens with hard-coded colors. Existing Bun assertion style: client/test/wireframe-input-overlay.test.ts.

## Scope
WheelLabels.tsx and minimal Wheel/CarScene/CarWireframe prop plumbing. Explicit playback/seek/recording refresh state may be threaded through LapAnalyse, AnalyseWorkspacePanels, AnalyseTopSection, AnalyseVizPanel, onboarding/steps/WelcomeStep and routes/fm23/cars_.$carOrdinal.tsx. Analysis owns playback/seek state; WelcomeStep owns __setFrame/__pauseAnimation; the car viewer is static. Use LSP references before exported prop changes and update memo comparators. Complete this state plumbing here; do not leave forced-refresh events unwired pending plan 001. A small pure refresh-policy helper and focused boundary tests in client/test are allowed. Plan 001 reuses this source state and imperative update path when replacing the frame driver. No new permanent timers, global store, HTML label conversion or texture atlas.

## Steps
1. Split latest desired card content from last painted content. Preserve current number formatting and row order. Compare all visible inputs, including colors, row presence, theme generation and units; object identity is not a sufficient dirty signal. Keep canvas/material/texture allocation per mounted card.
   Verify: a throwaway card-drawing probe with identical formatted values but new packet objects produces no repaint; changing visible text/color marks a repaint pending.
2. Add a latest-value, leading-and-trailing 100 ms refresh policy for normal playback. First display paints immediately. Consume the newest pending content when due; do not queue every intermediate value. Before plan 001 lands, use the existing frame callback; afterward its accepted frame drives this update. No setInterval and no recurring timer that would defeat paused rendering. Continue sprite positioning/scaling at rendered-frame cadence independently.
   Verify: focused fake-time regression covers burst updates, latest trailing value, unchanged content and the boundary at 100 ms. `bun test client/test/wheel-label-refresh.test.ts` must pass if this policy test is introduced; assert behavior, not implementation fields.
3. Provide an explicit force-refresh generation for seeks, source changes, units/theme edits and requested recording frames. Force refresh bypasses playback throttle but still skips truly identical painted pixels. When playback stops with pending content, paint that latest content on the final scheduled frame. Hide/unmount cancels pending work and disposes texture/material once. Preserve first-frame rendering and row-height changes.
   Verify: actual browser playback stays readable; pause/seek immediately shows target values; unit/theme toggles repaint even without telemetry motion; recording captures exact requested labels rather than the preceding throttled values.

## Commands and proof
- `bun run dev`: use supervised service and actual reported URL; inspect wheel cards at representative zooms.
- `bun run typecheck`, `bun run lint`: exit 0, once after all source edits settle.
- Disposable instrumentation over 5 seconds of continuously changing playback: at most 51 ordinary redraws per card, allowing separately counted forced events; repeating identical visible content causes zero additional redraws after initial paint. Camera motion must still be smooth. Screenshot before/after row appearance, temperature units and paused seeks.
Do not introduce mipmap/filter changes in this plan without separate visual evidence; throttling alone is the requested optimization.

## Done / stop / maintenance
Done: redraw/upload rate follows changed display values and 10 Hz policy, final/forced values are not stale, camera scaling unaffected, resources released, model files unchanged. Remove probe, follow repository release-note workflow after verification, mark plans/README.md DONE. No commit/push unless requested.
Stop if no reliable seek/recording invalidation reaches the card; coordinate explicit plumbing with plan 001 rather than guessing from speed or time gaps. Future visible row fields must join the content comparison, and recording must always bypass the playback throttle.
