---
name: track-data-sources
description: Track geometry now primarily extracted from FM2023 game files via LZX decompressor; TUMFTM/OSM largely replaced; auto-extracts on startup
type: project
---

Track data extraction from Forza Motorsport 2023 game files completed 2026-03-28.

**Current architecture:** LZX decompressor extracts TrackLimitsCenter, wall data, and altitude from game files on first startup. Track boundaries (left/right edges) computed from extracted data using a linear width model (RMSE 1.6%). This replaces the previous TUMFTM dependency for boundary data.

**Data sources (priority order):**
1. **Game-extracted** (primary) — auto-extracted from FM2023 game files on startup, stored in `shared/track-outlines/` subfolders
2. **Bundled TUMFTM** — academic racing line CSVs, still present for some tracks in `shared/track-outlines/*.csv`
3. **Recorded telemetry** — captured from in-game driving, stored by track ordinal in DB

**Removed:** OSM/Overpass track outlines (removed 2026-03-27, low quality).

**Key files:**
- `server/tracks/calibration.ts` — LZX decompressor, extraction logic, boundary computation
- `shared/track-outlines/index.ts` — track lookup by name/ordinal, manages all sources
- `shared/track-outlines/boundaries/` — left/right edge + pit lane JSONs

**Why:** Game-extracted data is more accurate and complete than external sources. Covers nearly all FM2023 tracks automatically.

**How to apply:** Track extraction is a solved problem for FM2023. When working on track features, game-extracted outlines are the primary source. The extraction runs automatically on first startup with a progress banner in the UI (Settings page also has extraction trigger).
