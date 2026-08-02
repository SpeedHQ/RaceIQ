# Setup range data

Setup Engineer clamps proposed changes to known game limits in
`server/setups/rules/engine.ts`, using ranges from `server/setups/rules/catalog.ts`.

## Sources

| Game | Source | Scope |
| --- | --- | --- |
| Assetto Corsa Evo | Extracted `carsetuplimits` data in `shared/games/ac-evo/setup-ranges.json` | Per car |
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

- A known AC Evo car replaces global ranges with extracted per-car values.
- A field marked `null` for that car is not tunable.
- Missing per-car or per-field data falls back to the game-wide rule.
- Intent clamping operates on the server-side setup snapshot. It does not claim
  that nested Kunos setup-file click indices have the same unit scale.

See [per-car setup range status](../project-status/per-car-setup-ranges.md) for
unresolved data-source work.

## Regenerate AC Evo data

Inspect one car:

```sh
bun run scripts/extract-acevo-setup-ranges.ts --dump <car-model>
```

Regenerate `shared/games/ac-evo/setup-ranges.json` from installed game data:

```sh
bun run scripts/extract-acevo-setup-ranges.ts
```

Review generated changes for lost cars, unexpected `null` fields, unit changes,
and range narrowing before committing them.
