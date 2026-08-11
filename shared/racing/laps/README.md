# Laps

Reusable lap curation, stint statistics, and telemetry-trace transport.

## Modules

- `pit-cycle.ts` owns the persisted pit-cycle reason vocabulary and classifier helper.
- `review-selection.ts` defines the canonical fastest-clean-lap selection and exclusion reasons for telemetry-heavy reviews.
- `stint-stats.ts` computes repeatability, consistency, and degradation from lap metadata.
- `trace/types.ts` defines in-memory and encoded lap traces.
- `trace/build.ts` converts normalized telemetry packets into full-resolution, distance-indexed traces and channel summaries.
- `trace/codec.ts` encodes and decodes `Float32Array` trace channels as base64.

## Runtime boundary

Selection, statistics, and trace construction are pure and browser-safe. They depend only on shared telemetry, session, math, and vehicle-physics contracts. `trace/codec.ts` uses Web `btoa` and `atob` globals; it performs no file or network I/O. Storage, database access, and HTTP transport remain outside this directory.

Dependency flow is:

`shared/telemetry` + `shared/racing/sessions` + `shared/core` + `shared/racing/analysis/laps/physics` -> `shared/racing/laps` -> client/server review consumers

## Extending lap utilities

- Change review eligibility only in `review-selection.ts`; callers must not reimplement its precedence or cap.
- Add normalized non-pace signals in `classification.ts`, and keep validity independent from classification.
- Preserve missing-channel semantics in traces: unavailable channels are `null`, not zero-filled data.
- Keep trace DTO changes symmetric across `types.ts`, `build.ts`, and `codec.ts`.
- Import explicit leaf modules such as `shared/racing/laps/review-selection`; do not add a barrel.
