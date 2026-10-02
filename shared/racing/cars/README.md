# Cars

Car domain normalizes vehicle identity lookups across games.

## Purpose
- Convert game ordinals into display names and metadata.
- Provide shared lookup utilities for overlays (runtime-discovered cars, per-ordinal names, spec snapshots).
- Keep lookups deterministic and cheap by loading CSV catalogs once into module maps.

## Key modules
- `resolve-name.ts`: top-level entry; tries game adapter resolver first, falls back to Forza name.
- `iracing.ts`: dedicated iRacing catalog primitive; reads `shared/games/iracing/cars.csv` and exposes ordinal, name, path, category, and image URL.
- `fm.ts`: reads `shared/games/fm-2023/cars.csv` and optional generated `car-specs.csv`.
- `f1.ts`: reads `shared/games/f1-2025/teams.csv` and maps team id to car label.
- `acc.ts` + `ac-evo.ts`: consume `kunos-catalog.ts` (`id`, `model`, `name`, `class`); AC Evo also supports a runtime-discovered overlay.
- `kunos-catalog.ts`: shared Kunos CSV loader used by ACC and AC Evo.
- `acc-specs.ts`: static ACC specifications keyed by `CarModelId`.

## Browser vs Node boundary
- `acc-specs.ts` is a pure data leaf and is browser-safe.
- Catalog/name modules are Node-side: they read files directly or import a loader that does. Pass resolved values across the application data boundary instead of importing those modules in a browser bundle.

## Dependency direction
- `resolve-name.ts` delegates to the registered game adapter, then uses the Forza catalog fallback.
- `fm.ts`/`iracing.ts`/`f1.ts` are leaf loaders for their own catalogs.
- `acc.ts` and `ac-evo.ts` share `kunos-catalog.ts`.
- `ac-evo.ts` overlays discovered DB rows without mutating bundled catalogs.
- ACC specs are standalone, direct export map (no catalog fallback).

## Per-game catalogs and shared primitives
- Per-game catalogs remain in `shared/games/<game>/...`:
  - `f1-2025/teams.csv`
  - `fm-2023/cars.csv`, `fm-2023/car-specs.csv`
  - `iracing/cars.csv`
  - `acc/cars.csv`, `ac-evo/cars.csv`
- ACC and AC Evo share the Kunos row contract and indexes through `kunos-catalog.ts`.
- iRacing uses its dedicated `iracing.ts` primitive because its catalog fields and identity model differ from Kunos.

## Add/extend safely
- Treat each `shared/games/<game>/...csv` file as the committed catalog consumed at runtime; restart the process after changing it because loaders cache module-level maps.
- Add a dedicated game module when a new catalog shape is required, then wire its display-name resolver through the game adapter or `resolve-name.ts` as appropriate.
- Inject AC Evo database discoveries through `injectDiscoveredAcEvoCars(...)`; do not add discovered rows to bundled iteration in memory.
- Import explicit leaves; this directory has no barrel contract.

## Unknown values
- Display-name helpers return scoped placeholders such as `Team <id>`, `Car #<ordinal>`, or `Unknown Car`; metadata lookups may return `undefined`.
