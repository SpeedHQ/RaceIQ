# Setup range data

Setup Engineer clamps proposed changes to known game limits in
`server/setups/rules/engine.ts`, using ranges from `server/setups/rules/catalog.ts`.

## Sources

| Game | Source | Scope |
| --- | --- | --- |
| Assetto Corsa Evo | Curated `carsetuplimits` data in `packages/game-ac-evo-metadata/src/setup-ranges.json` | Per car |
| Assetto Corsa Competizione | Conservative `RULES.acc` click-index limits | Per game |
| F1 2025 | Observed limits from bundled community setups | Per game |

AC Evo is the only adapter with authoritative per-car minimum, maximum, and step
data. Entries use flat telemetry setup-snapshot fields and currently cover 68
cars.

ACC setup files use Kunos click indices. No verified per-car source or
click-to-physical-unit conversion is available, so one conservative rules table
applies to every car.

F1 limits are observations from the bundled setup catalog. They describe data
RaceIQ has seen, not guaranteed simulator limits.

## Runtime behavior

- A known AC Evo car replaces global ranges with curated per-car values.
- A field marked `null` for that car is not tunable.
- Missing per-car or per-field data falls back to the game-wide rule.
- Intent clamping operates on the server-side setup snapshot. It does not claim
  that nested Kunos setup-file click indices have the same unit scale.

See [per-car setup range status](../project-status/per-car-setup-ranges.md) for
unresolved data-source work.

Update this committed catalog only from verified source data, with reviewed diffs.

## Bounds and AI validation checklist

These are acceptance requirements for [adding game setup support](adding-game-setup-support.md), not a claim that all existing adapters meet them. Existing fallback and observed-range behavior above must not be mistaken for verified simulator limits.

- [ ] **Bounds for every changeable value:** provide verified minimum, maximum, step/increment, units, and allowed discrete values where applicable. Scope limits to the correct game, car, and setup format/version; document the source and any parameter dependencies. Distinguish file click indices from displayed physical values and validate conversions.
- [ ] **Unknown or fixed values:** fields without verified limits, or fields that are not tunable for the selected car, must not be editable or changeable by experiments AI. Preserve them on export; do not invent bounds or apply another game's/car's limits. A game-wide range is acceptable only when verified for the selected car.
- [ ] **Experiments AI constraints:** expose the same applicable bounds and allowed values to Setup Engineer that the editor and file generator use. Enforce them server-side when applying AI changes and before saving a setup version or generating a file; prompt instructions alone are insufficient. Validate the resulting complete setup, including dependent-field constraints, after any clamping or step quantization.
- [ ] **Invalid changes:** handle out-of-range, off-step, non-finite, unsupported-enum, and incompatible dependent-field values explicitly through existing setup-rule behavior. Never save or export an invalid generated setup; report rejected or adjusted AI changes rather than silently presenting the original proposal as applied.
- [ ] **Bounds regression coverage:** verify valid endpoints and steps, just-outside limits, invalid discrete values, unknown/non-tunable fields, car-specific limits, and dependent-field constraints. Exercise AI change application through server validation and file generation; confirm invalid proposals cannot produce invalid saved versions or exported files, and valid generated files round-trip with the intended values.

