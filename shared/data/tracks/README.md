# Track data

Static track registry and extracted geometry assets used by `shared/racing/tracks`.

## Purpose
- Canonical registry source-of-truth lives in JSON files:
  - `registry-source/configurations.json` (venue/layout identity + assignments),
  - `registry-source/facts.json` (shared roster and track facts),
  - `registry-source/geometry.json` (per-game geometry),
  - `registry-source/verification.json` (human verification records).
- `shared/data/tracks/registry.sqlite` and `shared/data/tracks/registry-report.json` are generated from source for runtime and audit.
- Store shared outlines, boundaries, detector hints, and guides beside registry source.

## Top-level map
- `registry-source/configurations.json` — canonical venues, layouts, and game assignments.
- `registry-source/facts.json` — canonical shared roster, corner facts, and named groups.
- `registry-source/geometry.json` — canonical per-game sectors and segment fractions.
- `registry-source/verification.json` — canonical human verification ledger.
- `registry.sqlite` — generated projection of source, used at runtime only.
- `registry-report.json` — generated audit output derived from the projection.
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
- `registry-source/{configurations.json, facts.json, geometry.json, verification.json}` are canonical for identity, assignment, facts, geometry, and verification state.
- Authoring APIs edit canonical source first, then regenerate `registry.sqlite` and `registry-report.json`.
- Generated artifacts are never edited directly or exported back into source.
- Runtime builds ship and read `registry.sqlite` only; registry source and report remain development and review artifacts.
- Resolve SQLite or report merge conflicts by merging canonical JSON, then running `bun run tracks:registry`.
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
4. Inspect alignment issues, then persist acceptable source edits with `bun run tracks:segments --track <slug> --write`. Use `--allow-fuzzy` only after reviewing reported mismatch.
5. Manually compare facts to cited circuit source and geometry to rendered/extracted lap before recording sign-off with `bun run tracks/coverage --verify ...`.
6. Run `bun run tracks:registry:check` before publishing or releasing registry updates.
7. Refresh contribution-guide coverage tables with `bun run tracks:coverage --write`.

## Curation expectations
- Preserve core invariant: facts contain classification and names but no fractions; game geometry contains fractions and keys but no names.
- Keep one canonical slug across registry source, per-game assets, guides, detector hints, and verification identities.
- Account for every official turn exactly once and keep turns in racing order. Use `covers` for one physical corner spanning several official numbers.
- Add `optional` or `spans` hints only for demonstrated centerline/detector behavior.
- Do not invent corner names or citations, or mutate generated projection files directly.
- Do not verify data not manually inspected.
