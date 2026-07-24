# Race-line-spread hover zoom — design

## Goal

In the Tune Review dashboard (Track Focus → Consistency tab), hovering the
**Race line spread** lane should replace the left track map with a **zoomed-in
section** centered on the cursor's track point, drawing **every clean lap's
racing line** as thin lines so line-to-line divergence is directly visible.
Reverts to the normal full map on mouse-leave.

## Decisions (locked)

- **Placement:** replace the track map in place (morph on hover), revert on leave.
- **Lines:** draw every clean lap's line (needs server to expose per-lap x/z).
- **Zoom window:** fixed metres — **60 m radius (120 m window)** around the
  cursor point. Single tunable const.
- **Trigger:** only the Race line spread lane (not the other consistency lanes).
- **Color:** all laps dim neutral thin lines; the best lap in accent. No heat tint.

## Data source

`server/lap-consistency.ts::computeLineSpreadTrace` already resamples every lap
to 200 `(x, z)` bins (`resampleLap`) then discards the geometry, returning only
the aggregate spread trace. Those per-lap polylines are exactly the "all track
lines" we need. World positions are in metres and self-consistent across laps
(one server pass), so the zoom viewport can compute its own bounds — no
flip/negation handling required (mirrors what `buildGeometry` does internally).

## Changes

### 1. Server — expose per-lap lines

`server/lap-consistency.ts`:
- Add to `LineSpreadTrace`:
  ```ts
  /** Per-lap resampled racing line (200 bins, same fracs as `fracs`), one per
   *  lap that survived resampling. World-space metres. */
  lapLines: { lapId: number; x: number[]; z: number[] }[];
  ```
- Change `computeLineSpreadTrace(laps, corners)` →
  `computeLineSpreadTrace(laps, lapIds, corners)` where `lapIds[i]` pairs with
  `laps[i]`. Track lapId through the resample null-filter so each surviving
  `ResampledLap` keeps its `lapId`; build `lapLines` from the survivors
  (round x/z to 2 dp to bound payload — ~10 laps × 200 × 2 ≈ 4k numbers).
- Empty-trace early returns include `lapLines: []`.

`server/routes/tuning-session-routes.ts` (line-spread handler ~L818):
- Pass `loadedLaps.map(l => l.meta.id)` as the new `lapIds` arg.
- Both empty-return `c.json({...})` literals get `lapLines: []`.

`computeLapConsistencyDelta` shares `resampleLap` but not the new field —
leave its signature unchanged.

### 2. Client — mirror the type

`client/src/hooks/queries.ts` `LineSpreadTrace`: add
`lapLines: { lapId: number; x: number[]; z: number[] }[]`.

### 3. New component — `TrackFocusZoom.tsx`

`client/src/components/tunes/track-focus/TrackFocusZoom.tsx`

Props:
```ts
{
  lapLines: { lapId: number; x: number[]; z: number[] }[];
  bestLapId: number | null;
  cursorFrac: number;          // 0..1, drives the center point
  radiusM?: number;            // default 60
}
```

Render (SVG, same `VIEW=300` box as the map so it swaps cleanly):
- Center = mean of all laps' `(x, z)` at the nearest bin to `cursorFrac`
  (bin = `round(cursorFrac * (BINS-1))`, `BINS = lapLines[0].x.length`).
- Viewport = center ± `radiusM` on each axis → local `px/py` scale that fits the
  window into `VIEW`, Z flipped (`VIEW - ...`) like `buildGeometry`.
- For each lap line: build a polyline of only the points inside the window
  (plus one neighbor each side so segments reach the edge). Best lap →
  `stroke=var(--color-app-accent)` `strokeWidth≈1.4`; others →
  `var(--color-app-text-dim)` `strokeWidth≈0.6` `opacity≈0.5`.
- Cursor dot at center; small "±60 m" scale chip.
- Guard: if `lapLines` empty or `< 2` points in window → render a neutral
  "no line data" placeholder box (same footprint).

Pure/presentational — no data fetching, Storybook-friendly.

### 4. Wire into the view (morph on hover)

State lives in `TrackFocusViewInner` (`TrackFocusView.tsx`): add
`const [zoomActive, setZoomActive] = useState(false)`.

- `ConsistencyLanes`: add prop `onSpreadHover?: (active: boolean) => void`.
  The **Race line spread** `Lane` only: wrap its `onCursorFrac` so entering
  fires `onSpreadHover(true)`, and on null-frac (leave) fires
  `onSpreadHover(false)`. (Lane already calls `onCursorFrac(null)` on leave —
  reuse that; if insufficient, add `onMouseEnter/Leave` on the lane wrapper.)
- `TrackFocusViewInner` passes `onSpreadHover={setZoomActive}` to
  `ConsistencyLanes`, and gates the left column:
  `zoomActive && lineSpread?.lapLines?.length && cursorFrac != null`
  → render `<TrackFocusZoom .../>` else `<TrackFocusMap .../>`.
- `TrackFocusMap` is unchanged (no new props). Zoom is a sibling swap, keeping
  each component single-purpose.

## Testing

- Unit: `computeLineSpreadTrace` returns `lapLines` with correct length/lapIds,
  survives the resample null-filter (a too-short lap is dropped from lapLines
  too), and each line has `BINS` points. Extend existing lap-consistency test.
- Unit: `TrackFocusZoom` center + windowing math (pure helper extracted:
  `zoomViewport(lapLines, cursorFrac, radiusM)` → `{center, inWindow}`), tested
  without React.
- Manual: hover spread lane in a real tune review → map morphs, lines fan out,
  best lap accented; leave → reverts. Other lanes never morph.

## Out of scope

- Track edges inside the zoom (lines only for v1).
- Heat tint, per-lap labels, pinning the zoom.
