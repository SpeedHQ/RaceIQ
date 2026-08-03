# Math

Small, dependency-free numeric primitives shared across runtime layers.

## Modules

- `numbers.ts` provides `clamp(value, min, max)`.

## Runtime boundary and dependencies

This directory is browser- and Node-safe. It has no runtime dependencies, side effects, allocation-heavy helpers, or domain knowledge. Domain modules may depend on `shared/math`; `shared/math` must not depend on them.

Add a helper here only when its behavior is general numeric logic with clear boundary semantics. Keep game, telemetry, units, and presentation rules in their owning domains. Import the leaf module directly, for example `shared/math/numbers`; do not add a barrel.
