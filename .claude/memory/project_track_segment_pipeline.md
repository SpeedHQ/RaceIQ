---
name: track-segment-pipeline
description: Static corner-name + sector generation pipeline (PR
metadata: 
  node_type: memory
  type: project
  originSessionId: cf4b698a-e9c4-4099-bf7c-534633ca5170
---

Track segment pipeline (PR #84, branch worktree-track-data-pipeline, 2026-07-13). User explicitly rejected any telemetry-derived calibration — all track data from static sources: extracted game centerlines + curated name lists.

- `shared/track-segment-align.ts` — `detectCornerRegions()` (curvature regions, turn-angle kink filter), `alignSegments()` DP matcher (annotations: `group` chicanes, `spans` double-apex, `optional` shallow corners), auto mirror-detection (FM/F1 mirrored vs ACC), `resolveSectors()` corner-anchored.
- `shared/tracks/corner-names/<slug>.json` — curated ordered lists; `bun run tracks:segments --write` persists to meta. Mismatch = loud fail, no write.
- Locale ("generic labels only"): proper nouns canonical untranslated; unnamed corners `T<n>` tokens, straights `""`, client localizes via Paraglide. See [[project-i18n-paraglide]].
- Committed SVG viz per track/game in `test/e2e/output/track-segments/` (lap-svg convention) — segment changes reviewable as diffs.
- Wave 1: spa, monza, brands-hatch. Next: more name lists; AI prompt wiring (getSharedTrackName mapping, seed trackCorners from meta, sector times into prompts) deliberately deferred.
