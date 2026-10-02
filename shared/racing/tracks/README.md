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

### Barcelona layouts
- `catalunya` describes the older 16-turn Grand Prix layout with the final chicane.
- LMU Barcelona 2025, F1 25, and Forza's Grand Prix Circuit select `catalunya-no-chicane`: the official 14-turn layout, with its own facts, guide, and per-game geometry.
- Native geometry is measured independently for each game. The continuous left-hand T10/T11 bend is split at its curvature transition; the following right-hand bands are T12, T13, and final T14, not extra turns on the intervening straights.
- ACC retains the 16-turn chicane layout, including shallow T6 and separate T14/T15 chicane sections. Do not reuse its fractions or final-sector numbering for the no-chicane layout.

### Research-backed turn restoration
The 29 repaired track/game lists use native CSV arc length and circuit-map landmarks, not evenly divided gaps or renamed neighboring corners. Curvature sign is calibrated against a known corner in each coordinate frame; reflected game coordinates do not change real-world handedness. Measured geometry carries `override: true` so regeneration preserves the complete roster.

| Circuit | Repaired games | Reference map |
| --- | --- | --- |
| Barcelona-Catalunya | ACC, F1 25, Forza | [Circuit manual](https://premsa.circuitcat.com/2025/Oficials/2025%20Manual%20del%20Oficial%20de%20Carrera%20%28febrero%29.pdf), [LMU no-chicane layout](https://lemansultimate.com/circuit/circuit-de-barcelona-catalunya/), [ACC layout](https://unitedcorsa.com/en-gb/discover/assetto-corsa-competizione/tracks/barcelona) |
| Donington | ACC, AC Evo | [Official circuit map](https://www.donington-park.co.uk/about/circuit-map) |
| Imola | ACC, AC Evo, F1 25 | [FIA 2025 numbered map, page 2](https://www.fia.com/system/files/decision-document/2025_imola_event_-_circuit_map_-_imola_2025.pdf) |
| Red Bull Ring | ACC, AC Evo, F1 25 | [Official numbered corners](https://www.redbullring.com/en/events-tickets/formula-1/formula-1-circuit/) |
| Laguna Seca | AC Evo | [Official track information and racing lines](https://weathertechraceway.com/pages/track-information) |
| Mid-Ohio | Forza | [Official facility map](https://www.midohio.com/plan-your-visit/facilitymap) |
| Montréal | F1 25 | [FIA 2025 circuit map](https://www.fia.com/system/files/decision-document/2025_canadian_grand_prix_-_event_notes_-_circuit_map_pit_lane_emergency_exits_map_ers_battery_containment_area_red_zones.pdf) |
| Road America | Forza | [Official maps](https://www.roadamerica.com/maps) |
| Road Atlanta | AC Evo | [Official track map](https://www.roadatlanta.com/track-info/about-mrra/track-map) |
| Sebring | AC Evo, Forza | [Official track maps](https://www.sebringraceway.com/track-maps/) |
| VIR | Forza | [Official configurations](https://virnow.com/track/configurations/) |
| Baku | F1 25 | [Formula 1 map](https://media.formula1.com/image/upload/c_fit,h_704/q_auto/v1740000001/content/dam/fom-website/2018-redesign-assets/Circuit%20maps%2016x9/Baku_Circuit.webp) |
| Jeddah | F1 25 | [Formula 1 map](https://media.formula1.com/image/upload/c_fit,h_704/q_auto/v1740000001/content/dam/fom-website/2018-redesign-assets/Circuit%20maps%2016x9/Saudi_Arabia_Circuit.webp) |
| Las Vegas | F1 25 | [Formula 1 map](https://media.formula1.com/image/upload/c_fit,h_704/q_auto/v1740000001/content/dam/fom-website/2018-redesign-assets/Circuit%20maps%2016x9/Las_Vegas_Circuit.webp) |
| Lusail | F1 25 | [Formula 1 map](https://media.formula1.com/image/upload/c_fit,h_704/q_auto/v1740000001/content/dam/fom-website/2018-redesign-assets/Circuit%20maps%2016x9/Qatar_Circuit.webp) |
| Sakhir | F1 25 | [Formula 1 map](https://media.formula1.com/image/upload/c_fit,h_704/q_auto/v1740000001/content/dam/fom-website/2018-redesign-assets/Circuit%20maps%2016x9/Bahrain_Circuit.webp) |
| Shanghai | F1 25 | [Formula 1 map](https://media.formula1.com/image/upload/c_fit,h_704/q_auto/v1740000001/content/dam/fom-website/2018-redesign-assets/Circuit%20maps%2016x9/China_Circuit.webp) |
| Hockenheim | Forza | [FIA numbered GP map](https://www.fia.com/sites/default/files/circuit_map_13.pdf) |
| Silverstone | ACC | [Official circuit map](https://www.silverstone.co.uk/sites/default/files/pdf/British%20GT%202025%20Map.pdf) |
| Spa | AC Evo | [Official numbered GP map](https://www.spa-francorchamps.be/assets/1dc2f8bb-48fc-4ab8-b013-404fc31a0ba3/spagp-map-2024.pdf) |
| Zandvoort | ACC | [Official corner map](https://www.circuitzandvoort.nl/en/corners/) |

Map correspondence matters beyond counts: Montréal T10 is the main hairpin and T11 its weak exit bend; Imola T16 is the right-hand kink before the two Rivazza left-handers; Red Bull Ring T7 is left and T8 right. Spa T15 is Paul Frère, while T16/T17 are Blanchimont. Shanghai T15 uses the secondary hairpin-exit curvature peak, not the nearly straight run to T16.

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
- `bun test test/tracks/model/track-roster.test.ts` checks every committed game's displayed corner list against its layout facts. Expanded `number` + `covers` must match the complete fact roster exactly, including multiplicity; missing, extra, duplicate, and unnumbered turns fail.
- Facts must account for the contiguous official sequence `1..N`. Detector `optional` hints and historical corner-gap allow-lists do not exempt committed segment lists from coverage.
