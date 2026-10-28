# Strategy evidence and regeneration backend plan

Contract: [shared integration contract](strategy-recalculation-contract.md). UI: [UI plan](strategy-recalculation-ui-plan.md).

## Scope and independently owned slices

Coordinator owns shared `race-plan.ts`, `strategy.ts`, `strategy-schemas.ts`, host/RPC integration and final validation. Agree and install these shared shapes before independent implementation.

1. Metric slice: `packages/race-strategy/server/lap-metrics.ts`, `stint-accumulator.ts`, `strategy-context.ts`, dedicated metric regression tests. E1/S1: independently aggregate native LMU virtual-energy consumption; missing/out-of-range/reset samples remain unavailable, fuel/wear/pace remain independent. Include resource-refill boundaries and optional historical snapshot compatibility. Bump algorithm and reuse existing versioned backfill; never edit historical laps or immutable plan snapshots.
2. Regeneration slice: new server proposal/selection module, `race-plan-routes.ts` and its intentional exports, pure browser-safe generator under feature contracts, dedicated regeneration tests. R1/R2/R3/S1: implement read-only recalculation against saved plans using deterministic latest eligible session ordering and exact compatibility rules from the contract. Persist generation constraints through existing JSON payload/schema. Preserve actual compound-change anchors; regenerate same-compound runs, timed lap count and resource loads. No save or activation occurs in this operation.
3. Integration owner: connect host RPC/UI, reuse shared generation helper for initial generation, verify schema serialization and saved snapshot behavior. Own the live pipeline's narrow per-session recording-ownership query and admit candidates under the existing capture-maintenance lock, covering legacy UDP captures without journal rows as well as journaled captures. Keep app middleware/write coordination intact. Backend and UI proceed in parallel after shared shapes are installed.

## Acceptance and edge handling

Backend acceptance: C1/R1/R2/R3/E1/S1/V1, as applicable, against the shared contract. Its table defines expected handling for latest improved evidence, incompatible/active sessions, nullable/unsupported resources, missing sources, legacy constraints, zero and exact-fit rates, invalid reserves, excessive stints, timed pace and infeasible compound anchors. Domain errors must remain distinguishable, with no stale/fake success response. Match source ownership and identity using authoritative session records as well as validated payloads.

## Verification

Coordinator extends the existing isolated compiled strategy E2Es and native telemetry fixtures for shared C1/R1/R2/R3/E1/S1 scenarios, preserving deterministic UDP/recording inputs and controlled dependencies. Verify the actual HTTP operation, durable saves/reloads, unchanged original/active plan and live pipeline-to-summary integration. Metric/selection unit and integration tests supplement those E2Es. Run current browser/server production build, required repository typecheck, feature boundaries and lint after integration; record exact outcomes. No worker runs build/tests/lint/formatters, stages, commits or creates checkpoints; coordinator owns task state and evidence.
