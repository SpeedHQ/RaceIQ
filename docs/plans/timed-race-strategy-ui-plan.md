# Timed race strategy UI implementation

Boundary: [shared contract](timed-race-strategy-contract.md). Paired [backend plan](timed-race-strategy-backend-plan.md). UI can implement against the resolved contract independently of backend edits; fixtures are development-only, not production fallbacks.

## Ownership and tasks

UI scope owns `client/src/components/telemetry/RaceStrategyPlanner.tsx` and all supported `client/messages/*.json`. Do not edit shared DTOs, backend files, or unrelated compact-panel changes. Coordinator owns real integration E2E, the fixed-header integration in `PitEstimateDialog.tsx`, and final checks.

1. Extend draft conversion and save/load paths to preserve optional `raceLength`; use the shared lap estimator. Add labeled Laps / Race time mode controls, duration minutes, editable lap seconds initialized from compatible recorded pace, and explicit estimated lap count/basis. Freeze saved pace on reopen. T1, T2.
2. Update final end lap only when a valid estimate changes; preserve earlier stop edits and make invalid sequences unsavable. Missing pace/duration remains unavailable; lap mode works as before; retain draft/error/retry/pending-save locks. T1, T4.
3. Show required fuel per stint and carry-adjusted fuel to add at selected pit stops under the contract's eligibility/unknown/zero rules. Do not reinterpret starting fuel as fuel added. T3.
4. Translate every new message in every supported locale and maintain the existing dialog visual language and accessible controls. Keep the outer dialog non-scrollable, including programmatic focus scrolling, with only its body scrollable. T5.

## Acceptance, edges, and verification

Acceptance T1–T5 and edge handling are defined in the shared contract, not duplicated here. UI maps to E1 (mode/pace/rounding), E2 (saved timed fields and legacy load), E3 (fuel/carry/zero/unknown/unreachable stop), E4 (invalid input, retained stops, mode transitions, pending save), and E5 (actual dialog/mobile/keyboard). Coordinator extends and executes the existing native-source browser suite through real routes/SQLite; UI mocks do not satisfy completion. Final `bun run typecheck`, locale validation, and changed-path runtime smoke supplement these scenarios.

## Verification outcome

Verified 2026-10-21:

- E1–E5/T1–T5 passed through the real app, native F1 ingestion, production routes, and SQLite in `playwright/tests/seeded/strategy/race-plan.spec.ts`. [Acceptance artifacts](../../playwright/test-results/timed-strategy-acceptance/) include `timed-strategy-mobile.png`, showing the saved 30-minute/90-second strategy at 390px with a fixed header. The separate legacy test initially exceeded its cold-start budget; its complete rerun passed with all assertions retained.
- R1–R8 passed in four tests using `bunx playwright test --config playwright/stint-strategy.config.ts race-plan.spec.ts planner-review-fixes.spec.ts --grep 'R1-R5|R6|R7|R8' --output playwright/test-results/timed-strategy-lifecycle`. [Lifecycle artifacts](../../playwright/test-results/timed-strategy-lifecycle/).
- Desktop 1100px and mobile 390px runtime checks confirmed that keyboard focus leaves outer dialog scrollTop at zero while the body scrolls. The outer container uses overflow-clip to prevent programmatic header drift.
- `bun run typecheck`: 33/33 packages passed after final production edits. Changed-path oxlint passed, including the final E2E edits. [Typecheck/lint output](../../playwright/test-results/timed-strategy-typecheck-lint.log).
- `bun scripts/i18n/check-message-keys.ts`: all 15 non-English catalogs complete, 2951/2951 keys; translation compilation passed.
- Full backend integration was not clean in its concurrent run: one capture-worker test exceeded its existing five-second timeout. Both worker cases passed when rerun without concurrent gates; see the [backend outcome](timed-race-strategy-backend-plan.md#verification-outcome). No production mock/fallback or relaxed behavioral assertion was introduced.
