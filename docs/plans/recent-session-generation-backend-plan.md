# Recent-session generation backend plan

Contract: [shared integration boundary](recent-session-generation-contract.md). Owner: backend worker. UI proceeds independently against this contract; integration execution belongs to main coordinator after both workers finish.

## Scope and tasks

1. Extend authoritative shared plan schemas/types for weather, distinct aggregate evidence, validated multi-source references and response. Add browser-safe shared aggregation/evidence-access helpers and extend existing generator without inventing a stint identity. Run exported-symbol reference inspection before changes using available LSP.
2. Add bounded recent-session evidence query and GET route. Reuse source eligibility and write/capture coordination patterns. Resolve every provided source on save, validate identity/semantics/compounds/weather/units, persist real weighted aggregates and snapshots. Preserve unchanged saved aggregate references/snapshot on edit and source-deletion reads.
3. Keep aggregate recalculation multi-session; leave legacy semantics unchanged. Update integration fixtures and behavior tests for weighting, weather, bounds, persistence, errors and legacy compatibility. No unrelated refactoring, new DB table, dependency or migration.
4. Backend owns shared/racing/live/race-plan.ts, the shared package export for its new aggregate helper, generator helper, feature server files, Bun integration tests and the new compiled API edge spec `packages/race-strategy/test/e2e/generation-evidence.spec.ts`. Backend does not edit UI/host files, locale catalogs, existing UI E2E specs or changelog. Send exact schema/helper interfaces to UI worker when ready; follow agreed contract, inform coordinator before divergence.

## Acceptance and edge handling

Backend acceptance: MS-01/02/03/04/05/06/07 in the shared contract. Examine the five latest owned sealed/non-recording sessions and at most 100 eligible source stints; sessions with invalid or unsupported-weather metrics still occupy that bounded window, but active/unsealed/recording sessions do not. Use deterministic timestamps/IDs, exact compatible grouping and metric-specific weighted counts; no synthetic native weather. Opponent, malformed, missing, wrong identity/PI/unit/semantic/compound/weather sources are excluded on discovery and rejected on supplied invalid save refs. Missing weather remains unknown. No full group yields null; read failures stay errors. Save transaction rolls back on any invalid source. Legacy schemas load without new fields; old plans retain legacy calculation. Unchanged aggregate edits preserve actual saved snapshot; changing sources recomputes validated values.

## E2E verification dependency

Reuse StrategyRuntime and compiled race-plan.spec.ts scenarios MS-01–MS-07 from the contract. UI worker owns existing UI/native scenario additions; backend owns the separate generation-evidence.spec.ts compiled API matrix for MS-03/05 eligibility, window, validation and failure edges. Main coordinator executes both after integration. In addition, main runs focused backend tests, root typecheck, feature lint/boundaries and production build. Unit/static checks supplement, never replace actual UI/API/save/restart/source-deletion evidence. Completion requires passing outcomes mapped to each criterion, or an explicit unavailable prerequisite; no unexecuted check counts as passed.

Worker must not run tests, builds, linters or formatters; main owns all gates. No commits, checkpoints, nested workers or external agent sessions. Return concise changed paths, actual interfaces, verification gaps and blockers.
