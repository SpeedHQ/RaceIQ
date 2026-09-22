# 3D rendering performance implementation plans

Planned against commit `7cb5fdd53` and the inspected working-tree sources on 2026-09-22. These are handoff plans, not implemented fixes. Runtime baselines and implementation verification have not been run.

## Non-negotiable scope

Keep car model triangles and topology unchanged. No GLB regeneration, decimation, LOD generation, model merging, visibility-rule changes, material changes or optimizer changes. Keep the existing Three.js / React Three Fiber / Drei stack. Only scheduling, overlay lookup, line resource reuse, wheel-card refresh and bounded DPR adaptation are authorized.

## Execution order and status

IDs are stable identifiers, not dependency order. Recommended serial order: **002 -> 003 -> 004 -> 001 -> 005**.

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [002](002-pedal-overlay-index.md) | Index pedal overlay history | P1 | M | None | TODO |
| [003](003-persistent-lines.md) | Reuse line buffers and spring geometry | P1 | M | 002 | TODO |
| [004](004-wheel-label-refresh.md) | Throttle card texture updates, preserve forced refresh | P2 | S-M | None | TODO |
| [001](001-scene-scheduling.md) | One playback-aware scene frame driver | P1 | L | 003, 004 | TODO |
| [005](005-adaptive-resolution.md) | Cap-aware adaptive pixel ratio | P2 | M | 001 | TODO |

002 and 004 can run concurrently with separate ownership. 003 and 004 both touch CarScene: serialize their integration or explicitly assign one owner. 001 must reuse the explicit playback/seek state introduced by 004 rather than define another source contract. 005 needs 001's actual scheduling signals, not a generic FPS monitor.

## Execution rules

- Read the selected plan completely. Compare its current-state excerpts with live sources before modifying code. Changes intentionally introduced by prerequisite plans are expected; reconcile against their completed contract, not the old excerpts. Stop on unrelated drift that invalidates assumptions.
- Use LSP references for exported prop/helper changes, update all consumers, remove replaced code. No compatibility aliases or idle polling fallback.
- Do not read node_modules for usage research; use official docs/public source.
- Use actual browser scene verification for visual behavior. Existing unit tests cover pure contracts, not rendering proof. New permanent tests only for plausible boundary/transition bugs; use disposable probes for allocation/performance counts.
- Commands are derived from repository manifests; their successful execution is not claimed by these planning documents. `bun run dev` uses supervised service startup and the actual readiness URL. `bun run typecheck` and `bun run lint` run once after a concurrent batch settles. Focused tests are listed per plan.
- Record baseline and after measurements on the same lap/cursor range, scene toggles, viewport, DPR, cap and device. Separate accepted scene advances, React commits, actual draws, CPU allocations and GPU/resource counters. Never invent an FPS gain from static analysis.
- Capture checksums of the two optimized GLBs before implementation and compare afterward. The source scope must not include CarBody, classify-mesh or model optimization/configuration files.
- After browser proof: remove throwaway probes, update release notes through the repository workflow for applicable user-visible changes, and mark the plan DONE. Do not commit or push unless explicitly requested.

## Findings considered and excluded

- Model triangle reduction, LOD, model merging and dedicated wire topology: excluded by user instruction.
- Renderer/package replacement or WebGPU migration: no evidence requiring it.
- Reworking tire-trail instancing or existing wall allocation: already optimized; retain existing resource patterns.
- Full world-coordinate track rewrite: unnecessary for this cutover; persistent line buffers avoid extra clipping/precision risk.
- Eager model preload cleanup, unrelated telemetry correctness and new graphics UI: outside selected findings.

## Acceptance summary

Pause/static view stops recurring 3D work after camera settling; active work respects configured cadence. Pedal overlay avoids full-history sample visits per pose while preserving run discontinuities. Line resources remain stable after warm-up. Cards refresh changed values at 10 Hz with immediate seek/recording refresh. Resolution adaptation respects deliberate caps and fixed recording quality. All three scene consumers remain functional. Model geometry remains unchanged.
