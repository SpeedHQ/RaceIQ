# LMU catalog data differences

Source copied from:

`C:/Users/acoop/orca/workspaces/extractions/grampus/output/lmu/`

Target files updated:

- `shared/games/lmu/cars.json`
- `shared/games/lmu/tracks.json`

## Cars

Current export contains 36 car records. Car IDs, display names, classes, manufacturers, series, engines, and thumbnails remain present.

### Variant/team data

`variantIds` changed to structured `variants` entries:

```json
{
  "id": "911gt3r_2024/85_25_iron71169233",
  "name": "Iron Dames 2025 #85:LM"
}
```

Counts:

- 36 cars.
- 566 structured variants.
- 566 `vehicleNames` entries.
- `vehicleNames` now exposes native LMU car/team names, car numbers, and event suffixes.

Examples of added/available team names:

- `Iron Dames 2025 #85:LM`
- `Manthey Ema 2024 #91:LM`
- `Proton Competition 2025 #60:ELMS`
- `Cadillac Hertz Team Jota ...`
- `BMW M Team WRT ...`
- `Toyota Gazoo Racing ...`
- `AF Corse ...`
- `Algarve Pro Racing ...`
- `United Autosports ...`

The exact names and IDs are in `cars.json`; do not rebuild team aliases manually.

### Removed/replaced car fields

- `variantIds` no longer exists in latest export; use `variants[].id`.
- `modelNames` no longer exists in latest export.
- `variants[].name` is authoritative native car/team display text.
- `vehicleNames` remains available as flattened lookup names.

## Tracks

Current export contains 36 track/layout records and 33 reusable track assets.

Every track now includes:

- `trackAssetId`
- `trackSvg`
- `sectorFractions`

```json
"sectorFractions": [
  0.319105515245215,
  0.7395775065607961
]
```

`boundariesSvg` was replaced by `trackAssetId` plus `trackSvg`.

Track metadata retained:

- Track IDs/layouts.
- Track names and venues.
- Events and locations.
- Lengths and pit-lane speeds.

Geometry assets remain under `shared/games/lmu/tracks/`.

## Data source hashes

- Cars: `e29f60e9ecae38af91a32e0e787b7faefc7ee576ed67da2656cbbbd63c13e35c`
- Tracks: `ab5c507377fb8fde3d7cf8f571015eec048e56b93af7ed1560746b16ba0b98c9`

## Porting checklist

1. Copy latest `cars.json` and `tracks.json` from extraction export.
2. Update consumers from `variantIds` to `variants[].id` / `variants[].name`.
3. Use `vehicleNames` for native car/team lookup.
4. Do not expect `modelNames` in latest export.
5. Preserve all `sectorFractions`; every track has two values.
6. Copy referenced generated track SVG assets.
7. Validate JSON as UTF-8.
