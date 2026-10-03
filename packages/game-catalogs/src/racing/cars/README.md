# Cars

Car domain normalizes vehicle identity lookups across games.

## Purpose
- Convert game ordinals into display names and metadata.
- Keep cross-game name composition separate from metadata-owner catalog primitives.
- Keep lookups deterministic and cheap by loading CSV catalogs once into module maps.

## Key modules
- `@raceiq/game-catalogs/racing/cars/resolve-name`: tries the registered adapter resolver first, then the Forza fallback.
- `@raceiq/game-iracing-metadata/racing/cars/iracing`: reads its own `src/cars.csv` and exposes ordinal, name, path, category, and image URL.
- `@raceiq/game-fm-2023-metadata/racing/cars/fm`: reads its own `src/cars.csv` and `src/car-specs.csv`.
- `@raceiq/game-f1-2025-metadata/racing/cars/f1`: reads its own `src/teams.csv` and maps team IDs to car labels.
- ACC and AC Evo metadata car leaves consume `@raceiq/shared/racing/cars/kunos-catalog`; AC Evo retains its discovered-car overlay.
- `kunos-catalog.ts`: generic shared Kunos CSV loader, with no concrete game imports.
- `@raceiq/game-acc-metadata/racing/cars/acc-specs`: static ACC specifications keyed by `CarModelId`.

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
- Per-game catalogs live in `packages/game-<game>-metadata/src/`:
  - F1: `teams.csv`
  - Forza: `cars.csv`, `car-specs.csv`
  - iRacing: `cars.csv`
  - ACC and AC Evo: `cars.csv`
- ACC and AC Evo share the Kunos row contract and indexes through `kunos-catalog.ts`.
- iRacing uses its dedicated `iracing.ts` primitive because its catalog fields and identity model differ from Kunos.

## Add/extend safely
- Treat each metadata-owner CSV as the committed runtime catalog; restart after changing it because loaders cache module-level maps.
- Add a dedicated game module when a new catalog shape is required, then wire its display-name resolver through the game adapter or `resolve-name.ts` as appropriate.
- Inject AC Evo database discoveries through `injectDiscoveredAcEvoCars(...)`; do not add discovered rows to bundled iteration in memory.
- Import explicit leaves; this directory has no barrel contract.

## Unknown values
- Display-name helpers return scoped placeholders such as `Team <id>`, `Car #<ordinal>`, or `Unknown Car`; metadata lookups may return `undefined`.
