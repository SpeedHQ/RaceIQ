# Spectate acceptance evidence

## Delivered behavior

- Segment seeks take 1.2 seconds with symmetric cubic easing in either direction. Scene poses use the controller's paint-time clock; reduced motion remains immediate.
- Calibrated track edges and both native racing paths remain in recorded coordinates. Both paths use gray/no input, green/throttle and red/braking, with braking precedence and no A/B underlays.
- A/B position labels remain distinct at far zoom and fade out as projected models become readable. Only labels are offset in camera space; native car poses and paths are unchanged.
- Locked progress is registered against each lap's own validated aligned geometry, avoiding amplification of quantized B elapsed clocks without damping or moving recorded poses.
- F1 deployment modes preserve valid serialized enum strings and sample discretely. The four-step horizontal rail keeps separate A/B markers; unknown or stale values remain unavailable. A missing reachable locked position is not replaced with fabricated telemetry.
- Telemetry category tabs filter native descriptors; All restores inventory. ±5/±10-second half-windows share a centered axis and persist through collapse/reopen and reload. Invalid storage defaults to ±10.
- Narrow F1 controls are reachable by scrolling. The representative-model badge no longer overlaps the deployment rail.

## Exercised environment

Actual source application, isolated migrated recordings, FM 3/2, F1 12/11 and ACC selected through existing seeded helpers. Entry points were real Compare routes with `view=spectate`; normal replay/alignment/track requests used the backend, not fake responses. Desktop 1568×905 and narrow 390×844 surfaces were inspected.

Chromium selected WebGL2 through ANGLE SwiftShader. Native GPU/WebGPU performance was not measured. CPU profiling and panel-collapse isolation showed browser-native/software-renderer work dominated the slow headless F1 run; hiding charts did not remove that cost. The continuity test therefore requires both at least 1.5 seconds and more than ten actual rendered samples, rather than assuming a hardware-independent frame rate. It retains the native A/B step-amplification assertion. See [renderer isolation](f1-renderer-isolation.json), [CPU profile](f1-cpu-profile.json), and [native alignment sweep](native-alignment-continuity.jsonl).

## Passing checks

| Check | Observed result |
|---|---|
| Production build | Passed |
| `bun run typecheck` | Passed; client and frontend contract projects checked |
| `bun run lint` | Passed across 32 tasks |
| `bun run i18n:check-keys` | Passed; 2703 keys in every supported locale |
| `bun check --project playwright/tsconfig.json` | Passed |
| Route and changelog tests | 19 passed, 67 assertions |
| Native replay tests, run from `client` | 9 passed, 94 assertions |
| Source-app Compare/data/preferences batch | 18 passed; one obsolete request-count zoom expectation failed |
| Revised observable zoom checks plus sustained F1 | All 5 passed |
| Final near/far camera, distinct labels and layout | Passed |
| Final F1 mode, sustained continuity, mobile rail/playback reachability and badge separation | Passed |

Full gate output: [final-gates.log](final-gates.log). Source execution: [source-regressions.log](source-regressions.log), [source-final.log](source-final.log), [f1-final-layout.log](f1-final-layout.log). The zoom checks now assert actual visible distance bounds and cursor behavior, not whether a cached refinement issues another network request. Hover is refreshed while waiting for replacement chart data.

These are focused executions covering the 22 reachable cases across FM/F1/ACC, not a claim that one final 22-case invocation or the compiled suite passed. Earlier failed intermediate runs are retained as historical evidence and are not passing verification.

## Plan scenario coverage and remaining limits

| Scenario | Evidence / limitation |
|---|---|
| E01 | Real tab/history/cursor round trips and existing Compare route/selection regressions passed. |
| E02 | FM, ACC and F1 native scene integration exercised; real edges/paths and independent model ownership checked. Distinct car-asset combinations are not covered by the available same-car recording pairs. |
| E03 | Real lock/unlock/end behavior and native continuity exercised; sampler boundaries also covered by regression tests. |
| E04 | Actual segment seek, forward-to-backward retarget, pause, scrub and reduced motion exercised. Heading wrap has sampler evidence, not a dedicated real-app wrap fixture. |
| E05 | Native overview/coverage presentation and exclusion of lap-wide issue IDs exercised. Exhaustive source-index/coverage combinations lack dedicated real-app fixtures. |
| E06 | Real ACC recording gap/recovery and fixed centered chart domains exercised; invalid/stale boundaries also covered by sampler tests. |
| E07 | Real channel inventories, input readouts, wheel retention and line input colors exercised. A settings-driven unit-change scenario remains unexecuted. |
| E08 | Pointer/keyboard resizing, width persistence, invalid width, collapse/reopen and overlay behavior exercised. Touch-specific input remains unexecuted. |
| E09 | Desktop/narrow inspection and keyboard controls exercised. Dedicated 1280×800, host fullscreen and reduced-motion camera scenarios remain unexecuted. |
| E10 | Transport failures and normal recovery exercised. The full capture-409/parseError/model-failure/device-loss/stale-pair matrix lacks real-app evidence. |
| E11 | Full replay numeric inventory, scrolling and synchronized rows exercised. |
| E12 | Paused/inactive work and camera settling exercised on WebGL2. Earlier shared Analyse 3D smoke remains valid for unchanged shared model helpers. WebGPU and exhaustive resource-growth/device-loss scenarios are not verified. |
| E13 | Raw string modes compared with actual F1 API recordings, then scrubbed and played; non-F1 omission and mobile reachability exercised. Unknown/stale/discrete mode behavior has sampler evidence; a dedicated equal-mode/invalid-mode real-app fixture remains unexecuted. |
| E14 | Category filtering, keyboard All restoration, unchanged paused clock, ±5 persistence through reopen/reload, and invalid storage fallback passed. |

The original plan's full completion gate remains open for the unexecuted cases above and the existing compiled seeded-suite packaging blocker: `ModuleNotFound resolving "/$bunfs/root/worker.ts"`, followed by unsuccessful capture splitting. That failure was not suppressed or rerun without a backend change. See [original compiled output](seeded-compare-initial.log).

## Visual evidence

- [Final FM far zoom: both labels distinct](fm-spectate-camera-far.png)
- [Final FM close zoom: readable models, labels hidden](fm-spectate-camera-near.png)
- [Final F1 desktop](f1-spectate-desktop.png)
- [Final F1 narrow: labeled representative model, deployment rail and playback](f1-spectate-narrow.png)

Temporary local Playwright configuration was removed; owned acceptance servers were stopped. No staging or commits were performed.
