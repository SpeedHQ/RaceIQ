# Tracks

Track domain owns static track facts, game-specific fractions, and label-ready helpers used by maps, AI prompts, telemetry transforms, and track tooling.
`shared/racing/tracks/` is executable TypeScript. Four JSON files in `shared/data/tracks/registry-source/` are canonical registry source; runtime ships and reads generated `shared/data/tracks/registry.sqlite` only.

## Purpose
- Keep track model split between **game-agnostic facts** and **per-game geometry**.
- Provide deterministic segment keying (`tN`, `tN-M`, `sN`) so joins, rendering, and reporting agree.
- Give runtime loaders for guides, outlines, boundaries, and track names used across app surfaces.

## Key modules
- **Core contracts:** `facts.ts`, `geometry.ts`, `keys.ts`, `named-segments.ts`, `segment-label.ts`.
- **Math/data helpers:** `coords.ts`, `projection.ts`, `path.ts`, `sectors.ts`.
- **Track identity/catalog:** `configuration.ts`, `registry.ts`, `resolve-name.ts`, `catalogs/*`.
- **Persistence and cache:** `registry.ts`, `storage/files.ts`, `storage/meta.ts`, `storage/cache.ts`.
- **Geometry sources:** `geometry/outlines.ts`, `geometry/extracted.ts`, `geometry/shared.ts`.
- **Runtime capture:** `recording/outlines.ts`, `recording/curbs.ts`.
- **Curation pipeline:** `curation/generate.ts`, `curation/join.ts`, `curation/segment-align-detect.ts`, `curation/segment-align-match.ts`, `curation/segment-align-validate.ts`, `curation/verified.ts`, `curation/coverage.ts`.
- **Authored guides:** `guide/data.ts`, `guide/types.ts`.

## Folder layout (nested)
- `catalogs/`
- `storage/`
- `geometry/`
- `recording/`
- `curation/`
- `guide/` — contracts and loaders for static data in `shared/data/tracks/guides/`.

## Data split and join contract
- `registry-source/facts.json` contains physical roster only: turn numbers, names, groups, and straights.
- `registry-source/geometry.json` contains per-game fractional ranges and sectors only.
- Generated `track_facts`, `track_corners`, `track_straights`, `game_geometry`, and `game_geometry_segments` SQLite rows project that source for runtime queries.
- `joinSegments` builds display-ready labeled segments from facts plus one game's geometry.
- `splitSegments` is inverse for editors and normalization loops.
- Fact keys come from `keys.ts`; straight keys are `s<number>` and corner keys are `t<number>` or `tN-M`.

## Registry ownership
- `registry-source/configurations.json`, `facts.json`, `geometry.json`, and `verification.json` are editable authority.
- `registry.sqlite` and `registry-report.json` are generated downstream. Do not edit rows or export SQLite back into source.
- Authoring APIs update canonical source first, then refresh generated projection and report.
- Resolve SQLite or report merge conflicts by merging source JSON, then running `bun run tracks:registry`.
- Check source and generated artifacts with `bun run tracks:registry:check`.
- Runtime builds package `registry.sqlite` only; source JSON and report remain development artifacts.

## Browser vs Node boundary
### Browser-safe imports
- `facts.ts`, `geometry.ts`, `keys.ts`, `named-segments.ts`, `segment-label.ts`, `projection.ts`, `coords.ts`, `sectors.ts`, `path.ts`, `geometry/points.ts`, `geometry/types.ts`, `curation/join.ts`, `curation/segment-align-detect.ts`, and `curation/segment-align-match.ts`.

### Node-only leaves
- `registry.ts`, `resolve-name.ts`, `detect-hints.ts`, `storage/*`, `geometry/outlines.ts`, `geometry/extracted.ts`, `geometry/shared.ts`, `recording/*`, `catalogs/*`, `guide/data.ts`, `curation/generate.ts`, `curation/coverage.ts`, `curation/verified.ts`, and `curation/segment-align-validate.ts`.
- These leaves access SQLite or files, depend on runtime path resolution, or import another Node-only leaf.
- Browser code should consume normalized values from its data boundary instead of importing these modules.

## Dependency direction
- **Leaf contracts first:** `keys.ts`, `named-segments.ts`, `facts.ts`, `geometry.ts`, `segment-label.ts`, `projection.ts`.
- **Join/read layer:** `curation/join.ts` + `storage/meta.ts` compose leaf contracts.
- **Identity layer:** `catalogs/*` + `resolve-name.ts` maps catalog ordinals to shared slugs.
- **Derived layer:** `recording/*`, `guide/*`, `curation/*` consume identity + storage to produce consumable artifacts.

## Add/extend safely
- Add or modify layout facts through `saveTrackFacts`; keep turn numbering complete and ordered.
- Add or refresh one-game geometry through `saveTrackGeometry` or track-segment generation.
- These authoring APIs mutate canonical JSON source, then rebuild generated SQLite and report artifacts.
- For new game support, add a catalog loader under `catalogs/` and map shared names only when one-to-one equivalent exists.
- For generated geometry, use:
  - `bun run tracks:segments --track <slug> [--game <gameId>]` for dry run.
  - `bun run tracks:segments --track <slug> --write [--allow-fuzzy]` for persistence.
  - `bun run tracks:coverage --write` to sync contribution docs.
- Extend guards with `--verify` only after manual check:
  - `bun run tracks:coverage --verify meta:<slug>`
  - `bun run tracks:coverage --verify segments:<gameId>/<slug>`
- Import explicit leaves (for example, `shared/racing/tracks/storage/meta` or `shared/racing/tracks/curation/generate`); this directory has no barrel contract.

## Verification
- `curation/verified.ts` records human sign-off in canonical `registry-source/verification.json`; generated SQLite mirrors that ledger.
- Generation never creates or stamps verification. Only a human reviewer may use `--verify`.
- `curation/coverage.ts` renders curation coverage.
- `bun run tracks:coverage --write` refreshes generated coverage tables in track-curation contribution guide.
