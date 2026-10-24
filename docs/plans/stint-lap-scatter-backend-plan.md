# Stint per-lap metrics backend plan

Shared boundary and E2E scenarios: [contract](stint-lap-scatter-contract.md). UI and backend can implement independently after boundary agreement. Backend owner owns shared DTO/schema plus endpoint; coordinator owns contract and final integration E2E execution.

## Scope and tasks

1. Add `StrategyLapMetric` and response DTO/types plus Zod schemas in `shared/racing/live/strategy.ts` and `shared/racing/live/strategy-schemas.ts`. Exact fields, nullability, ordering and errors are defined in [contract](stint-lap-scatter-contract.md#api-boundary).
2. Add `getStrategyLapMetrics(sessionId, driverKey?)` in `packages/race-strategy/server/strategy-queries.ts`. Select current `STRATEGY_ALGORITHM_VERSION` rows from `strategy_lap_metrics`, join same-session `laps` and `strategy_stints`, parse contribution and summary, derive fuel unit/compound from summary, retain null/reason values, return stable ordered rows. Never fall back to summaries or raw telemetry.
3. Add `GET /api/sessions/:id/stint-lap-metrics` in `packages/race-strategy/server/session-strategy-routes.ts`, reusing existing session/game validation and error contract. No schema migration or new storage is needed. Export only if required by existing route wiring.
4. Use the existing `strategy-updated` event; no new event protocol. Verify saved-lap commit publishes the event after durable per-lap contribution write, so client invalidation cannot expose uncommitted data.
5. Extend existing compiled-runtime E2E/API assertions for L1 and contract errors. Do not add unrelated endpoint pagination, algorithm changes, or new raw telemetry storage.

## Acceptance and edge handling

Own **L1**; provide the contract input for **L2–L6**. Return all current-algorithm rows, including contributions with null metrics and reasons. Zero remains numeric; null never becomes zero. Composite identity prevents duplicate driver/lap confusion. Empty current-version set is `200 {laps:[]}`; wrong game/session is 404; malformed request is 400; storage/parse failure is 503. No pagination: one bounded session's persisted lap rows are returned in deterministic order. Existing auth and game scope remain unchanged.

## Verification ownership

Implementer skips tests/build/lint/formatters. Coordinator runs package typecheck, browser build, and shared real-app E1–E6 from [contract](stint-lap-scatter-contract.md#shared-end-to-end-scenarios). E1/E2/E3 cover endpoint shape, filtering, ordering, persistence, missing/zero values and errors; E3 verifies saved-lap publication and live query invalidation. Cross-layer production integration is mandatory; mocked endpoint tests alone do not complete this plan.
