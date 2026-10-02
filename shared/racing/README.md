# Racing domains

Shared racing contracts, policies, catalogs, and reusable analysis.

## Layout

- `analysis/` — telemetry capability resolution and lap analysis/insights.
- `cars/` — per-game car catalogs, names, classes, and specifications.
- `comparison/` — aligned lap and corner comparison DTOs.
- `experiments/` — test-change shapes, focus policy, and stint targets.
- `laps/` — lap review policy, stint statistics, and trace wire codec.
- `live/` — live sector, pit, and server status DTOs.
- `results/` — race result, provenance, and authority contracts.
- `sessions/` — persisted lap/session metadata and recap DTOs.
- `setups/` — setup schemas, file formats, and catalog authoring data.
- `tracks/` — catalogs, models, geometry, recording, guides, and curation.
- `tuning/` — tune and issue contracts.

## Boundary

Pure DTO/model/analysis leaves remain browser-safe. Filesystem-backed catalog, storage, recording, and curation leaves use `shared/platform/runtime/data-paths.ts` and stay server/script-side. Preserve serialized field names and explicit leaf imports; do not introduce a racing barrel.
