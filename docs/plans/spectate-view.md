# Spectate View implementation plan

Status: **Planned; production implementation and acceptance tests have not run.**

## 1. Product decision and visual authority

Add **Spectate View** as an additional body-view tab in the existing Compare page. Do not replace Compare, Replay, or Analyse. The current Compare selectors/header remain the sole owner of track, car A/B, lap A/B, and lap-time information.

Use the [supplied reference image](assets/spectate-view-reference.png) for composition, track presentation, visual hierarchy, spacing, and restrained overlays. Use RaceIQ's existing design system for implementation: [client design system](../../client/DESIGN.md), [theme tokens](../../client/src/styles/theme.css), and existing UI primitives. The reference is not authority for competitor branding, navigation, colors, or unrelated features.

The [iterated HTML mockup](../../simple-view-mockup.html) records the agreed body layout and interactions. Its schematic circuit, box-based cars, sample channels, synthetic signals, arbitrary camera distances, and simplified timing are **not production implementations**. Do not copy those data or rendering shortcuts into the app. The reference image is retained with this plan so implementation does not depend on a temporary attachment path.

### Required body composition

- A full-bleed, zoomed-out overhead **3D** track scene, with both cars rendered as car models.
- A semi-translucent, numbered circuit overview in the **top-left, over the render**, not in the telemetry panel.
- A compact, shallow input-comparison overlay at the **bottom-center of the render**.
- A collapsible, resizable **full-height right telemetry panel**. Its height includes the area beside playback.
- Playback/scrubber beneath the render **only**; it must not extend beneath the right panel.
- No extra page header, duplicate lap/car/lap-time block, footer, gray outer shell, or left-hand control rail. Do not remove the host Compare header.
- Black/transparent body surfaces using app tokens. Keep the overview translucent without reducing text/marker opacity. No blur, glow, decorative shadow, or competitor mint-green theme.
- Cyan remains the UI action accent. A/B identities use `--comparison-lap-a` / `--comparison-lap-b` (currently orange/blue), not hard-coded mockup colors. Issue severity uses severity tokens and remains distinct from A/B identity and time delta.
- Geist and the existing `text-app-*` scale; use the rendering color/font bridges for canvas and Three.js. No CDN fonts or duplicated theme palette in production.

### Excluded scope

No webcam, competitor account/navigation/subscription UI, new acquisition/parser behavior, database migration, new car-asset pipeline, replacement renderer stack, redesign of existing Compare charts, or unrelated Analyse/Replay changes. The per-wheel metric cards are disabled **in Spectate only**; this does not remove wheels from the car models or remove genuine wheel-channel charts.

## 2. Verified repository starting points

| Concern | Current contract and implication |
|---|---|
| Compare integration | `client/src/routes/$gameid/compare.tsx` mounts `components/comparison/LapComparison.tsx`. `ComparisonSelectors.tsx` owns existing header controls. Add a body-tab choice below/reusing that header, not a second selector/header inside Spectate. |
| Current Compare state | `LapComparison.tsx` owns selections, chart-distance hover, range fidelity, map width, and AI panel state. It has **no playback controller**. `handleJumpToFrac` changes a hover-distance ref; it is not replay seeking. |
| URL | `client/src/lib/game-routes.ts`: `CompareSearch` has track/car/lap selectors, `cursor` and `ai`, but no view or time parameter. Existing `cursor` is an aligned-trace index, not seconds. |
| Existing comparison data | `hooks/laps.ts` builds `ComparisonData` from `useAlignedTelemetry`; `packages/analysis-core/src/racing/laps/alignment/types.ts` defines per-lap elapsed time, positions, yaw and source indices on a distance grid. A `0.1` detail request is **metres**, not seconds. |
| Actual replay data | `useLapSemanticTelemetry` in `client/src/hooks/laps.ts`; `apps/backend/src/routes/laps/resource-routes.ts` serves `/api/laps/:id/semantic-telemetry` with recorded envelopes, semantic values/states/freshness, insights and detector coverage. Use these for native-time pose and channel sampling. |
| Replay channel inventory | `shared/games/metric-contracts.ts`: `analyseSemanticIds` plus adapter bindings; `shared/telemetry/catalog/query.ts` and `contracts.ts` define metadata/shape/units. The semantic route selects that existing replay set; there is no arbitrary `semanticIds` query parameter. |
| Current charts | `ComparisonCharts.tsx` contains time delta, speed, throttle/brake, RPM and conditional tire wear. This fixed projection is not the complete replay channel inventory. `components/TelemetryChart.tsx` is distance-specific; `components/analyse/AnalyseTelemetryChart.tsx` already has time samples and gap handling. Do not pass seconds under a field labeled distance or reuse a domain-clamping chart unchanged. |
| 3D runtime | `components/wireframe/SceneRuntime.ts` is the current imperative Three.js/WebGPURenderer runtime, with OrbitControls and playback-aware scheduling. It supports **one origin-centered car**, not two world-positioned cars. Historical R3F proposals in `plans/` are not current architecture. |
| Models and resources | `components/wireframe/CarBody.tsx` creates model instances; `CarWireframe.tsx` resolves game/car models but also owns unwanted tire UI. Reuse model resolution/resource helpers, not the entire `CarWireframe` UI or two independent renderers. |
| Geometry | `CompareTrackMap.tsx` already reconciles track/telemetry coordinates; Track Focus uses track boundaries, corners, issues and game-coordinate transforms. Curated segments/sectors remain authoritative under the [track curation rules](../contributing/track-curation.md). |
| Issues | `packages/analysis-core/src/racing/analysis/laps/insights/types.ts` defines `LapInsight.frameIndices`, severity and detector coverage. Those frame indices refer to original decoded packet offsets, **not guaranteed semantic-envelope indices**. |
| Existing E2E | `playwright/tests/seeded/compare/` has real-app pair selection, route/URL, layout, errors and chart coverage. Reuse its `helpers.ts`, shared seeded cases, browser-error collector and isolated seeded server setup. |

