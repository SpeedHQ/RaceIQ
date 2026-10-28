# Stint statistics UI

Boundary and shared verification: [contract](stint-statistics-contract.md). Coordinator owns shared contract and integration evidence. Backend and UI implementation proceed independently after that boundary agreement.

## Scope and tasks

1. Update `packages/race-strategy/ui/StrategyStints.tsx` with an accessible compact Average / Median / Peak button group. Use existing styling/tokens and translation conventions; add relevant messages/host message declarations only.
2. Apply selected statistic consistently to fuel/four-wheel table, charts, and comparison differences. Preserve existing unit/context compatibility partitions, lap pace, measured totals, and mean-based planning behavior.
3. Display eligible-lap evidence per metric without restoring long repeated prose. Missing statistics render unavailable rather than falling back to means. Keep raw compatibility identifiers out of ordinary visible copy.

## Acceptance and edge handling

Own S4/S5; consume S1/S2/S3 boundary. Default average; zero remains numeric; missing legacy/new measurements are unavailable and not plotted; differing wheel counts stay accurate; same choice applies across chart/table/comparison. Session changes reset comparison state as before. Keyboard-visible focus and pressed selection are required. Two-selected limit, incompatible metrics, empty/error/loading, narrow viewport remain intact.

## Verification

Coordinator executes shared E1 against real compiled app telemetry and persisted endpoint, E3 supplied-session desktop/390px browser smoke and captures, then UI typecheck/lint/boundaries. E2 confirms selectors consume real rebuilt historical statistics after restart. Fixtures may aid development but cannot replace production API integration. Record actual outcomes in the contract; unrun checks are not passes. Worker must not run tests/builds/lint/formatters or commit.
