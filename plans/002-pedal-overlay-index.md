# Plan 002: Index pedal overlays without changing visible runs

## Status
- Priority: P1; effort: M; risk: MED; category: perf.
- Planned at: `7cb5fdd53`, 2026-09-22. Depends on: none. Status: TODO.
- Planning only. No code changes or runtime benchmark performed.

## Goal / hard boundary
Replace full-lap per-pose scanning with the existing chunk-AABB indexing approach. Preserve the exact visible pedal overlay. Do not change models, triangles, topology, model assets, materials or visibility rules. No WebGPU migration, telemetry schema changes, pedal calibration fixes or generic spatial-index framework.

## Current state and conventions
`client/src/components/wireframe/InputOverlay.tsx:29` executes:
```ts
for (let sourceIndex = 0; sourceIndex < telemetry.length; sourceIndex++) {
```
The memo at lines 8-108 depends on telemetry and packet position/yaw. It recomputes local positions, offset normals, colors and run splitting at each pose change. Limits: 60 m ahead, 20 m behind, 30 m lateral, radius 60 m; ground y=-0.44; lateral offset 0.1 m. EPS=0.02 and minimum emitted run length=5 currently apply to the existing channel representations. Preserve these expressions, including existing throttle/brake normalization, rather than altering behavior incidentally.

`client/src/lib/wireframe-utils.ts:286-305` builds sequential 64-point chunks with source start/end and world AABBs. `filterByDistanceIndexed` at lines 318-372 skips non-overlapping chunks and closes open runs on gaps. Its current return type does not expose every source index: do not map filtered coordinates back to telemetry with find/indexOf or assume proximity implies temporal continuity.

Tests use bun:test. `test/client/wireframe-utils.test.ts:80-112` compares indexed query output against a simple reference at varied poses. `client/test/wireframe-input-overlay.test.ts:9-19` verifies full-scale pedal color.

## Scope
InputOverlay.tsx, wireframe-utils.ts, client/test/wireframe-input-overlay.test.ts, test/client/wireframe-utils.test.ts. A dedicated pure helper in client/src/lib/wireframe-input-overlay.ts is permitted if needed to keep React separate from index construction/query. No edits to GLBs, CarBody, playback scheduling, or unrelated track renderers in this plan. Use LSP references before changing exported helper contracts; preserve existing callers or migrate all of them cleanly.

## Steps
1. Extract the existing overlay calculation into a pure function without changing semantics. Preserve a simple reference implementation in regression tests for differential comparison, not in production. Add explicit fixtures for self-crossing/loopback tracks, out-of-range gaps, exact window boundaries, short runs, on/off-pedal transitions, empty history and backwards seeks.
   Verify: `bun test client/test/wireframe-input-overlay.test.ts test/client/wireframe-utils.test.ts` exits 0; output points/colors/runs match the previous algorithm within floating-point tolerance.
2. Build immutable history-level data once per telemetry reference: world positions, source indices and pedal values/colors. Reuse buildTrackIndex and its conservative chunk rejection. Add a narrowly scoped source-index-preserving query/visitor rather than a second index implementation. Query cost is O(number of chunks + points in overlapping chunks), not O(visible points) alone. Close runs across skipped chunks and rejected samples. No cursor-only slice: spatially close portions elsewhere in the lap remain governed by existing behavior.
   Verify: the same test command passes all topology and boundary cases. Use a throwaway instrumented query on 100k synthetic samples: rejected distant chunks must cause zero per-sample telemetry reads after index construction. Do not use flaky wall-time assertions in permanent tests.
3. Compute normals using the same visible-run neighbors as the old implementation; precomputing endpoint normals on the entire lap can change clipped endpoints. Reuse cached pedal colors where safe without mutating shared THREE.Color objects. Integrate indexed results into InputOverlay, retaining existing Drei rendering for now; plan 003 owns GPU buffer replacement.
   Verify: existing command passes; actual browser scene at fixed cursors preserves line placement, colors, gaps, and loopback separation. Benchmark 10k versus 100k histories with the same nearby samples; record candidate counts, allocations and time without inventing a speedup threshold.

## Verification commands
- `bun test client/test/wireframe-input-overlay.test.ts test/client/wireframe-utils.test.ts`: all pass.
- `bun run typecheck` and `bun run lint`: exit 0, run once after concurrent work settles.
- `bun run dev`: launch through service supervisor, observe readiness URL, then inspect actual 3D analysis UI with browser automation. Capture before/after fixed-pose screenshots. No test replaces visual confirmation.

## Done / stop / maintenance
Done: production overlay no longer reads every telemetry sample per pose; indexed output matches reference for discontinuities and thresholds; history replacement rebuilds caches; model files unchanged; focused checks and visual proof recorded. Remove throwaway benchmarks, update applicable release notes using repository workflow after verification, mark plans/README.md DONE. No commit/push unless requested.
Stop if current telemetry histories mutate in place and reference-keyed caching would be stale; determine the existing revision/lifecycle mechanism before proceeding. Stop if preserving output requires changing pedal semantics. Future caching must retain source order and rebuild on history/theme changes when cached colors depend on theme.