### Backend boundary

**No backend implementation or API change is currently required.** Reuse the existing per-lap semantic replay and aligned comparison endpoints. The two sources have different responsibilities: native semantic frames for actual replay; aligned source indices/distance and current Compare outputs for comparison integration and issue localization.

Use Hono RPC and the existing React Query conventions for new query work; include game identity in query keys and `X-Game-Id`. Do not duplicate the existing hook's raw-fetch pattern in a new consumer. Do not add a server selector the existing endpoint does not support. Preserve current response/error contracts: invalid game context 400; missing/wrong-game lap 404; uncommitted capture 409; replay failure 422; a successful response with `parseError` is also unusable replay.

If implementation discovers that an agreed behavior genuinely needs an API/schema change, revise this decision **before** backend implementation: create a shared contract and separate linked UI/backend plans under `docs/plans/`, define the exact boundary and shared E2E ownership, and update this plan's affected acceptance criteria. Do not quietly substitute distance-derived poses or drop channels to avoid that decision.

## 3. Acceptance criteria

Identifiers below are stable; implementation tasks and E2E scenarios reference them.

| ID | Observable acceptance |
|---|---|
| SV-01 | Compare exposes a localized Spectate tab beside its existing analysis body. Switching preserves selected track/cars/laps and the selected physical location. Existing Compare controls, AI behavior, chart zoom and deep links still work. Existing routes without a view parameter continue opening the existing Compare body. |
| SV-02 | Spectate contains only the agreed body composition: no duplicated header/lap times/car details/footer/gray frame/left rail. Reference-led proportions and overlay treatment use RaceIQ tokens, Geist and shared controls, including consistent A/B identity in models, input indicators and charts. |
| SV-03 | A real 3D scene renders two independently owned car-model instances at the correct recorded positions/headings. A/B position icons remain visible when zoomed out and fade away when the projected models become readable. Different supported car selections resolve independently. Actual track edges and both native racing lines remain visible; both lines use gray for no input, green for throttle, red for braking, without A/B line colors or path offsets. Per-wheel metric panels are absent; actual model wheels remain visible. |
| SV-04 | Initial camera is overhead and zoomed out enough to read the track and both cars. Wheel/pinch/zoom controls change zoom; dragging controls yaw/tilt when zoomed in. Crossing the far-zoom band smoothly blends to top-down; zooming back in restores the user's chosen orbit orientation. No left camera widget is added. |
| SV-05 | Top-left overview overlays the render, shows authoritative circuit/segment numbers, both current positions and issue-state legend, remains clickable, and stays visible when telemetry is collapsed. Only its surface is translucent. |
| SV-06 | Selecting a segment seeks to its authoritative start using the shared replay clock over 1.2 seconds with symmetric ease-in-out cubic progress, forward or backward. Cars, follow camera, charts, gauges and scrubber move consistently. Repeated clicks retarget from the currently displayed position; reduced motion seeks immediately. |
| SV-07 | Play/pause, scrubber, elapsed/total time and playback speed operate on one controller. Paint-time poses sample that controller's current recorded time rather than holding a stale published pose between updates. Playback controls occupy only render width. Seeking obeys current play intent; pausing, scrubbing, tab/lap changes and unmount cannot leave competing animation loops running. |
| SV-08 | Position lock defaults on: A/B are sampled at the same physical track progress using each lap's own time mapping. Off: both are sampled at the same elapsed lap time and can visibly separate. Toggling preserves the master replay time, selection and play intent. No lap-duration ratio, shared array index or side-by-side positional offset fakes real-time positions. |
| SV-09 | Telemetry occupies the full right-side body height, including beside playback. Pointer/touch and keyboard resize work within readable bounds, reflow the scene/charts without resetting state, and persist a valid width across close/reopen/reload. Narrow viewports use an overlay rather than crushing the scene. |
| SV-10 | Right panel exposes every existing replay-visible numeric channel/metric available for the selected game and either lap, not the mockup's fixed list. Existing Compare channels remain represented, including delta and supported derived metrics with accurate labels. Native wheel channels remain distinct. One-sided availability is visible rather than hiding both traces or fabricating a second series. |
| SV-11 | Every chart uses a shared relative-time x-axis with current position fixed at center: −5 s to +5 s or −10 s to +10 s according to the selected half-window. Playback, seek, resize and alignment-mode changes update all visible charts together. Near start/end, unused time remains blank; gaps/unavailable/stale values are not joined or replaced with zero. |
| SV-12 | Compact bottom-center input panel has one shared speed dial with A/B needles and readouts, a flat zero-centered steering scale with A's marker above and B's below, separate A/B gear values, and side-by-side A/B vertical brake bars plus side-by-side A/B vertical throttle bars. Values/units come from real semantics. Both markers remain distinguishable when values coincide. |
| SV-13 | Segment colors reflect localized recorded findings and detector coverage: severity wins over nominal; unavailable/unanalysed is distinct from checked/no finding. Delta sign alone never creates an issue. Text/accessible labels communicate state without relying on color. |
| SV-14 | Loading, same/missing lap selection, failed replay/model/renderer, missing pose/geometry, unsupported channels and partial coverage have explicit truthful states. Old requests/models cannot overwrite a newer selection. No synthetic mock telemetry, silent unsupported-car substitution or fake fallback data reaches production. |
| SV-15 | Keyboard-accessible tabs, playback, map segment selection, telemetry collapse/reopen and resize all work; labels/tooltips/copy are localized in every supported `client/messages/` locale. Desktop/fullscreen/narrow layouts do not clip controls or overlap playback with inputs. Fullscreen uses the host's existing entry point rather than recreating page chrome. |
| SV-16 | Paused/hidden/inactive Spectate does not run continuous scene or chart work after camera settling. Active work respects existing FPS settings; geometry/models/charts are not recreated every frame. Switching tabs or pairs disposes owned GPU resources/listeners and does not leak renderers or animation drivers. |
| SV-17 | F1 shows a horizontal recorded battery-deployment mode rail with one labeled step per native F1 mode. A/B markers remain distinct at equal values. Unknown, missing and stale modes are unavailable, not defaulted to None or interpolated into fractional modes. Other games do not show this rail. |
| SV-18 | Category tabs above the telemetry rows filter the existing inventory without changing channel semantics or the replay clock. All restores the full inventory; arrow keys and Home/End operate the tabs. |
| SV-19 | ±5 s and ±10 s controls select the shared chart half-window without seeking or restarting playback. The browser retains the choice through panel collapse/reopen and reload. Invalid or inaccessible storage safely uses the existing ±10 s default. |

