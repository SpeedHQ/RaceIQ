# shared

Shared type contracts and runtime data primitives for cross-cutting domains.

## Purpose
- Hold domain-specific contracts used by server, client, and scripts.
- Keep serialization contracts stable across API and local artifacts.
- Map static data and game/runtime metadata under a single repo root.

## Top-level map
- `ai/`: AI prompt snippets and language/context helpers.
- `analysis/`: analysis telemetry capability resolution.
- `catalog/`: reusable CSV parser utility.
- `car/`: car name/spec lookup contracts and Kunos parsers.
- `comparison/`: comparison DTOs for lap-by-lap/sector comparisons.
- `experiments/`: experiment focus, changes, and target helpers.
- `forza/`: Forza-specific import/decoder helpers.
- `games/`: game IDs, adapters, registry, and per-game metadata contracts.
- `i18n/`: locale registry source-of-truth.
- `lap-analysis/`: lap-level computations and driving insights.
- `laps/`: lap tracing and codec helpers.
- `live/`: live telemetry envelopes and server status contracts.
- `math/`: shared number helpers.
- `race-results/`: race result DTOs.
- `release-notes/`: release note validation and composition types.
- `runtime/`: shared path/runtime conventions (compiled vs source).
- `sessions/`: session/lap/recap DTOs.
- `setup/`: generated setup catalog artifacts.
- `setups/`: setup schema and file format maps.
- `telemetry/`: telemetry packet types, catalog, resolver, derivation contracts.
- `track/`: track metadata, catalogs, geometry and curation.
- `tunes/`: committed tune catalog data.
- `tracks/`: checked-in track metadata and outlines.
- `tuning/`: tune model and issue contracts.
- `http/`: route schema utilities.
- `imports/`: MOTEC import contracts.

## Core conventions
- Prefer explicit leaf imports; avoid barrel aggregation in downstream code.
- Keep contracts as small as possible and intentionally versioned.
- Keep imports from `shared/*` pointing at concrete files, not namespace shortcuts.
- Keep server-only concerns out of shared leaf contracts unless marked with clear boundary notes.
- Do not duplicate contract text between domains; keep ownership and extension path local per folder README.

## Cross-domain dependency order
- `shared/games` is foundational for adapters and live/analysis semantics.
- `shared/sessions`, `shared/tuning`, `shared/comparison` are persistence contracts and should be imported by both server and client.
- `shared/telemetry` and `shared/track` remain data-heavy; many folders consume their generated/catalog outputs.
- `shared/runtime/data-paths` resolves writable/read-only roots and should remain the single path source for file-backed readers.
