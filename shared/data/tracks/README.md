# Track data

Static track registry and extracted geometry assets used by `shared/racing/tracks`.

## Purpose
- Store canonical venues, layouts, game mappings, corner facts, per-game fractional geometry, and verification in one bundled SQLite database.
- Store shared outlines, boundaries, detector hints, and guides beside registry.

## Top-level map
- `registry.sqlite` — sole source of truth for canonical identity, game assignments, corner rosters, per-game segment fractions, sectors, and verification.
- `detect-hints.json` — optional curve-detection allowances keyed by track-facts slug.
- `guides/<slug>.json` — authored guidance and corner callouts.
- `tumftm/<slug>-centerline.csv`, `tumftm/<slug>-boundaries.json` — shared baseline geometry.
- `<gameId>/` — extracted centerlines, racing lines, and boundaries.

Per-game asset dirs currently present:
- `acc/`, `ac-evo/`, `fm-2023/`, `f1-2025/`.

## Registry tables
- `venue_nodes`, `layouts`, `game_tracks`: canonical hierarchy and each simulator catalog assignment.
- `track_facts`, `track_corners`, `track_corner_covers`, `track_straights`: game-agnostic physical roster and provenance.
- `game_geometry`, `game_geometry_segments`: sectors and per-game fractional ranges keyed to shared facts.
- `curation_verification`: human sign-off hashes over normalized registry rows.
- Segment keys use shared semantics from `shared/racing/tracks/keys.ts` (`t1`, `t10-11`, `s3`).
- **centerline/raceline CSV**:
  - header `x,z`, one point per row.
- **boundaries JSON**:
  - `leftEdge` and `rightEdge` point arrays, plus source-specific metadata such as `centerLine`, `pitLane`, `coordSystem`, `altitude`, `waypoints`, or `aligned`.
- **detect hints**:
  - `{ [slug]: { [turnNumber]: { spans?, optional? } } }`.
- **guide JSON**:
  - `{ id, locale, character, sources, corners[], priorityCorners }`.
## Sources of truth
- `registry.sqlite` is authoritative for canonical identity, corner numbering/names, groups, named straights, per-game fractional geometry, and curation verification.
- `<gameId>/*-centerline.csv`, `*-raceline.csv`, and `*-boundaries.json` are generated snapshots of game data. Installed game data read by matching extractor is authoritative.
- `tumftm/*` is imported baseline geometry from TUMFTM/racetrack-database; retain source identity when refreshing it.
- `guides/*` and `detect-hints.json` are reviewed, hand-curated inputs. Hints describe detector behavior only and must not carry physical track facts.
- Generation never stamps verification automatically.

## Regeneration
1. Refresh the committed track catalog in `shared/games/<game>/tracks.csv` when game content changes.
2. Run the matching extractor:
   - `bun run extract:tracks:forza`
   - `bun run extract:tracks:f1`
   - `bun run extract:tracks:acc`
   - `bun run extract:tracks:ac-evo`
3. Dry-run alignment with `bun run tracks:segments --track <slug> [--game <gameId>]`.
4. Inspect alignment issues, then persist acceptable registry rows with `bun run tracks:segments --track <slug> --write`. Use `--allow-fuzzy` only after reviewing reported mismatch.
5. Manually compare facts to cited circuit source and geometry to rendered/extracted lap before recording sign-off with `bun run tracks:coverage --verify ...`.
6. Refresh contribution-guide coverage tables with `bun run tracks:coverage --write`.

## Curation expectations
- Preserve core invariant: facts contain classification and names but no fractions; game geometry contains fractions and keys but no names.
- Keep one canonical slug across registry facts, per-game assets, guides, detector hints, and verification identities.
- Account for every official turn exactly once and keep turns in racing order. Use `covers` for one physical corner spanning several official numbers.
- Add `optional` or `spans` hints only for demonstrated centerline/detector behavior.
- Do not invent corner names or citations, hand-edit generated fraction ranges, or verify data that was not manually inspected.