## 4. Shared client behavior contract

### 4.1 Ownership, URL and lifecycle

`LapComparison` remains the integration owner. Add a `view` choice (`compare` / `spectate`, default `compare`) to `CompareSearch` and its validator. Keep the current meaning of `cursor`; do not reinterpret an existing index as seconds. Preserve `ai` and all selection parameters when changing views. Do not serialize every playback frame to router history.

Own Spectate state above its conditional body so switching views preserves the last replay location. Bridge the existing Compare distance cursor through an explicit distance-to-A-time lookup when entering Spectate, and publish the current distance back when leaving it. Hover-only movement is not a second replay clock. Leaving Spectate pauses it; returning restores its position without autoplay. Browser back/forward and a new A/B pair must apply the correct view/state rather than a stale ref.

Introduce a typed, Spectate-local controller contract: master time in seconds; duration; playing/playback speed; position-lock mode; seek generation/transition; independent sampled A/B poses and values; selected distance/segment; pause/play/scrub/seek actions. The scene, minimap, instruments and charts read the same snapshot. RAF-dependent state lives in refs/external subscription or the existing imperative pattern, not parent React state updated for every telemetry sample.

Changing game/track/car/lap identity cancels in-flight seeking and old async work, pauses, and initializes the new pair at its first valid location. Exiting/unmounting releases subscriptions and scene resources. A telemetry collapse or resize must not reset this controller.

### 4.2 Recorded time, position lock and interpolation

- Normalize per-lap sample time from valid `timing.current-lap` values with a documented fallback to that lap's monotonic observed timestamp deltas. Detect reset/discontinuity rather than sorting unrelated intervals into a fabricated continuous lap. Never mix wall-clock epochs between recordings.
- Use the semantic state/freshness checks already used by Analyse. Keep validity alongside values. Do not infer unavailable positions from speed, yaw or outline and present them as recorded world positions.
- Normalize distance using the recorded distance origin and the authoritative lap/track progress mapping; do not use sample index divided by sample count. Reuse existing alignment/distance helpers where they preserve this meaning.
- Where validated aligned per-lap X/Z geometry exists, register each native sample's scalar progress against that same lap's recorded path near its aligned timestamp. This removes amplification from quantized elapsed-time plateaus without changing native poses, fitting the two paths together, or smoothing telemetry. Reject unrelated coordinate frames and preserve elapsed-time mapping when spatial registration is unavailable.
- Master duration is the larger valid recorded duration of A/B in both modes, so toggling mode does not change the clock domain. A completed car holds its final valid pose; it does not wrap to the start. Charts outside that lap's recorded domain remain blank rather than extrapolating a held value.
- **Unlocked:** evaluate A and B independently at master time `T` in their own normalized recorded time arrays.
- **Locked:** evaluate A at `T`, obtain A's physical progress `d`, then find B's own recorded time at that same `d`. Do not force the two racing lines onto identical XYZ coordinates. Stationary-distance plateaus use the earliest valid arrival at that distance; interpolation cannot divide by a zero distance interval. If a lap lacks a usable progress mapping, disable position lock with a reason rather than pretending equality.
- Interpolate continuous pose/scalars only between valid adjacent samples in one contiguous run. Use quaternion/shortest-angle interpolation for headings and discrete sampling for gear and F1 deployment mode. Preserve valid serialized deployment enum strings as well as numeric codes; never coerce missing or invalid values into None. Never interpolate across missing runs or a lap reset. Preserve the existing Analyse gap rule unless source cadence requires an explicit, tested cadence-aware validity rule.
- For each chart x-offset `u` in `[−W,+W]`, where `W` is the selected 5- or 10-second half-window, evaluate the same controller mapping at `T + u`. Unlocked uses each lap's native `T + u`; locked maps B through A's progress at `T + u`. Thus the center readouts, models and charts agree. Identify B's actual sampled lap time in tooltips where alignment differs; seconds remain seconds, never relabeled metres.
- A segment seek converts its authoritative start distance to A's valid recorded time, then interpolates the master clock from displayed `T` to that target over 1.2 seconds with symmetric ease-in-out cubic progress. Both directions slow at the endpoints without overshoot. Retarget from the current paint-time position; direct scrubbing cancels the transition. Suspend ordinary clock advancement during the seek and obey the latest play/pause intent afterward.
- The controller exposes a non-publishing paint-time snapshot derived from its same clock anchor and seek transition. The scene samples native poses from it at paint time; React telemetry remains FPS-capped. Pausing and changing speed capture the current clock before changing intent or rate. Do not add independent scene time or artificial position filtering.

