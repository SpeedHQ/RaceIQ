---
name: extract-ac-evo
description: Extract AC Evo cars, tracks, track geometry, and setup ranges from the installed game after a game update. Use when AC Evo ships new content, a track has no outline / wrong turn numbers, or a car/track shows as UNKNOWN.
---

# Extract AC Evo Game Data

## Quick start

```bash
bun run extract:ac-evo
```

One command. Runs, in order:
1. **Track roster** — diffs `system\tracks.table` in `content.kspkg` vs `shared/games/ac-evo/tracks.csv`, appends missing rows (variant defaults to `GP`).
2. **Track geometry** — parses each layout's `ideal_line.aisplinedata` protobuf (the game's AI racing line) → `shared/tracks/ac-evo/<slug>-{centerline,raceline}.csv` + `-boundaries.json`, then seeds the layout's two meta halves, each **only if absent**: facts at `shared/tracks/meta/<slug>.json` (unnamed corners, `layout: gp`) and geometry at `shared/tracks/ac-evo/<slug>-segments.json` (fractions + thirds sectors). The halves are seeded independently, so a circuit ACC already curated gets its AC Evo fractions written without touching the shared facts. The ideal line is the game's racing line; AC Evo ships no separate dense centerline, so centerline and raceline share that source (`getTrackRacelineByOrdinal` reads the raceline slot). `trackcontrolpoints` is a sparse edge-control-point spline, not a dense centerline.
3. **Car roster** — diffs `system\cars.table` vs `shared/games/ac-evo/cars.csv`, appends missing.
4. **Setup ranges** — reads each car's `carsetuplimits` → `shared/games/ac-evo/setup-ranges.json`.

Idempotent: re-running with no new content changes nothing. kspkg auto-located (`AC_EVO_KSPKG` env, else common Steam paths — installed at `D:\SteamLibrary\steamapps\common\Assetto Corsa EVO\content.kspkg`).

## The one thing the script CANNOT do alone: geometry mapping for new tracks/layouts

Roster + cars + setup ranges are fully automatic. Track **geometry** is driven by a hardcoded `MAPPINGS` table (`slug → kspkg folder → layout`) in `scripts/extract-ac-evo-tracks-geometry.ts`. A genuinely new track — or a new layout of an existing track (the Brands Hatch Indy case) — will NOT get a centerline until you add a `MAPPINGS` entry. Finish the mapping by hand, then re-run.

### Read the output for gaps

| Output line | Meaning | Action |
|---|---|---|
| `✗ UNKNOWN — not in tracks.csv` / `... missing` | New track auto-appended, variant `GP` | If it's actually an alt layout, fix the appended row's variant + slug (below) |
| `⚠ config "X" does not match resolved variant "Y"` | Game reported a layout with no distinct CSV row (Brands Hatch Indy → GP collision) | Add a variant row + MAPPINGS entry |
| geometry table `status = CHECK` (delta >5%) | Wrong layout picked for that slug | Pick a different layout in MAPPINGS, re-run |
| `[skip] <slug>: no ideal_line entry found` | slug in MAPPINGS but folder/layout name wrong | Fix folder/layout via the probe below |
| slug never appears in geometry table | Not in MAPPINGS at all | Add a MAPPINGS entry |

### Finish the mapping (new track or new layout)

1. **tracks.csv row** (`shared/games/ac-evo/tracks.csv`): `id,name,variant,commonTrackName,setupFolder`. For a **new layout of an existing track**, add a SEPARATE row with a distinct `variant` and a distinct `commonTrackName` slug (e.g. `brands-hatch-indy`) — that slug is the geometry/meta filename.
2. **Discover the kspkg folder + layout name** — list the layouts the game actually ships for that track:
   ```bash
   bun -e 'import{findContentKspkg,Kspkg} from "./server/games/ac-evo/kspkg";const p=Kspkg.open(findContentKspkg());for(const e of p.entries)if(e.path.toLowerCase().includes("brands_hatch")&&e.path.toLowerCase().endsWith("ideal_line.aisplinedata"))console.log(e.path);p.close()'
   ```
   Swap `brands_hatch` for the track's folder. Prefer the `layouts\` copy over any `content\layouts\` duplicate.
