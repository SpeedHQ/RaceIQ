# Race strategy backend implementation

Contract: [shared race strategy boundary](race-strategy-contract.md), paired [UI plan](race-strategy-ui-plan.md).

Owner: backend worker. Own new shared/racing/live/race-plan.ts and shared export, new server/db/race-plan-queries.ts, SQLite schema/migration for saved plan JSON plus indexed identity and persistent singleton active selection, new apps/backend/src/routes/race-plan-routes.ts registered in routes/index.ts. Reuse existing stint read queries/ownership and DTO validation. No edits to ongoing tire threshold algorithms or UI.

Tasks: (1) Implement shared schemas/DTOs and exact contract validation. (2) Persist plan CRUD and active selection transactionally; freeze verified source snapshots. (3) Register authenticated production routes with typed RPC visibility. (4) Add targeted behavioral tests for invalid ordering/source compatibility, immutable snapshots and selection deletion, but leave execution to coordinator.

Acceptance R1–R5 is defined once in shared contract. Edge solutions: reject incompatible/missing sources before transaction mutates saved plan; null rates/fuel stay unknown, zero preserved; strictly ordered last endLap matches totalLaps; deleting plan clears selection; history deletion retains snapshot; update revalidates source; no active runtime is required to prepare/load a plan.

Verification coordinator: typecheck backend/shared; run targeted tests; execute real application R1–R5 scenarios from shared E2E through UI/API/SQLite/native live telemetry. No plan is complete with only static or unit checks. Record exact pass/block outcomes after integration.

## Outcome

Implemented with SQLite migration v83, validated source snapshots and durable active-plan selection. Backend regressions, typecheck and the production integration scenarios pass; see [contract verification](race-strategy-contract.md#verification).

Review corrections [R6–R8](race-strategy-contract.md#review-corrections) leave HTTP shapes unchanged; transactional source/PI validation remains authoritative. The UI corrections pass real production-route integration; see the [review-fix verification](race-strategy-contract.md#review-fix-verification-2026-10-21).