### 4.3 Scene, coordinates and camera

Add a dedicated Spectate scene owner using the **current imperative Three.js/WebGPURenderer architecture**. One canvas, one renderer, one camera and two independently owned model instances. Do not mount two `CarWireframe` scenes or turn its origin-centered single-car runtime into an implicit multi-car API.

Reuse `createCarBody`, current model resolution/configuration, resource disposal and playback-aware scheduling patterns. If model lookup must be extracted from `CarWireframe`, extract it once and migrate that consumer without changing behavior. Reuse the repository's documented generic model only when explicitly labeled as generic; an unavailable exact model must not be mislabeled. A model loading error remains visible and retryable without corrupting the other car.

Use one shared world coordinate frame and a nearby shared origin for track and both cars. Apply game coordinate handedness, yaw conventions, outline calibration and any established track transforms consistently. Do not independently fit each racing line to the centerline: that would erase genuine A/B positional differences. Calibrate track geometry into the recorded coordinate system once per pair/track. Include vertical position where actually available; flat geometry is an explicit source limitation, not an invented elevation.

Render authoritative left/right track edges in the calibrated recording frame, using the boundary centerline as their common calibration authority. Never infer road width from an offset racing line. Both native racing paths use the same input colors: gray without input, green for throttle, red for braking, with braking precedence. No A/B underlays or lateral offsets. Keep the actual car models. A/B position icons are fully visible below 14 projected model pixels, fade through 32 pixels, and hide when the model is readable or its pose is unavailable. Recording gaps interrupt paths; retain geometry/material ownership and reuse the existing pixel-ribbon renderer.

Retain user orbit state separately from the effective far-zoom camera. Define a view-local near/far distance band from calibrated world scale; blend elevation and orientation continuously across it, with a stable top-down up-vector and no roll/threshold snapping. Restore user orientation on zoom-in. Frame both cars during follow, adapting required fit when unlocked separation grows; do not silently switch to a close chase camera. Camera drag/wheel/touch events bind to render canvas only and must not steal minimap/chart/resizer gestures. No left control widget is reintroduced.

Keep model meshes/wheels, but never construct per-wheel metric cards or their refresh loops in Spectate. Track paths, model instances and material resources are persistent across frames. Respect renderer backend/error handling; WebGL fallback parity must be exercised, not assumed from the existence of `forceWebGL`.

### 4.4 Minimap, segmentation and issues

Reuse the track query contracts, coordinate transforms and authoritative curated segments/corner numbering. The numbered overview remains independent of chart-panel width/collapse. Hit-test actual segment paths/markers; a marker targets its own segment at a shared boundary. Use existing numbering/labels rather than inventing the mockup's nine segments. Without curated segments, use the application's established fallback segment source and identify absent segment metadata truthfully.

Project findings using the same lap's original-packet-to-distance mapping. `LapInsight.frameIndices` are restored to original decoded packet offsets by `processLap`; the aligned trace's `sourceIndices` references that original telemetry array. Use that association (with bounds/monotonicity validation and explicit localization resolution) to locate findings on track. **Do not index `semanticReplay.envelopes` with an insight frame index or assume envelope `sequence` equals a packet offset.** Unlocalizable/lap-wide findings remain in context text rather than coloring arbitrary segments.

Aggregate the highest localized severity from either lap for a segment; retain A/B attribution in accessible details. Use detector coverage to distinguish checked/no finding, partial coverage and unavailable. An empty findings array alone is not proof of a clean segment. Do not sum overlapping `timeLossS` values or equate elapsed-time delta with a detected fault.

Map localized `info`, `warning` and `critical` findings to `--severity-caution`, `--severity-warning` and `--severity-critical`; use `--severity-nominal` only for no finding under completed applicable checks. Both `checked` and `finding` mean a detector ran; any applicable `unavailable` detector leaves coverage partial unless a localized finding supplies a stronger state. Show that qualification in the legend/details rather than presenting partial checks as universally clean.

