# F1 25

Utilities for extracting F1 25 ERP spline resources and importing fallback track outlines.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run scripts/games/f1-2025/extract-tracks.ts` | Extract all installed track centerlines and boundaries |
| `bun run scripts/games/f1-2025/erp-extract.ts <file.erp> <pattern> [--output <dir>]` | List, decompress, peek, or write matching ERP resources |
| `bun run scripts/games/f1-2025/erp-reader.ts <file.erp> [--peek [count]]` | Print ERP metadata and optional fragment bytes |
| `bun run scripts/games/f1-2025/parse-ai-spline.ts [file.erp] [output-dir]` | Decode one `aispline` resource into gate JSON |
| `bun run scripts/games/f1-2025/import-tracks.ts` | Download and normalize TUMFTM fallback outlines |

## Inputs and formats

- F1 25 Steam install, with `2025_asset_groups/environment_package/tracks/**/wep/*.erp` archives.
- ERP version 0–4 metadata and fragment tables; compressed fragments use consumer-selected Zstandard/Zlib policy.
- `aispline` and `trackspacespline` payloads use null-separated BXML tokens.
- Optional telemetry outlines under `USER_TRACKS_DIR/f1-2025/recorded-<id>.csv` provide alignment targets.
- Import source is TUMFTM racetrack-database CSV (`x,z,width-right,width-left`).

## Outputs

- `shared/data/tracks/venues/<root>/revisions/<revision-path>/tracks/<layout>/geometry/f1-2025/{centerline.csv,boundaries.json}`; current source uses revision path `current`.
- `shared/data/tracks/venues/<root>/geometry/tumftm/<facts-slug>-{centerline,boundaries}.{csv,json}` remains root-owned shared geometry.
- Manual spline inspection defaults to ignored `scripts/track-data/abu_dhabi_aispline.json`.

## Boundaries

`lib/erp.ts`, `lib/bxml.ts`, and `lib/trackspace-spline.ts` only decode binary data. `lib/geometry-alignment.ts` contains pure geometry math. Entry points own filesystem access, logging, validation, compression choices, and import-time execution.

Focused verification: run ERP reader against a known ERP, run AI spline parser against one archive, then run full extraction with F1 25 installed and inspect generated CSV/JSON counts.
