# Telemetry semantics

## Native channels remain one-to-one

Every per-game semantic mapping must preserve source meaning, granularity, and provenance one-to-one.

- Map each game-native channel to the narrowest accurate semantic.
- Do not rename a source into a physically different concept. Surface, core, and carcass temperatures are distinct.
- Do not average, merge, or duplicate native channels to manufacture another semantic. Preserve source bands such as iRacing carcass left/middle/right independently.
- Use `unavailable` when a game does not provide a semantic. Never infer or alias a value merely to satisfy a common UI contract.
- Unit conversion may normalize a direct source into the canonical unit, but the mapping must be classified as normalized and retain source provenance.
- Select or combine channels for shared product behavior only in an explicit consumer or documented derivation. Do not encode that projection as a false source mapping.

Example: F1 `tyresSurfaceTemperature` maps to representative surface temperature, while `tyresInnerTemperature` maps to core temperature. Neither maps to an invented carcass average.

See [telemetry reference](telemetry.md) for generated source and availability matrices.
