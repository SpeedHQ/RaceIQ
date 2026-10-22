# Strategy design and recalculation UI plan

Contract: [shared integration contract](strategy-recalculation-contract.md). Backend: [backend plan](strategy-recalculation-backend-plan.md).

## Scope and tasks

Own `packages/race-strategy/ui/`, UI host components/contracts/adapter, localization and strategy browser specs. Preserve incumbent cockpit design; no new visual theme or libraries.

1. D1: Use existing AppInput/Input/Textarea and a shared native-select primitive through the feature host. Apply shared text-app roles, surface-alt wells, border-input strokes and compact radii; retain semantic status colors. Remove the planner's duplicated saved-list/sidebar and its mutation hooks. Use responsive saved-plan rows/cards with all actions directly reachable on mobile, tabular data figures and keyboard-visible focus.
2. C1: Add Clone action with a localized copy name and copied draft/settings/evidence, never a saved ID. Preserve original and active plan. Retain provenance in preview and require explicit save.
3. R1/R2/R3: Add Clone & recalculate form using persisted constraints or required inputs for legacy plans. Call the agreed operation, validate response and open a new draft with actual latest evidence. Show source date/session, rates, measured pace and before/after stops/laps. Retain inputs and retry on missing evidence/storage failure; ignore late results after the form unmounts so a newer draft is not overwritten. Timed race count follows refreshed measured pace from response.
4. E1: Persist initial-generator constraints and show LMU virtual-energy rate, required budget and explicit full-budget/refill assumptions independently of fuel. Missing energy is unavailable, not fuel-derived.
5. Extend existing `race-plan.spec.ts`, `planner-review-fixes.spec.ts` and relevant strategy specs for the contract scenarios. Update all supported locales and release notes once after integration.
6. D2: Move the existing session statistics component to the bottom of Overview after end-of-lap tire state. Remove its dedicated navigation tab and preserve data, charts, comparison, loading/error/empty states and Generate action. Update existing statistics E2Es to enter Overview and assert placement plus exclusion from Analyse and experiment-only review.

## Acceptance, edge handling and verification

UI acceptance: D1/D2/C1/R1/R2/R3/E1/S1/V1 from the shared contract. Its acceptance table is authoritative for overview placement, empty/missing evidence, incompatible/active sources, legacy settings, resource shortages, invalid numeric limits, mixed compounds, pending saves and source deletion. Do not duplicate selection policy in UI or retain fixtures as production fallbacks.

UI may use contract-conforming fixtures while backend runs independently, but final completion depends on real endpoint integration. Coordinator executes the shared D1/C1/R1/R2/R3/E1/S1 E2Es through the compiled app, including desktop/mobile captures and keyboard navigation, then required typecheck/lint/boundary/localization gates. Record outcomes and exact evidence in the shared contract/checkpoint; static/component/mocked checks do not replace E2Es.
