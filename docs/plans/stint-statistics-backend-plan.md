# Backend stint statistics

Boundary and shared verification: [contract](stint-statistics-contract.md). Coordinator owns contract, integration tests, verification, and final review. UI work can proceed independently against this contract.

## Scope and tasks

1. Extend `shared/racing/live/strategy.ts` and `strategy-schemas.ts` with the contract's optional `rateStatistics` field. Preserve old saved plans and historical payloads without fabricating statistics.
2. Extend `packages/race-strategy/server/stint-accumulator.ts` with exact full-stint fuel/four-wheel sample statistics, independent of existing capped rolling-rate samples. Preserve forks, null/zero semantics, existing counts/exclusions and means.
3. Increment `STRATEGY_ALGORITHM_VERSION` in `lap-metrics.ts` so existing safe historical backfill refreshes derived summaries without changing recorded laps or saved plans.

## Acceptance and edge handling

Own S1/S2/S3. Null for no eligible samples, same values for one sample, midpoint median for even samples, full population for long stints, metric-specific eligibility, independent mutable sample state after fork. Old optional payload fields stay absent/unavailable until safe rebuild. No recording means no invented statistics. Use existing persistence/API; no additional endpoint or schema migration.

## Verification

Coordinator runs accumulator/schema regression checks, feature typechecks/boundaries, then shared E1/E2/E3 through real app integrations. E1 validates sample populations and schema/API persistence; E2 validates restart/backfill/idempotency and missing-source behavior; E3 validates existing session integration. Acceptance requires recorded passing outcomes in the contract, not just unit checks. Worker must not run builds/tests/lint/formatters or commit.