### 4.5 Channel registry, inputs and right panel

Build channel descriptors from the existing replay-visible semantic IDs, catalog metadata and existing explicit metric bindings. Take the union across A/B and preserve source shape and availability. This includes current Compare charts and all numeric replay-supported channels, not merely a hand-maintained subset. Flatten only documented numeric shapes into labeled components (for example FL/FR/RL/RR); do not average wheel values into a new physical concept. Preserve source temperature bands and units under the [telemetry semantic rules](../reference/semantics.md). Non-numeric metadata is not a time-series channel; display availability rather than a fake zero series.

Reuse chart rendering, theme, gap and sizing primitives. Keep Compare's distance-chart behavior unchanged. The Spectate renderer accepts relative seconds, a fixed selected `[-W,+W]` domain and an externally controlled center cursor. It must not clamp the domain to the data extent, let hover move the replay cursor, or run independent chart clocks. Draw/update only visible chart rows when the panel scrolls; keep all channels accessible. Category tabs filter descriptors only; All restores the complete inventory. Persist the selected 5- or 10-second half-window under `spectate-chart-window-seconds`, defaulting safely to 10.

Use canonical speed conversion/settings; gear remains discrete. Steering is a signed steering-input position unless the source supplies a true angle. Do not label normalized input as degrees or manufacture an angle; use correct source units/percentage where applicable. The shared steering scale has one zero center, A's vertical marker above and B's below. The shared speed dial uses two distinguishable needles/lengths plus labeled values. Separate A/B gear and paired vertical brake/throttle bars remain readable in the shallow overlay. Use existing control/typography sizing, not unreadable miniaturization to hit a hardcoded mockup height.

F1 adds a horizontal recorded deployment-mode rail, using the unchanged raw code/label contract in [`F1LiveDashboard.tsx`](../../client/src/components/f1/F1LiveDashboard.tsx): 0 None, 1 Medium, 2 Hotlap, 3 Overtake. Read `fuel.ers-deploy-mode` discretely from the same replay snapshots, preserving valid serialized string codes. Separate A/B markers above/below the rail remain distinguishable at equal modes; unavailable or invalid modes never select None. This indicator does not mutate recordings and is absent for other games.

Use an accessible vertical separator with pointer capture, touch support, ArrowLeft/ArrowRight and bounded min/max width. Persist a Spectate-specific width using existing local-storage conventions; do not overwrite `compare-left-column-width`. Invalid/corrupt storage and viewport shrink clamp safely. Resizing reallocates render width, not playback time or data. On narrow viewports the panel overlays the render; its z-order covers the corresponding playback area without reducing its own height. Provide a small right-edge reopen action when closed, not a left rail.

## 5. Edge cases and expected handling

| Case | Handling strategy / expected result | Acceptance / E2E |
|---|---|---|
| Missing selection, same lap twice, mixed/invalid route identity | Preserve existing selector validation and error states; do not fetch or animate an invalid pair. | SV-01,14 / E01,E10 |
| Switch tab while playing/seeking | Pause and cancel transition driver; preserve selected physical location and return paused. Existing Compare receives current distance. | SV-01,06,07,16 / E01,E04,E12 |
| Change A/B or game while models/data load | Cancel/invalidate old generations; no old model, pose, chart or insight may appear on the new pair. | SV-03,07,14,16 / E10,E12 |
| Unequal lap lengths/times; one car finishes first | One stable master time domain; independent clamped end pose, no wrap. Out-of-domain chart portions remain blank. Unreachable locked progress is visibly unavailable. | SV-08,11,14 / E03,E06 |
| Repeated timestamps, stationary distance, lap reset, irregular sampling | Normalize contiguous recorded runs; discrete duplicate handling; no zero-interval division, duration-ratio approximation or interpolation across resets. | SV-03,08,11,14 / E03,E06,E10 |
| Heading crosses −π/+π | Shortest-angle/quaternion interpolation; no full rotation between adjacent samples. | SV-03,06 / E02,E04 |
| Seek backward, last/wrapped segment, repeated clicks, pause during seek | Apply the same bounded ease-in-out cubic progress in either direction to the authoritative target time; current display is the new transition origin. Latest play intent wins; no boundary index overflow. | SV-05,06,07 / E04 |
| Reduced motion | Immediate segment seek and non-animated camera threshold state; same final data/location. | SV-04,06,15 / E04,E09 |
| Telemetry missing/invalid/stale on one side | Other side still shows valid data; affected traces/readouts show unavailable or a gap. No zero filling, semantic aliases or averaging. | SV-10,11,12,14 / E06,E07,E10 |
| Steering has input units, not physical angle | Shared centered input scale uses documented normalized/percentage units; never display a fabricated degree value. | SV-12,14 / E07 |
| Both steering/speed values identical | A/B labels and opposite steering half-lines / distinct needle lengths remain visible. | SV-12 / E07 |
| Findings exist but semantic frame counts differ | Localize via validated original packet source indices; never use envelope offsets. Unresolvable findings remain unlocated. | SV-05,13,14 / E05 |
| Missing detectors, no coverage, partial coverage, lap-wide issue | Unknown/partial state remains distinguishable from checked/no finding; no arbitrary whole-track fault coloring. | SV-13,14 / E05,E10 |
| Outline/boundary coordinates differ from telemetry; missing native pose | One shared calibration; preserve actual A/B separation. Use recorded trace for missing outline where already supported, but no invented world pose. If location cannot be established, explain unavailable scene. | SV-03,05,14 / E02,E10 |
| Missing track edges or racing-line inputs | Render only authoritative edges; do not fabricate a road width. Keep native paths and their gaps; use gray where input is absent/unavailable. Both cars share the same gray/green/red input palette, without A/B line colors. | SV-03,14 / E02,E07,E10 |
| Exact car asset missing or model/backend load fails | Reuse labeled documented generic only when supported; otherwise explicit model/scene error and retry. Never hide one car silently or claim exact geometry. | SV-03,14 / E02,E10 |
| Panel closed, invalid stored width, small viewport, resize mid-seek | Reopen remains reachable; clamp width; overlay on narrow viewport; minimap survives; no clock/selection reset or cropped chart controls. | SV-05,09,15 / E08,E09 |
| Unknown/missing F1 mode or equal A/B deployment modes | Discrete native mode sampling; no fractional state or fabricated None. Keep equal-value A/B markers on opposite sides of the horizontal rail. | SV-17 / E13 |
| Chart near first/last selected half-window | Fixed centered 10- or 20-second axis according to the selected ±5/±10 control; blank outside data. No stretched/clamped domain or artificial flat tails. | SV-11,19 / E06,E14 |
| Quantized B alignment clock | Use validated same-lap spatial progress registration; retain native XYZ/yaw and reject unrelated geometry. B must not amplify elapsed-time plateau steps during locked playback. | SV-03,07,08 / E03,E13 |
| Category changes or invalid chart-window storage | Filter descriptors without seeking; All restores inventory. Preserve valid half-window across reload/collapse; unsupported or inaccessible storage defaults to 10. | SV-18,19 / E14 |
| Renderer device loss / WebGL-only machine | Existing renderer error path or verified fallback; clear failure if unsupported. No claim that a blank canvas is success. | SV-14,16 / E10,E12 |

