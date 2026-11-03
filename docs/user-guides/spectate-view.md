# Spectate View

Open **Compare** and select two different laps on the same track. **Spectate** opens by default; select the **Compare** tab for charts. The existing selectors choose the track, cars, and laps. Links with `view=compare` open charts directly; `view=spectate` links remain supported.

## Replay and alignment

- Play or pause both cars with the playback button or **Space** anywhere on the page, including when a button has focus. Holding Space toggles playback only once; text fields, selectors, and dialogs keep their normal keyboard behavior. Use the slider to scrub and the speed selector to change playback speed.
- The bottom time bar marks lap A's recorded sector boundaries as **S1**, **S2**, and so on. Hover a marker for its cumulative split time; select it to seek there immediately. Markers use lap A's clock in both alignment modes and are omitted when sector timing is unavailable.
- Beneath the time bar, **Balance** shows the canonical Neutral, Understeer, or Oversteer classification when recorded speed, lateral acceleration and yaw rate are valid; estimated per-wheel Slip Angles may refine it. Missing required signals remain unavailable.

- **Per-wheel Slip Angle** in AMS2 Replay is estimated from adjacent recorded vehicle positions and yaw, selected car geometry, and front-wheel steering input. Estimate is unavailable when geometry or required signals are missing, speed is below 1 m/s, timing is invalid, or adjacent samples cross a run boundary or replay gap. It is a history-derived kinematic estimate, not a direct tire measurement; other replay modes retain source telemetry behavior. AMS2 does not output this channel. For AMS2 Volkswagen Polo ID `325487790`, missing exact dimensions use a clearly marked estimate based on road-going Polo proxy dimensions (wheelbase 2.552 m, front track 1.500 m, rear track 1.483 m; [Volkswagen spec sheet](https://www.vw.com.na/wp-content/uploads/2024/09/2024-polo-spec-sheet-1-2.pdf)); these values are not verified for the AMS2 TSI Cup car or its game physics. Exact car geometry takes precedence.
- **Lock cars to same track position** samples each recording at the same physical progress, using each lap's own elapsed time. Turn it off to compare both cars at the same elapsed lap time. Changing alignment does not reset the clock.
- Select a numbered segment to seek to its start. Forward and rewind segment seeks ease in and out over 1.2 seconds, or happen immediately when reduced motion is enabled.
- Returning to Compare preserves the physical cursor location. Returning to Spectate remains paused. Selecting another pair starts a new replay.
- Both tabs share cached comparison data. Switching tabs during loading keeps the original background fetch running; the destination waits for that result instead of starting another request. Recorded replay data also remains cached briefly after leaving the page.
- Car bodies and position markers retain A/B identity colors. Wheels retain Lap Analysis's default rim appearance and recorded tire-temperature colors; lap lines use the selected focus mode.

The scene samples recorded positions and headings at paint time from the same replay clock. A/B position icons identify cars when zoomed out and fade away when the models become large enough to read. Both cars use the same virtual-wheel rendering and telemetry interpretation as Analyse's 3D view, replacing the model's native wheels. Tire colours follow the game's temperature channel and operating thresholds, including surface bands, carcass, or core readings when recorded; missing readings retain the unavailable colour. Front wheels follow the recorded steering input, while per-wheel metric cards are not added. A representative model is labeled rather than presented as the exact selected car. Missing positions, models, or rendering support are reported explicitly.

Suspension springs appear beside all four wheels when you zoom in to the 3D car in Replay or Spectate. Recorded travel animates the springs and chassis; missing or invalid travel hides the springs. Native normalized travel and specified game ranges take precedence. Otherwise, each lap's finite minimum and maximum travel define a shared display scale for its four wheels. This scale is not a physical suspension limit or a wheel-load measurement, and constant travel remains centered.

Drag the scene to tilt the camera and see the spring coils in profile; an overhead view shows their circular tops.

When the replay contract omits vertical position, the scene uses a flat plane; it does not reconstruct elevation. The circuit path can come from the recorded racing line when a curated outline has no validated transform into the recording's coordinate system.

Available track edges use the authoritative game-world coordinates supplied by the track geometry API, with the same axis conversion as recorded telemetry. Spectate does not refit native track geometry to either car's racing line, so taking a tighter line or driving off-track cannot move or resize the circuit. LMU's native outline is also preserved when track limits are unavailable. Unregistered geometry still requires a validated coordinate transform. Missing track edges are not replaced with invented boundaries.

## Focus modes

The separate vertical **Focus** toolbar on the right side of the scene changes the meaning of both cars' lines in the scene and circuit overview. Its icon buttons match the compact left-side toolbar; hover a button for its mode label. It does not change replay timing, alignment, or the recorded telemetry.

- **Inputs** is the default: red for braking, green for throttle, gray for coasting or unavailable inputs. Braking takes precedence.
- **ERS mode** uses recorded deployment modes: None, Medium, Hotlap, and Overtake. This shows the selected deployment mode, not measured electrical power.
- **Balance** uses the same physics-derived Understeer, Neutral, and Oversteer classification as the instruments. Unsupported or missing balance is gray, not neutral.
- **Speed** divides the maximum recorded speed across both laps into three equal bands: Low, Mid, and High. Both laps use the same scale.

Hover the Focus toolbar or focus one of its buttons to reveal the active color legend beside it. Missing or invalid readings remain gray; recording gaps are not connected. In the circuit overview, A is solid and B is dashed. Numbered section badges retain their A − B split colors and click-to-seek behavior.

Zooming out smoothly morphs the recorded racing lines into a schematic strip following the calibrated track centerline. **A is on the left and B on the right**, relative to driving direction. Path positions and widths blend across the zoom range while physical track edges fade out. The fully zoomed-out strip is 48 CSS pixels wide, with 12-pixel colored lanes separated by 28 pixels, so it remains readable instead of shrinking to physical track width. Tire trails and the dotted reference line are removed from the schematic view. If no calibrated centerline is available, Spectate keeps the native view rather than inventing one.

The transition cannot remain halfway finished. After zoom input pauses for 140 milliseconds, Spectate eases to the corresponding stable zoom endpoint over 280 milliseconds: outward to the schematic, inward to the recorded scene. Further zoom input interrupts and retargets the animation. Resizing also settles back to a stable representation; if both separated cars cannot fit the close-up endpoint, Spectate retains the schematic.

Cars and fully opaque A/B badges swap at the transition midpoint without overlapping. Each upright badge stays centered on its own morphing lane at that lap's replay position. Available recorded distance drives progress; interpolated native motion prevents held F1 packets from making badges stop and jump. Genuine stops remain stationary and recording gaps remain disconnected. The schematic camera follows lane progress rather than lateral car movement, and preserves its viewing heading instead of rotating with car yaw, even when **Follow car A direction** is enabled. Manual orbit still works; zooming in smoothly restores car-direction following. The track backbone stays behind both colored lanes throughout.

## Camera and instruments

The scene opens overhead. Scroll or pinch to zoom without changing the camera angle; drag to orbit. Zooming in or out preserves your chosen orientation.

Enable **Follow car A direction** in the left-side vertical toolbar to keep the view aligned behind car A as it turns. If A has no recorded position, the camera follows B's direction instead; if neither car has a position, it keeps its last orientation. Zoom and vertical orbit remain available. Disable the toggle to keep the current world-facing orientation and orbit freely.

Enable **Tire trails** in the same toolbar to show short, traction-colored trails behind all four wheels of both cars. Trails start hidden, follow each car's own replay time, and disappear when recorded positions are unavailable. Toggle them off to clear the view without changing playback or racing lines.

Spectate shares Analyse's real-world car dimensions and 50° camera perspective. The native scene uses 3-pixel track edges and 6-pixel recorded paths. The zoomed-out replacement uses 6-pixel focus lanes with a clear gap inside a wider schematic track strip. These are CSS-pixel widths, independent of physical track width and display pixel density. Multisample antialiasing smooths edges, and rendering follows display pixel density up to 2× resolution.

The compact input overlay contains a live cumulative **A − B** time delta in seconds, a shared A/B speed dial, a centered steering-input scale, individual gears, and paired brake/throttle bars. The delta follows lap A's current physical progress in both alignment modes: green means A is faster, red means A is slower, and equal times are neutral at millisecond precision. Missing timing stays unavailable. Orange and blue identify laps A and B. Steering uses the source's input units; it is not presented as a physical angle unless recorded that way. Unavailable values remain unavailable.

F1 also shows one compact ERS row with each car's recorded deployment mode: **None**, **Medium**, **Hotlap**, or **Overtake**. Mode text uses its mode-specific color; adjacent A/B markers retain the car colors, including when both cars use the same mode. This is a replay indicator, not a control that changes the recording. Missing, stale or unknown modes remain unavailable.

## Telemetry and circuit overview

- The right panel contains numeric channels from either recording, including distinct wheel channels and supported derived metrics. In AMS2 Replay, the **Angle** row shows history-derived per-wheel Slip Angle estimates, **Balance** uses the existing physics-derived status classification, and **Traction** uses recorded wheel rotation with those estimated angles. **Ratio** shows the same estimated longitudinal slip ratio used by Grip Ask and Traction, as a percentage; it uses recorded wheel rotation and vehicle speed, with tire radius inferred when unavailable. **Grip Ask** remains a percentage derived from wheel rotation and estimated angles. Yellow info icons disclose the Ratio and Angle estimates and their methods; none of these estimates represents direct tire measurement. Missing required inputs remain unavailable. It opens on **Inputs**; category tabs filter the inventory, without an All view. Choose **±5 s** or **±10 s** around the fixed center cursor; the browser remembers this choice. Unrecorded portions and invalid or stale samples remain blank. When position lock maps B to a different native lap time, the chart identifies B’s sampled time.

Drag the panel separator or focus it and use Left/Right arrows to resize. Its width is saved separately from Compare's map width. Collapse the panel to expand the scene; reopen it from the right edge. On narrow screens, the panel overlays the scene.

The enlarged circuit overview shows both laps in the selected focus colors. Smaller, sequentially numbered markers sit outside the track with leader lines and spacing to avoid overlaps. Their **A − B** section split colors remain separate: green means A is faster, red means A is slower, and neutral means equal at millisecond precision or timing is unavailable. These are section indices, not corner numbers. Hover a section for its split in seconds, or focus it to hear the split with a screen reader. Splits use elapsed times at each section's physical start and end, not the cumulative lap delta. Select a numbered section to seek to its start.

The gain/loss bar beside the time delta compares the current delta with one replay second earlier. It remains unavailable during the first replay second or when either sample is unavailable.
