# Racing domains

Shared racing contracts, policies, and neutral primitives. Concrete game catalogs live in metadata owners; cross-game composition lives in `@raceiq/game-catalogs`.

## Layout

- `analysis/` — telemetry capability resolution and lap analysis/insights.
- `cars/` — generic Kunos CSV row contract and loader; per-game car catalogs belong to metadata owners.
- `comparison/` — aligned lap and corner comparison DTOs.
- `experiments/` — test-change shapes, focus policy, and stint targets.
- `laps/` — lap review policy, stint statistics, and trace wire codec.
- `live/` — live sector, pit, and server status DTOs.
- `results/` — race result, provenance, and authority contracts.
- `sessions/` — persisted lap/session metadata and recap DTOs.
- `setups/` — setup schemas, file formats, and neutral catalog authoring definitions; assembled game sources belong to `@raceiq/game-catalogs`.
- `tracks/` — neutral track models, geometry primitives, storage, guides, and curation; concrete catalogs belong to metadata owners.
- `tuning/` — tune and issue contracts.

## Boundary

Pure DTO/model/analysis leaves remain browser-safe. Filesystem-backed catalog leaves live in metadata owners or `@raceiq/game-catalogs`, using shared runtime path helpers; storage, recording, and curation stay server/script-side. Preserve serialized field names and explicit leaf imports; do not introduce a racing barrel.
