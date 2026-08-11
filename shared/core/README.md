# Core

Small dependency-free primitives shared across domains.

## Modules

- `csv.ts` exports `parseCsvLine`, including quoted fields and escaped quote pairs. Callers own trimming, header handling, and typed conversion.
- `numbers.ts` exports `clamp(value, min, max)`.

## Boundary

Core modules are browser- and Node-safe. They contain no game, telemetry, unit, persistence, presentation, or filesystem policy. Domain code may import core leaves; core must not import domain code.

Use explicit imports such as `@shared/core/csv` and `@shared/core/numbers`.