3. **Add a MAPPINGS entry** in `scripts/extract-ac-evo-tracks-geometry.ts`:
   ```ts
   { slug: "brands-hatch-indy", folder: "brands_hatch", layout: "layout_indy" },
   ```
   If the track ships NO `ideal_line` at all, add its slug to `SKIP_SLUGS` instead (keeps the ACC-borrowed fallback).
4. **Re-run** `bun run extract:ac-evo` and check the validation table: `delta%` must be within ±5% of the reference length. For tracks ACC never shipped, add a known real length to `CRITICAL_EXPECTED_M` so the check has something to compare (e.g. Brands Hatch Indy ≈ 1929 m). `CHECK` status = wrong layout, try another.

## Key facts

- Protobuf parser lives in `server/games/ac-evo/aispline.ts` (`parseAiSpline`) — testable, no protobuf dependency. Schema: repeated point records, each `{x,y,z}` fixed32 + distance f32 + index varint; `(x,z)` = outline. (field2 is cumulative distance, not width — confirmed it reaches the lap length.)
- **Boundaries must carry `"aligned": true`.** `loadExtractedBoundary()` in `shared/track-data.ts` runs a Procrustes fit on any AC Evo boundary file that isn't flagged pre-aligned (`data.aligned || data.coordSystem === "acc"`) — that fit exists for ACC boundary files *borrowed* by AC Evo and it distorts native, already-telemetry-frame edges (shrinks/rotates them off the driven line). The extractor writes `aligned: true`, so native boundaries are served raw. The boundaries endpoint reads the file per request (no server restart needed — browser refresh suffices); outlines and meta are cached (restart to refresh those).
- **Coordinate frame — files are RAW kspkg coords, flipped at render (same as ACC).** kspkg world X is mirrored vs AC Evo live telemetry `PositionX` (the pipeline negates PositionX for `coordSystem: "standard-xyz"` games). Per `track-coords.ts`, outline/boundary files stay in raw game coords and the map components flip them via `needsTrackFlip()`/`flipPoints()` to match telemetry. So the extractor writes RAW coords — do NOT pre-negate (that double-flips on `AnalyseTrackMap`). Both `AnalyseTrackMap` and `TrackFocusView` apply the flip. Meta corner left/right, however, is derived from a display-frame (X-negated) copy of the centerline so directions read from the driver's view; arc-length fractions are mirror-invariant so they're unaffected. Verified on Brands Hatch Indy: raw spline↔telemetry is a pure X-mirror (negating X drops mean nearest distance ~68 m → ~10 m).
- Geometry pipeline is exported as `extractAcEvoTrackGeometry()` and called from `scripts/extract-ac-evo-tracks.ts`; also runnable standalone via `bun scripts/extract-ac-evo-tracks-geometry.ts`.
- Outline resolution: `bundledGameDir("ac-evo")` → `shared/tracks/ac-evo` first, falls back to `shared/tracks/acc` (`loadBundledPointCsv` in `shared/track-data.ts`). 5 tracks ACC ships but AC Evo's kspkg lacks geometry for (misano, silverstone, catalunya, budapest, zandvoort) stay on the ACC fallback — leave them in `SKIP_SLUGS`.
- Each meta half is written only when absent — the script never clobbers curated data. To re-derive, delete that half first: `shared/tracks/meta/<slug>.json` for the names, `shared/tracks/ac-evo/<slug>-segments.json` for the fractions.
- `autoTrackSegments` emits `T1..Tn` tokens for corners it cannot name. Those are display placeholders, not facts, so they are stripped on write and the seeded facts file has `name: ""` on every corner. Real names are a separate manual step: fill in `corners[].name` in the facts file (or add a curated `shared/tracks/corner-names/<slug>.json` and run `bun run tracks:segments --write`). One edit there names the corner for **every** game that ships the layout.
- After extracting, the **dev server caches meta + outlines** — restart `bun run dev:server` to see new tracks render.
- New content appended to CSVs defaults to variant `GP` — the game's table has no layout list, so alt layouts always need the manual step above plus one drive to confirm the in-game `track_configuration` string.
