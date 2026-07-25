# Tune Setup Ranges

How the AI tune engineer clamps setup values per game, and where the limits come from.

## Data sources per game

| Game | Source | Granularity |
| --- | --- | --- |
| AC Evo | Extracted from the game's `carsetuplimits` files into `shared/games/ac-evo/setup-ranges.json` (68 cars) | **Per-car** min/max/step |
| ACC | Hand-set global clamps in `server/ai/tune-rules.ts` (`RULES`) | Global (all cars) |
| F1 2025 | Observed min/max across the bundled community setup catalog | Global (all teams/tracks) |

## Limitation: only AC Evo has real per-car tuneable ranges

- **AC Evo** is the only game with authoritative, game-provided per-car min/max/step for
  tuneables. Values are real-world units (mm, %, psi) keyed by flat telemetry-snapshot
  field names, looked up by `carModel` at tune time.
- **ACC** — no per-car data source found; conservative global click-index clamps are shared
  by all cars and `carModel` is ignored.
- **F1 2025** — ranges are observed from community setups, not game-provided limits; they
  may be narrower than what the game actually allows.

## Other caveats

- AC Evo clamping applies to server-side intent clamping only. The client setup form
  (nested Kunos click-index JSON) is NOT clamped by this data — there is no verified
  click↔real-unit conversion.
- An AC Evo car missing from the extracted set (not one of the 68) silently falls back to
  the global per-game defaults; no warning is surfaced to the user.

## Regenerating AC Evo ranges

Run `bun run scripts/extract-acevo-setup-ranges.ts --dump <someCar>` to inspect a car's
raw limits, or without flags to re-extract and rewrite
`shared/games/ac-evo/setup-ranges.json` from the installed game data.