## 6. Implementation slices and ownership

Names below are proposed new files, not claims that they already exist. Use existing file/component conventions when implementing. One integration owner owns shared contracts and the final Compare merge.

### P1 — Shared controller and Compare tab integration (integration owner)

Owned: `LapComparison.tsx`, `ComparisonSelectors.tsx` only where a tab belongs, `lib/game-routes.ts`, new `components/comparison/spectate/types.ts`, `useSpectatePlayback.ts`, and a `lib/spectate-replay.ts` sampler/index module.

1. Run LSP references before changing exported URL/chart/model contracts; inspect all affected callers.
2. Add typed tab validation, pair lifecycle and explicit Compare-distance/Spectate-time bridge. Keep original Compare body mounted/state-preserved as required without leaving hidden animation work active.
3. Define the shared controller and per-lap validity/index contracts from section 4; keep metadata/preprocessing separate from animation-time sampling.
4. Wire existing semantic replay plus aligned source-index data, preserving cache/query identity and error states. Adapt only touched query work to typed RPC; do not start a repo-wide query migration.
5. Establish deterministic fixture expectations for both lock modes, seek transitions, gaps and index-to-distance associations before P2–P4 depend on them.

Acceptance: SV-01,06–08,14,16; E01,E03,E04,E10,E12.

### P2 — Dual-car world scene and camera (scene owner)

Owned: new `components/comparison/spectate/SpectateScene.tsx`, `SpectateSceneRuntime.ts`, and focused reusable model helpers under `components/wireframe/` only when extraction is necessary.

1. Implement one renderer with two independently resolved/disposed model instances and shared coordinate calibration.
2. Add track/world placement, common-origin precision handling, native pose interpolation and explicit missing-data states.
3. Add overhead follow, orbit gestures, distance-band camera blending and scheduling/disposal. Do not construct wheel metric panels.
4. Resolve materials/fonts through existing rendering bridges and theme variables. Do not modify model topology/assets or regress existing scene consumers.

Acceptance: SV-02–04,07,08,14,16; E02–E04,E09,E10,E12.

### P3 — Body composition, minimap and compact inputs (body owner)

Owned: new `components/comparison/spectate/SpectateView.tsx`, `SpectateOverview.tsx`, `SpectateInputs.tsx`, `SpectatePlayback.tsx`, plus only genuinely reusable map helpers extracted from `CompareTrackMap` / Track Focus.

1. Compose render and telemetry as sibling columns; place playback inside render column and overlay inputs/minimap above it. No app shell/header/footer or left rail.
2. Use authoritative segment numbering, issue localization/coverage and accessible segment hit targets/keyboard controls.
3. Implement shared speed dial, two-sided flat steering scale, separate gear and vertical pedal pairs with actual units/availability.
4. Keep controls and geometry responsive; use existing fullscreen integration, never recreate host chrome.

Acceptance: SV-02,05–07,12–15; E02,E04,E05,E07,E09,E10.

### P4 — Full-height resizable time-window telemetry (charts owner)

