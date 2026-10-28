# Tire threshold backend implementation

Contract: [shared boundary and acceptance](tire-thresholds-contract.md). Parallel implementation with [UI](tire-thresholds-ui-plan.md).

Owner: backend worker. Files: shared/racing/live/tire-thresholds.ts, shared/racing/live/types.ts, server/runtime/config/settings.ts, server/live-strategy/pit-tracker.ts, server/live-strategy/durable-strategy.ts, required server/telemetry/live-pipeline.ts integration. Preserve current rate measurement, capability gating and storage ordering.

1. Add shared validated setting/types and normalized per-wheel compound resolver, using existing game identifiers and source contracts. T1/T3/T4.
2. Persist overrides via existing settings API; cache resolved settings outside per-frame disk I/O; update after save. T1/T3/T4.
3. Apply thresholds to all curve/fallback and durable projections, with per-wheel effective values. Reuse existing strategyContext compound semantics; retain immutable historical estimates. T2/T4.

Edges/handling: zero dead allowed with nullish checks; dead >= cliff rejected atomically; missing fields/entries use contract defaults; mixed LMU resolves each axle; compound/game changes resolve current packet; missing wear preserves availability; persistence failure does not publish unsaved settings.

Verification owner: coordinator. Extend existing settings and strategy tests where consumer-visible boundaries warrant; run targeted tests and backend/shared typecheck after edits settle. Execute shared E2E T1–T4 through real settings route and telemetry pipeline, checking numerical projections against controlled rates. Existing-install, reset, invalid update and live-switch scenarios must pass, or be explicitly reported blocked.

## Outcome

Implemented and verified against the [contract verification record](tire-thresholds-contract.md#verification). Targeted regressions, backend typecheck, and real settings/native telemetry scenarios pass; native LMU replay remains explicitly unexercised.

Review corrections T5/T6 are implemented: durable application precedes live publication and Kunos presets use native IDs. Targeted threshold/tracker regressions and the historical-evidence browser scenario pass; see the [review-fix verification](tire-thresholds-contract.md#review-fix-verification-2026-10-21), including native-capture limitations.
