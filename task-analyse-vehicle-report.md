# Vehicle analysis leaves

Migrated `AnalyseSuspensionPanel`, `AnalyseTireWheelsPanel`, and `AnalyseDynamicsPanel` to semantic analysis frames. Per-wheel catalog values use fixed:4 arrays and explicit `—` unavailable rendering. Native packet and display-packet access removed from these leaves; canonical catalog units retained (m→mm, °C, psi, rad/s, ratios).

`WheelTable` already had no telemetry packet dependency and required no behavioral change.

## Parent prop changes

Parents must pass `frame: SemanticAnalysisFrame` instead of `currentPacket` / `currentDisplayPacket`:

- `AnalyseSuspensionPanel`: `{ frame }`
- `AnalyseTireWheelsPanel`: `{ frame, gameId, units, wearRate }`
- `AnalyseDynamicsPanel`: `{ frame, gameId, units }`

No parent/workspace files were edited in this task.

Verification: `pnpm exec tsc --noEmit -p client/tsconfig.json` passed.
