# Tracks

Track domain owns static track facts, game-specific fractions, and label-ready helpers used by maps, AI prompts, telemetry transforms, and track tooling.
`shared/racing/tracks/` is executable TypeScript. `shared/data/tracks/` is bundled CSV/JSON data; code in this directory consumes or produces those assets.

## Purpose
- Keep track model split between **game-agnostic facts** and **per-game geometry**.
- Provide deterministic segment keying (`tN`, `tN-M`, `sN`) so joins, rendering, and reporting agree.
- Give runtime loaders for guides, outlines, boundaries, and track names used across app surfaces.

## Key modules
- **Core contracts:** `facts.ts`, `geometry.ts`, `keys.ts`, `named-segments.ts`, `segment-label.ts`.
- **Math/data helpers:** `coords.ts`, `projection.ts`, `path.ts`, `sectors.ts`.
- **Track identity/catalog:** `resolve-name.ts`, `catalogs/*`.
- **Persistence and cache:** `storage/files.ts`, `storage/meta.ts`, `storage/cache.ts`.
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
- `shared/data/tracks/meta/<slug>.json`: physical roster only (turn numbers, names, groups, straights).
- `shared/data/tracks/<gameId>/<slug>-segments.json`: geometry only (fraction ranges per segment key).
- `joinSegments` builds display-ready labeled segments from one facts file + one geometry file.
- `splitSegments` is inverse for editors/normalization loops.
- Fact keys come from `keys.ts`; straight keys are `s<number>` and corner keys are `t<number>` or `tN-M`.

## Browser vs Node boundary
### Browser-safe imports
- `facts.ts`, `geometry.ts`, `keys.ts`, `named-segments.ts`, `segment-label.ts`, `projection.ts`, `coords.ts`, `sectors.ts`, `path.ts`, `geometry/points.ts`, `geometry/types.ts`, `curation/join.ts`, `curation/segment-align-detect.ts`, and `curation/segment-align-match.ts`.

### Node-only leaves
- `resolve-name.ts`, `detect-hints.ts`, `storage/*`, `geometry/outlines.ts`, `geometry/extracted.ts`, `geometry/shared.ts`, `recording/*`, `catalogs/*`, `guide/data.ts`, `curation/generate.ts`, `curation/coverage.ts`, `curation/verified.ts`, and `curation/segment-align-validate.ts`.
- These leaves read or write files directly, depend on runtime path resolution, or import another Node-only leaf.
- Browser code should consume normalized values from its data boundary instead of importing these modules.

## Dependency direction
- **Leaf contracts first:** `keys.ts`, `named-segments.ts`, `facts.ts`, `geometry.ts`, `segment-label.ts`, `projection.ts`.
- **Join/read layer:** `curation/join.ts` + `storage/meta.ts` compose leaf contracts.
- **Identity layer:** `catalogs/*` + `resolve-name.ts` maps catalog ordinals to shared slugs.
- **Derived layer:** `recording/*`, `guide/*`, `curation/*` consume identity + storage to produce consumable artifacts.

## Add/extend safely
- Add/modify facts for a layout in `shared/data/tracks/meta/<slug>.json` and keep turn numbering complete and ordered.
- Add/refresh one-game geometry in `shared/data/tracks/<gameId>/<slug>-segments.json` via generation.
- For new game support, add a catalog loader under `catalogs/` and map shared names only when one-to-one equivalent exists.
- For generated geometry, use:
  - `bun run tracks:segments --track <slug> [--game <gameId>]` for dry run.
  - `bun run tracks:segments --track <slug> --write [--allow-fuzzy]` for persistence.
  - `bun run tracks:coverage --write` to sync contribution docs.
- Extend guards with `--verify` only after manual check:
  - `bun run tracks:coverage --verify meta:<slug>`
  - `bun run tracks:coverage --verify segments:<gameId>/<slug>`
- Import explicit leaves (for example, `shared/racing/tracks/storage/meta` or `shared/racing/tracks/curation/generate`); this directory has no barrel contract.

## Verification files
- `shared/racing/tracks/curation/verified.ts` records human sign-off hashes in `shared/data/tracks/verified.json`.
- `shared/racing/tracks/curation/coverage.ts` renders curation coverage.
- `bun run tracks:coverage --write` refreshes the generated coverage tables in the track-curation contribution guide.