Owned: new `components/comparison/spectate/SpectateTelemetryPanel.tsx`, `spectate-channels.ts`, and the smallest shared time-chart extraction required from existing Analyse chart primitives.

1. Build exhaustive replay-visible channel descriptors and explicit existing derived-metric bindings; preserve native shapes/units and A/B availability.
2. Implement selectable ±5/±10-second windows, persisted browser choice, category tabs and one center cursor using the section 4 sampling contract; gaps and lap edges stay blank.
3. Add persistent, keyboard/touch-accessible panel resize/collapse and right-edge reopen. Resize chart/scene canvases through existing sizing utilities, not component remounts.
4. Bound chart work to visible rows; reuse valid prepared data rather than resampling a whole lap on each frame.

Acceptance: SV-02,08–11,14–16,18,19; E03,E06,E08–E10,E12,E14.

### P5 — Integration, localization, acceptance and release note (integration owner)

Owned: final Compare integration, all supported `client/messages/*.json`, focused tests, `playwright/tests/seeded/compare/`, and the applicable user guide / `CHANGELOG.md` entry after runtime proof.

- P2, P3 and P4 can proceed **in parallel after P1's interfaces are agreed**. Use contract-conforming fixtures locally, but remove fake production sources and validate real endpoints before completion.
- One owner coordinates shared chart/model-helper edits. A changed sampling/scene contract must be communicated to all implementers and update this plan and fixture expectations before dependent work continues.
- Run applicable checks after the implementation batch, not independently in each worker. Update user-facing docs/release notes once after passing real-app scenarios. Do not mark this plan implemented because the standalone HTML works.

## 7. End-to-end strategy and acceptance mapping

### Harness and deterministic inputs

Extend the existing Playwright seeded Compare suite rather than creating another server/harness. Proposed files: `playwright/tests/seeded/compare/spectate.spec.ts` and, if needed, adjacent focused lifecycle/availability specs with shared helpers. Navigate to the real `/${game.prefix}/compare?track=...&carA=...&carB=...&lapA=...&lapB=...&view=spectate` entry point using `SEEDED_GAME_CASES`, seeded lap-pair helpers and actual backend responses.

Use the isolated seeded database/capture setup from `playwright/config/` and `tests/support/seeded/`; never seed or reset user data. Verify fixture capabilities before choosing a pair. Include at least two supported game-coordinate systems and distinct supported model selections. Add a minimal deterministic test-only recording/seed fixture when existing captures do not exercise unequal timing, gaps, source-index/coalescing differences or missing channels; ingest it through the existing application recording/seed path. Do not replace the successful production integration with intercepted fake replay responses.

Use real replay/channel/track endpoints for normal, alignment and issue scenarios. Inject only explicit transport failures for failure-path scenarios. Disable network/animation nondeterminism in screenshots without disabling playback logic under test. Use polling/RAF or the existing test clock support, not arbitrary sleep-based timing assertions. Verify renderer/model readiness and actual visible frames, not just canvas existence. Keep any test observation surface read-only and grounded in controller/renderer readiness rather than exposing mutation/debug globals in production.

### E2E scenarios

