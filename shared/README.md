# Shared modules

Cross-runtime contracts, pure helpers, game adapters, and checked-in racing data used by client, server, scripts, and tests.

## Umbrellas

- `core/` — dependency-free CSV and numeric primitives.
- `data/` — checked-in setup, track, and tune assets copied into production data.
- `games/` — game IDs, adapter contracts, registration, and per-game metadata.
- `integrations/` — AI prompt policy, Forza extraction support, and MoTeC import contracts.
- `platform/` — HTTP schemas, locale metadata, and source/compiled runtime paths.
- `racing/` — cars, tracks, laps, sessions, setups, tuning, experiments, results, and analysis.
- `telemetry/` — normalized packet contracts, catalog, resolver, derivations, and replay.
- `tooling/` — deterministic release-note parsing, rendering, and validation.

## Conventions

- Import explicit leaf modules. Do not add umbrella barrels or compatibility shims.
- Keep serialized DTO field names stable across client, server, persistence, and recordings.
- Keep `core/` dependency-free and browser-safe.
- Keep Node-only filesystem code inside clearly named integration, platform runtime, or racing storage leaves.
- Treat `data/` and generated telemetry catalog artifacts as source-controlled inputs; update them through their owning scripts.
- Put behavior in its owning domain. Extract helpers only when multiple domains share identical semantics.
