# ACC script tools

ACC racing-line extraction and direct-bundled authoritative track geometry. Centreline curation remains independent.

## Prerequisites

- Windows installation of Assetto Corsa Competizione with `AC2/Content/Cache` containing track `fastlane.ai` files.
- Steam install discoverable through repository Steam-path detection (or use a machine with standard Steam library locations).
- Bun runtime and repository dependencies installed.
- SpeedHQ/extractions clone with source ACC track SVGs under `output/acc/tracks`.

`fastlane.ai` contains racing-line data; its width offsets are not authoritative track edges. The extractor writes raceline CSVs only. Source `.track.svg` files are authoritative and are bundled directly, byte-for-byte, in `shared/data/tracks/acc`; numeric edge arrays are derived from those SVGs at runtime and cached. No JSON importer or generated boundary JSON is used.

## Commands

| Command | Purpose | Inputs |
| --- | --- | --- |
| `bun run scripts/games/acc/extract-tracks.ts` | Extract ACC fastlane racing lines | Installed ACC cache |

SVG left/right splines are authoritative for track edges. Its embedded `center-line` can cross the infield because source export pairs spline control points with opposite windings (Monza deviates over 280 m); boundary APIs derive centre points from direction-aligned, equal-progress SVG edges instead. Pit lane and racing-line paths remain in SVG. Do not convert or commit boundary JSON. Existing curated centreline CSVs and corner rosters remain unchanged.

## Outputs

- `shared/data/tracks/acc/<slug>.track.svg`: authoritative ACC track geometry, bundled unchanged from SpeedHQ/extractions.
- `shared/data/tracks/acc/<slug>-centerline.csv`: preserved curated centreline (some still follow racing line).
- `shared/data/tracks/acc/<slug>-raceline.csv`: preserved fastlane racing line.
- Numeric geometry for boundary APIs is derived from bundled SVGs at runtime and cached; no boundary JSON is committed.

`extractAccTracks` remains owned by `server/games/acc/extract-tracks.ts` and is consumed by the game entrypoint. These scripts do not alter telemetry diagnostics or external callers.

## Focused verification

- Run extraction against an installed ACC cache and inspect extracted count plus raceline outputs.
- Inspect runtime SVG-derived geometry and cache behavior when validating track consumers.
- Run `bun test test/tracks/visualization/acc-boundary-viz.test.ts` to regenerate all 25 reviewable overlays in `test/e2e/output/acc-boundaries/` (edges, aligned centre, racing line, pit lane).
