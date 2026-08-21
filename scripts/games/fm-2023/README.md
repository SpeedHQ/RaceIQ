# Forza Motorsport 2023

Utilities for extracting track geometry and car dimensions from installed Forza Motorsport 2023 archives.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run scripts/games/fm-2023/extract-tracks.ts` | Extract MLP track centerlines, boundaries, and segment metadata |
| `bun run scripts/games/fm-2023/extract-car-dimensions.ts` | Extract wheel positions and ordinal-keyed car dimensions |

## Inputs and formats

- Forza Motorsport 2023 install discoverable by shared `findForzaInstall` integration.
- Track data in `media/pcfamily/tracks/<track>/ribbon_*.zip`; `AI/Track.geo` and optional `AI/Track.seg` use nested ZIP and Forza LZX containers.
- Track ordinals come from `media/base/ai/tracks.zip` difficulty metadata and `shared/games/fm-2023/tracks.csv`.
- Car data in `media/pcfamily/cars/*.zip`; `Locators.xml` contains wheel transform fields.

## Outputs

- `shared/data/tracks/venues/<root>/revisions/<revision-path>/tracks/<layout>/geometry/fm-2023/centerline.csv`
- `shared/data/tracks/venues/<root>/revisions/<revision-path>/tracks/<layout>/geometry/fm-2023/boundaries.json` (when boundary fields exist; current source uses revision path `current`)
- `shared/games/fm-2023/car-dimensions.csv`

## Boundaries

These scripts own Forza archive traversal, LZX decompression, MLP field decoding, and output generation. Shared Forza archive integrations remain in `shared/integrations/forza`; no F1 ERP decoder is used here.

Focused verification: run each command with Forza Motorsport 2023 installed and inspect extracted point counts, boundary files, and ordinal mapping summary.
