# 3 to Improve — backend implementation plan

Status: accepted for implementation on 2026-10-26 against the approved shared contract.

Shared boundary and acceptance criteria: [contract](3-to-improve-contract.md). Decision: [ADR 0016](../adr/0016-3-to-improve.md). Parallel work: [UI plan](3-to-improve-ui-plan.md).

## Scope and ownership

Implement whole-session evidence aggregation and its two read operations inside the existing `@raceiq/session-analyse` feature. Reuse backend-core capture loading, versioned per-lap detector results, track location/alignment and application authorization/error handling. No new detector, AI dependency, summary table, migration or persisted priority list.

Backend owner: `packages/session-analyse/server/routes.ts`, a feature-local aggregation module, real-route integration cases and focused selection tests. Use existing backend-core public APIs; any missing narrow public export requires integration-owner review, not copying implementations. Shared DTO/schema exports under `packages/session-analyse/contracts/`, host/composition wiring and isolated E2E seed artifacts have one integration owner. Read `server/lap-analysis/metrics-store.ts` and current backend-core exports before changing callers. Preserve the versioning and source-index contracts rather than modifying detector semantics.

## Backend acceptance criteria

- **TI-B1 → TI-1/2:** Summary covers all and only eligible laps in the authorized game/session, with current-version evidence, source-index location, exact grouping/ranking/deduplication and maximum-three selection specified by the contract.
- **TI-B2 → TI-3:** Detail revalidates the representative and returns one real bounded aligned trace window with the correct marker. Stale/missing evidence cannot substitute a different recording.
- **TI-B3 → TI-4/5:** Validation, ownership, empty/unavailable data, processing, failures and freshness follow the contract through real HTTP and persistence. Unexpected failures never become successful empty summaries.
- **TI-B4 → TI-6:** Existing review operations and shared consumers retain behavior. No full-session telemetry response, browser backend imports, new schema or AI calls.

## Tasks

1. Integration owner publishes the summary/detail request validators and response types through the existing `/contracts` entry. Reuse `GameId`, existing processing errors and encoded alignment payload types. Agree header scoping and inaccessible-resource behavior with existing application middleware before implementation; no second authorization mechanism.
2. Resolve session ownership before loading laps. Read all session lap metadata using existing authoritative readers, apply contract eligibility and processing guards, then load eligible captures sequentially. Do not call the limited fastest-five review API or depend on UI lap selection. Treat missing captures as insufficient data and unexpected decode/storage errors as errors.
3. Reuse version-aware detector computation and restore original source indices before locating evidence. If an existing helper recomputes stale insights, call it rather than copying analysis/version logic. Share loaded capture data across detection and localization within the request. Use existing distance/track mapping; withhold unlocatable points instead of approximating fraction from frame position.
4. Implement the contract allowlist, family/bucket grouping, point deduplication, counts, deterministic ranking, distinct-family/location selection and representative choice in a small pure module. Return localized-template identifiers/data, never parsed English detector details. Ignore unquantified and quantified loss alike for ranking; no saved-time claims.
5. Add summary and detail routes to the existing feature route factory. Detail validates the requested source point against current selected representatives before producing its bounded existing encoded alignment payload. Preserve all auth/origin/CSRF/error middleware and route specificity. Existing review routes must remain unchanged.
6. Add focused tests for ranking ties, duplicate same-frame detectors, fractional boundaries and unknown IDs only where they catch plausible consumer-visible errors. Extend real DB/route integration cases for scope, processing, capture absence and stale detector versions. Do not test copied wiring/source text or pin incidental English output.
7. Supply integrated fixtures with reproducible raw signal patterns to the integration owner. Coordinate the single documentation/changelog update after the feature actually works; no planning-time shipped-feature claim.

## Edge handling and E2E mapping

The [shared E2E table](3-to-improve-contract.md#edge-cases-and-shared-e2e-strategy) owns setup/action/outcome definitions; backend checks supplement, not replace, its real compiled-app scenarios.

| Backend case | Planned handling | Required E2E / criteria |
| --- | --- | --- |
| More than three candidates, ranking ties | Stable contract sort and greedy family/bucket uniqueness. | TI-E1/E7; TI-B1 |
| Duplicate detector points or one supporting lap | Deduplicate exact lap/frame points; count distinct laps; preserve single-lap level. | TI-E1/E2; TI-B1 |
| Invalid/ineligible/excluded laps | Metadata filtering with exact scope counts, no evidence leakage. | TI-E5; TI-B1/B3 |
| Fraction 0/1, bucket edge, absent distance, bad index | Clamp only valid fraction 1 to last bin; reject invalid evidence; no fabricated location. | TI-E3; TI-B1/B2/B3 |
| No capture, no findings, unsupported channels | Separate contract states; no claim of perfect driving. | TI-E2/E5; TI-B3 |
| Session/lap queued, processing or failed | Existing 409/422 contract, no partial/stale summary; ready state permits recomputation. | TI-E6; TI-B3 |
| Wrong game/ownership, malformed/unsafe IDs | Validate and authorize before evidence reads; preserve inaccessible-resource policy. | TI-E7; TI-B3 |
| Stale analysis, exclusion/deletion change | Version-aware lap cache reuse and fresh aggregation; revalidate detail identity. | TI-E4/E5/E9; TI-B1/B2/B3 |
| Source failure or lost capture during detail | Existing missing/error response, never fake empty success or another lap. | TI-E4/E7; TI-B2/B3 |
| Large session | Sequential capture processing, reuse existing caches, compact top-three response and bounded on-demand detail. | TI-E8/E9 with multi-lap fixture; TI-B4 |

## Verification and completion dependency

After implementation, run focused pure selection and real persistence/route cases, existing affected feature integration tests, feature boundary/type/lint gates and root `bun run typecheck`. Integration owner runs TI-E1–E9 against the real compiled application and extends existing group-review coverage with the new feature cases. HTTP tests must enter through the actual app composition, not only a standalone mocked route factory.

Record exact commands, HTTP statuses, deterministic expected candidates/counts, evidence trace values and all failures in the implementation verification report. Mocks may control an existing storage fault boundary for the explicit failure path, but must not replace successful detector, persistence, route or UI/backend integration. All TI-B criteria and mapped shared criteria require passing evidence before completion. Missing environment or fixture coverage is a blocker, not a pass.

Planning outcome: documents only. No code, migrations, application runs or test executions performed for this proposal.
