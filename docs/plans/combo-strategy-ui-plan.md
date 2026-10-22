# Combo strategy UI and dashboard stories

Authoritative [shared contract](combo-strategy-contract.md); reciprocal [backend plan](combo-strategy-backend-plan.md). Coordinator owns shared schemas and final E2E. UI can implement independently using contract-shaped fixture query data while backend proceeds.

## Scope and tasks

Own feature `contracts/ui-host.ts`, `ui/race-plans.ts`, `ui/index.ts`, active-plan consumers `PitEstimate.tsx`, `LiveRaceStrategy.tsx`, `RaceStrategiesPage.tsx`, `RaceStrategyPlanner.tsx`, client `features/race-strategy-host.tsx`, and targeted dashboard story/fixture files. Migrate to activePlans/useActiveRacePlans collection response and complete tuple mutation. Find every caller and remove singular aliases. Live consumers select exact current game/car/track then retain existing PI guard; unknown or unmatched identity falls back to automatic estimates. List row activation/unload uses the row's tuple, supports independently Loaded rows. Planner unload uses saved plan tuple. No global unpin fallback. Preserve editing/save/error states and prevent stale cached data from another combo applying during switches.

Add four typed ACC actual-dashboard stories (selected plan, pit approaching, fuel shortfall, unmatched combo fallback) using incumbent query/store decorators and actual components. Do not create fake production renderers. Scope known components/data producer; avoid unrelated design changes. Keep prior compact stint-table changes intact; do not edit StrategyStints or shared race-plan schemas/server/tests.

## Acceptance/edge handling

Own C2/C4; consume C1/C3 boundary. Correct live identity and new-session restoration, multiple Loaded rows, tuple-local unload/delete, unknown/mismatched identity fallback, PI safety, API error retains explicit automatic fallback. Keyboard focus, mobile internal scrolling/no document overflow. Source-session IDs remain evidence only.

## Verification

Coordinator runs shared E-C1/E-C2 integration through real app/API/native inputs, E-C4 targeted actual Storybook desktop/390px captures, feature UI/client/Storybook typechecks and boundary checks. Existing E2Es migrate to real GET collection/PUT tuple contracts under coordinator ownership. Record outcomes in shared contract; mock-only story proof does not replace live integration. Worker must skip builds/tests/lint/formatters and never stage/commit/delegate or edit checkpoints.
