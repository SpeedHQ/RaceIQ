# Laps

Reusable lap curation, stint statistics, and telemetry-trace transport.

## Modules

- `classification.ts` keeps lap phase, race conditions, and pace eligibility independent from structural validity.
- `classification.ts` classifies persisted laps from coordinator-owned timeline context; packet buffers never classify pit or flag state.
- `review-selection.ts` applies shared quality decisions before canonical fastest-clean-lap ranking, exclusion reporting, and caps.
- `stint-stats.ts` computes repeatability, consistency, and degradation from lap metadata.
- `trace/types.ts` defines in-memory and encoded lap traces.
- `trace/build.ts` converts normalized telemetry packets into full-resolution, distance-indexed traces and channel summaries.
- `trace/codec.ts` encodes and decodes `Float32Array` trace channels as base64.

## Runtime boundary

Selection, statistics, and trace construction are pure and browser-safe. They depend only on shared telemetry, session, math, and vehicle-physics contracts. `trace/codec.ts` uses Web `btoa` and `atob` globals; it performs no file or network I/O. Storage, database access, and HTTP transport remain outside this directory.

Dependency flow is:

`shared/telemetry` + `shared/racing/sessions` + `shared/core` + `shared/racing/analysis/laps/physics` -> `shared/racing/laps` -> client/server review consumers

## Extending lap utilities

- Change analysis-policy meaning only in `shared/racing/quality/policies.ts`; keep review ranking, exclusion precedence, and caps in `review-selection.ts`, and do not reimplement either in callers.
- Apply fastest-lap caps only to frame-heavy trace work. Full-stint statistics and eligible-pool counts must retain every policy-eligible lap, including clean laps outside the cap.
- Add normalized non-pace signals in `classification.ts`, and keep validity independent from classification.
- Preserve missing-channel semantics in traces: unavailable channels are `null`, not zero-filled data.
- Keep trace DTO changes symmetric across `types.ts`, `build.ts`, and `codec.ts`.
- Import explicit leaf modules such as `shared/racing/laps/review-selection`; do not add a barrel.
