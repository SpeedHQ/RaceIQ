# ACC script tools

ACC track geometry extraction and centreline migration tools.

## Prerequisites

- Windows installation of Assetto Corsa Competizione with `AC2/Content/Cache` containing track `fastlane.ai` files.
- Steam install discoverable through repository Steam-path detection (or use a machine with standard Steam library locations).
- Bun runtime and repository dependencies installed.

## Commands

| Command | Purpose | Inputs |
| --- | --- | --- |
| `bun run scripts/games/acc/extract-tracks.ts` | Extract all available ACC fastlane geometry | Installed ACC cache |
| `bun run scripts/games/acc/centerline-from-boundaries.ts` | Dry-run adopted true-centre migration | Existing `shared/data/tracks/acc/*-boundaries.json` and centerline/raceline CSVs |
| `bun run scripts/games/acc/centerline-from-boundaries.ts --write [slug...]` | Persist centreline/raceline migration | Same generated geometry; optional track slugs |
| `bun run scripts/games/acc/centerline-from-boundaries.ts --all-pending` | Report all pending tracks too | Existing generated geometry |

## Outputs

- `shared/data/tracks/acc/<slug>-centerline.csv`: true boundary midpoint for adopted tracks; racing line remains for pending curation.
- `shared/data/tracks/acc/<slug>-raceline.csv`: preserved fastlane racing line.
- `shared/data/tracks/acc/<slug>-boundaries.json`: extracted left/right edges.

`extractAccTracks` remains owned by `server/games/acc/extract-tracks.ts` and is consumed by the game entrypoint. These scripts do not alter telemetry diagnostics or external callers.

## Focused verification

- Run extraction against an installed ACC cache and inspect extracted count plus output files.
- Run centreline migration without `--write`; inspect shift statistics and adopted/pending labels.
- Use `--write` only after reviewing dry-run output; verify centerline/raceline row counts remain aligned with boundaries.
