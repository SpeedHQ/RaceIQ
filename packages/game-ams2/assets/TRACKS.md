# AMS2 track geometry

`tracks.json`, `track-manifest.json`, and `tracks/*.track.svg` come from
SpeedHQ/extractions PR #1 (commit `30c6679`). Regenerate and verify them with
that repository's AMS2 exporter; copy its `tracks.json`, manifest (renamed
`track-manifest.json` here), and `tracks/` SVGs into this asset directory.

The runtime selects an exact layout and reads the named `left`, `right`, and
`center-line` SVG paths. X/Z coordinates are native metres. The renderer must
not fit these edges to an observed driving line. These are AIW road-width
references, not independently verified official track limits.

Only `tracks/*.track.svg` supplies runtime boundary geometry and regression-test geometry. `tracks.json` identifies layouts and SVG paths; boundary JSON files are not used. Unknown layouts or invalid SVGs remain unavailable.
