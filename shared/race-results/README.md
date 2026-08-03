# Race results

Canonical TypeScript contracts for race outcomes, aggregation, evidence, authority decisions, and provenance.

## Modules

- `types.ts` defines source and outcome statuses, result classification, claim evidence, authority policies and decisions, provenance identities, `RaceResult`, and `RaceResultAggregate`.

## Runtime boundary and dependencies

This directory is type-only and browser-safe. Its only dependency is the canonical `GameId` type from `shared/games/ids`. Database rows, parsers, resolvers, API routes, and client views depend on these contracts; the contracts do not depend on those layers.

Dependency flow is:

`shared/games/ids` -> `shared/race-results/types` -> parser/resolver/database/API/UI consumers

## Extending the contracts

- Add fields only when producers and every transport or persistence consumer can supply or preserve them.
- Keep `unavailable`, `unknown`, `null`, and provisional states distinct; each carries different evidence semantics.
- Extend evidence and provenance alongside the result field they justify so derived data remains auditable.
- Import `shared/race-results/types` directly; do not add a barrel.
