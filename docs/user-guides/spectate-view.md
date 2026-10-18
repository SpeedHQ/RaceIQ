# Spectate View

Open **Compare**, select two different laps on the same track, then select **Spectate**. The existing Compare selectors remain the place to choose the track, cars, and laps. Links with `view=spectate` open this body directly; ordinary Compare links retain the existing charts.

## Replay and alignment

- Play or pause both cars with the playback button. Use the slider to scrub and the speed selector to change playback speed.
- **Lock cars to same track position** samples each recording at the same physical progress, using each lap's own elapsed time. Turn it off to compare both cars at the same elapsed lap time. Changing alignment does not reset the clock.
- Select a numbered segment to seek to its start. Forward and rewind segment seeks ease in and out over 1.2 seconds, or happen immediately when reduced motion is enabled.
- Returning to Compare preserves the physical cursor location. Returning to Spectate remains paused. Selecting another pair starts a new replay.

The scene samples recorded positions and headings at paint time from the same replay clock. A/B position icons identify cars when zoomed out and fade away when the models become large enough to read. Model wheels are retained, but per-wheel metric cards are not added. A representative model is labeled rather than presented as the exact selected car. Missing positions, models, or rendering support are reported explicitly.

When the replay contract omits vertical position, the scene uses a flat plane; it does not reconstruct elevation. The circuit path can come from the recorded racing line when a curated outline has no validated transform into the recording's coordinate system.

Available track edges share the calibrated coordinates of the cars. Both recorded racing lines use the same colors: **gray** for no input, **green** for throttle, **red** for braking. Braking takes precedence. There are no A/B line-color underlays or artificial path offsets. Missing track edges are not replaced with invented boundaries.

## Camera and instruments

The scene opens overhead. Scroll or pinch to zoom; drag to orbit at closer zoom levels. Zooming out blends back toward an overhead view.

The compact input overlay contains a shared A/B speed dial, a centered steering-input scale, individual gears, and paired brake/throttle bars. Orange and blue identify laps A and B. Steering uses the source's input units; it is not presented as a physical angle unless recorded that way. Unavailable values remain unavailable.

F1 also shows a horizontal battery-deployment mode rail: **None**, **Medium**, **Hotlap**, **Overtake**. Separate A/B markers show the recorded mode, including when both cars use the same mode. This is a replay indicator, not a control that changes the recording. Missing, stale or unknown modes remain unavailable.

## Telemetry and findings

The right panel contains numeric channels from either recording, including distinct wheel channels and supported derived metrics. Category tabs filter the inventory; **All** restores every channel. Choose **±5 s** or **±10 s** around the fixed center cursor; the browser remembers this choice. Unrecorded portions and invalid or stale samples remain blank. When position lock maps B to a different native lap time, the chart identifies B's sampled time.

Drag the panel separator or focus it and use Left/Right arrows to resize. Its width is saved separately from Compare's map width. Collapse the panel to expand the scene; reopen it from the right edge. On narrow screens, the panel overlays the scene.

Circuit segment colors summarize localized recorded findings, not elapsed-time delta. Detector coverage distinguishes completed checks from partial or unavailable analysis. Open **Insights** in the overview for finding details; findings that cannot be associated with a recorded packet location are not assigned to an arbitrary segment.
