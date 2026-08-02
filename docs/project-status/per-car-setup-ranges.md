# Per-Car Setup Ranges Status

AC Evo per-car setup range extraction and server-side rule narrowing are implemented. Source and regeneration guidance lives in [Setup range data](../contributing/setup-range-data.md).

## Current behavior

- `scripts/extract-acevo-setup-ranges.ts` extracts per-car availability and real-value ranges from installed AC Evo data.
- `shared/games/ac-evo/setup-ranges.json` is the committed generated dataset.
- `server/ai/tune-rules.ts` narrows AC Evo rules by car and falls back to game-level rules for unknown cars.
- ACC continues to use game-level clamps.
- Client setup controls are not narrowed from AC Evo data because UI values use nested click indices while extracted values use real units. No verified conversion exists.

## Remaining work

- Derive observed ACC ranges from community setup data, grouped by stable car model identity.
- Define curated ACC overrides for known availability and true click limits. Observed min/max values are evidence of use, not authoritative game bounds.
- Treat constant observed fields as curation candidates; do not automatically mark them unavailable.
- Verify ACC community car IDs against in-game model IDs before loading per-car tables.
- Decide how wet and dry compound pressure ranges are represented.
- Extract or otherwise establish verified click-to-real-value mappings before using AC Evo range data to clamp or hide client controls.

## Safety rules

Unknown cars retain conservative game defaults. Missing or unverified component data must not fabricate availability, range limits, or unit conversions.
