# Spectate line score backend

[Shared contract](spectate-line-score-contract.md); [UI plan](spectate-line-score-ui-plan.md).

Own `apps/backend/src/routes/laps/resource-routes.ts`, query schema in `support.ts`, relevant route tests, shared `server/lap-analysis/consistency.ts`, experiment metric consumption, and the spread cache version. Add comparison-only endpoint reusing `computeLineSpreadTrace`; leave session-scoped review routing unchanged. Reject incompatible pairs before computation. Return null for unavailable telemetry. Correct signed lateral spread centrally and invalidate old cached traces; experiment outcomes must call that same function.

Acceptance: S1, S3, S4, S6, S7 in shared contract. Cover two valid laps, same-track cross-session pairs, insufficient frames, malformed/duplicate IDs, missing laps, wrong game and track, symmetric offsets, lap ordering, longitudinal desynchronization and multi-lap percentile width. Keep scoring scale shared. UI work proceeds independently against agreed response shape.

Verification: extend existing route and math tests for meaningful boundaries; main agent runs route, consistency, experiment and cache tests after implementation. Run real endpoint scenarios and UI integration scenarios S1–S7 from contract; record outcomes in task delivery. Typecheck required. Tests cannot replace real integration smoke.