| ID | Setup and action | Observable result / acceptance |
|---|---|---|
| E01 | Open real Compare with a valid seeded pair and an existing cursor deep link; switch Compare → Spectate → Compare; reload `view=spectate`; use browser back/forward. | Existing header and lap identity are unchanged; default route still opens Compare; physical cursor location round-trips; existing AI/chart controls still work; no duplicate chrome. SV-01,02,15. |
| E02 | Use two distinct model-backed cars on one track, then a second game with different coordinate conventions. Open Spectate, inspect overhead/orbit poses, actual track edges, A/B native paths and model readiness. | Both car instances have their correct identity/heading and remain registered with edges and native paths in shared track coordinates; no wheel cards. Capture native-pose screenshots and verify transformed pose against real data. SV-02–05,14. |
| E03 | Use recorded laps with nonuniform speed and unequal durations; seek a known elapsed time, toggle position lock off/on, then run past the shorter lap's end. | Locked progress matches without forcing XYZ equality; unlocked positions match each lap's independently sampled recorded time; clock does not jump; completed car does not wrap. Charts/inputs agree at center. SV-03,07,08,11. |
| E04 | Select segments forward and backward, including final/wrapped segments; observe early/mid/late progress, retarget, pause or scrub mid-transition, then repeat with reduced motion. | The 1.2-second ease-in-out cubic seek slows at both ends, traverses recorded positions and lands at the authoritative start without overshoot. Paint-time native poses advance smoothly between published snapshots. Latest intent wins; no competing RAF; reduced motion is immediate. Include heading wrap. SV-03,05–07,15. |
| E05 | Use a deterministic capture with localized findings and checked/unavailable detector coverage, including coalesced native ticks. Inspect numbered overview and select affected segments. | Source-index mapping localizes the correct A/B segment even when semantic envelope count differs; severity/unknown states and text are correct; delta alone does not color an issue. Unlocatable findings are not invented. SV-05,13,14. |
| E06 | Play/seek at 0 s, mid-lap, the final selected half-window, and across a recorded data gap; inspect chart axis/cursor and available channels in both ±5/±10 modes. | Every visible chart stays at the selected −W…+W seconds with current time centered; boundaries/gaps are blank; values agree with native samples for both alignment modes; no zero filling or fake tails. SV-08,10,11,14,19. |
| E07 | Use known native speed/gear/pedal/steering values, equal values and normalized steering; change units and inspect both racing lines. | Instruments retain correct identities/units and unavailable sides. Both racing lines use gray without input, green for throttle and red for braking, with braking precedence and no A/B underlay or position offsets. Compare channel inventory against the real replay/catalog union, including native wheel shapes. SV-02,03,10,12,14. |
| E08 | While playing and during a seek, drag/touch/keyboard-resize the right panel; close/reopen; reload; inject invalid stored widths; shrink viewport. | Scene reflows; clock/selection persist; width is clamped/persisted; all channels remain reachable; overview remains visible. Panel bottom equals body bottom and playback right edge equals render right edge. SV-05,07,09,11,15. |
| E09 | Inspect 1568×905 reference-sized desktop, 1280×800, fullscreen host view and 390×844; operate tabs, segment actions, playback, resize and reopen by keyboard; repeat camera zoom with reduced motion. | RaceIQ fonts/tokens and reference composition hold; no gray shell/extra header/footer/left rail; inputs do not overlap playback; narrow panel overlays without truncation; focus and non-color labels remain usable. SV-02,04,09,12,15. |
| E10 | Exercise missing/same selections, capture 409, parseError/422, missing channel/pose/geometry, missing/exact-model failure and stale pair responses. | Each state is truthful and recoverable; successful retry/new pair never displays stale data; unaffected valid side remains useful; no synthetic fallback telemetry. SV-01,03,05,10–14. |
| E11 | Scroll through the full right-panel channel inventory and seek while different chart rows are visible. | Every supported numeric channel/explicit metric is reachable, correctly labeled, and synchronized; channel visibility/virtualization does not change sampling or lose the center cursor. SV-10,11,16. |
| E12 | Repeat play/pause, camera settle, tab switches, pair changes and unmount; run supported WebGPU and forced-WebGL paths or exercise explicit backend-error state. | Paused/inactive view stops recurring work; no renderer/model/listener growth; no duplicate playback clock; existing Analyse/catalog scenes still render after any shared helper extraction. SV-01,03,04,07,14,16. |
| E13 | Open real F1 Spectate, scrub across recorded deployment changes, compare each rail marker with native `fuel.ers-deploy-mode`, then inspect equal modes, unavailable data, and desktop/narrow layout. Open a non-F1 pair. | Four correctly labeled native F1 mode steps; discrete, synchronized A/B markers; unknown values remain unavailable. No rail for other games and no overlap with overview/playback. SV-12,14,15,17. |
| E14 | Open real Spectate, select Inputs, restore All by keyboard, select ±5 s while paused, collapse/reopen and reload, then inject invalid stored window and reload. | Filtered rows retain native IDs; All restores complete inventory. All chart domains become ±5 without clock change, choice survives reopen/reload, invalid storage returns to ±10. SV-11,18,19. |

Every acceptance criterion has at least one production-entry-point E2E scenario above. Pure sampling/lookup tests supplement E03–E07 for timestamp normalization, plateaus, gap boundaries, discrete gears and heading wrap; they do not replace the real-app scenarios.

### Planned commands and evidence

Use current package scripts, not obsolete historical-plan commands. The existing Playwright configuration defaults to compiled server mode; build before that run. Configure `E2E_SERVER_MODE=compiled` and `PW_SERVER_SET=seeded` in the runner environment using the repository's supported cross-platform environment setup.

```sh
bun run typecheck
bun run lint
bun run i18n:check-keys
bun run build
bunx turbo run test --filter=raceiq-e2e -- --project=seeded-e2e seeded/compare/
```

Run focused shared-3D consumer E2E and pure behavioral tests when those inputs change. If `typecheck --affected` reports zero tasks, run `bunx turbo run typecheck --filter=client` explicitly rather than claiming client code was checked. The changelog test has moved from the root path mentioned in AGENTS.md: when `CHANGELOG.md` changes, run the verified current path, `bun test packages/tooling-release/test/changelog.test.ts --timeout 60000`.

Record each E01–E14 outcome, fixture/game/pair, renderer backend, command and screenshots/traces in the implementation PR or a linked durable evidence report. Use the existing Playwright output/trace conventions; do not turn this plan into an append-only log. Capture representative desktop/narrow frames against the supplied reference **and** RaceIQ's design system; pixel identity to competitor chrome is not the acceptance target.

## 8. Completion gate

Implementation is complete only after all SV criteria and relevant edge cases have passing E2E evidence, existing Compare regression scenarios still pass, both model instances and real replay integration have been exercised, and applicable typecheck/build/lint/i18n/doc gates pass. Missing graphics capability, seed assets or fixture coverage is an explicit verification blocker, never a passed scenario. A planned, skipped or mock-only scenario is not evidence.

Implementation and verification outcomes are recorded in the [acceptance evidence](evidence/spectate-view/acceptance.md). The compiled seeded-suite migration-worker packaging failure and explicitly unexecuted scenarios remain separate acceptance limits; focused source-app evidence must not be described as a passing compiled suite or complete original-plan acceptance.
