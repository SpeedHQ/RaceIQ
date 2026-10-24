# Stint lap scatter UI plan

Shared boundary and E2E scenarios: [contract](stint-lap-scatter-contract.md). Backend and UI can implement independently after boundary agreement. UI owner owns the following files; coordinator owns contract and integration E2E execution.

## Scope and tasks

1. Extend `RaceStrategyApi`/`RaceStrategyHost` with `lapMetrics(gameId, sessionId)`; add validated query hook/key in `packages/race-strategy/ui/stint-strategy.ts`; wire production adapter in `client/src/features/race-strategy-host.tsx`. Validate response through shared DTO/Zod contract. Reuse existing query invalidation for `strategy-updated` in `client/src/hooks/useWebSocket.ts`.
2. Replace stint-aggregate chart dots in `packages/race-strategy/ui/StintDumbbellChart.tsx` with five per-lap plots (rename file/component if clearer). X is lap number; y is existing rate with exact unit. Preserve compatibility group separation; show explicit unavailable state for metric contexts with no points.
3. Add two accessible P50/P95 overlay controls, both enabled initially; calculate each line from current eligible plotted values with existing nearest-rank arithmetic. Keep all lap points visible. Keep existing Hot/Cold switch and recompute overlays when population changes.
4. Add one shared compound filter for tire panels only when multiple values are present. All/known/Unknown choices; default All. Do not filter fuel or combine compatibility contexts. Add locale messages in `packages/race-strategy/contracts/messages.ts` and every `client/messages/*.json` only as needed.
5. Replace stint-focus interactions with `focusedLapId`; pointer/keyboard focus highlights matching lap across plots and updates accessible exact-value readout, including metric-specific missing reasons and wheel compounds. Replace wide summary table with compact per-stint cards: visible stint/lap span/status, comparison selector, hot fuel/four-wheel P50/P95 and eligible counts. Native expandable details retain cold statistics, measured fuel/coverage, average lap, boundary confidence/reasons, completed/pace counts and exclusions. Preserve `stint-{id}` anchors, comparison limit/hints/navigation, query/status/retry, session reset, theme, reduced motion, responsive layout and keyboard access.
6. Remove superseded chart-only production/test code. Do not change aggregation algorithms, saved summaries, planner behavior or unrelated APIs.

## Acceptance and edge handling

Own **L2–L7** in shared contract; consume **L1**. All finite points—including zero—plot once at correct lap number; null/excluded values remain absent and accessible. Unknown compounds remain selectable; no compound change hides filter. One/constant lap number receives nondegenerate x domain. Empty/loading/error states cannot show old-session points. Session changes reset selection/filter/focus; real `strategy-updated` invalidates query. Stint cards surface hot percentile summaries and eligible counts; expandable details preserve cold evidence, fuel totals/coverage, lap averages, boundaries and exclusions. One stint omits comparison selector; more than two selected remains impossible. Cards stack on mobile without document overflow.

## Compact card design amendment

Replace the wide, many-column table below the plots with one low-chrome card per stint. Keep all text left-aligned and preserve app typography/tokens.

```text
┌ Stint 2 · L8–14 · Completed                  □ Compare ┐
│ Fuel / lap                    FL       FR       RL       RR │
│ p50 … · p95 … · N laps        p50/p95 and eligible count   │
│                                                   [Details] │
└────────────────────────────────────────────────────────────┘
```

- Visible summary prioritizes comparable hot rates: p50/p95 + eligible-lap count for fuel and each wheel. Each tire metric includes compound; unknown remains explicit. Lap span/status and compare control stay in the header.
- Keep secondary audit facts inside native `<details>` per card with localized `strategy_stint_details` summary: cold fuel/tire percentiles and `coldLaps`, measured fuel used and coverage, average lap, driver, completed/pace laps, boundary confidence/reason, and exclusion counts/reasons. Keep details closed initially; preserve every source value/reason. Add the message to `RaceStrategyMessages` and every locale.
- Keep semantic articles/headings/definition lists and labeled native compare checkboxes; preserve card `id="stint-{id}"`. Single stint has no checkbox. Enforce existing max-two selection and disabled explanation.
- At desktop, metric summaries align within each card; at narrow widths, wrap into a 1-column or two-column wheel grid without horizontal page scrolling. Use subdued separators, not a new visual theme or repeated heavy panels.
- E1/E2/E3/E5 shared scenarios verify card headline values, expanded evidence, selection/anchor behavior, keyboard use and mobile fit. Reuse existing compiled `StrategyRuntime` integration; update table-specific selectors to card semantics. Keep chart/backend contract unchanged.

### Card edge cases

| Case | Handling | Acceptance |
|---|---|---|
| One stint | Omit compare control; keep summary and details | L4, L7 |
| More than two stints selected | Disable unselected compare checkboxes; preserve selection limit hint | L4, L7 |
| Missing hot/cold percentile or zero eligible samples | Display existing unavailable reason and count; never substitute zero | L4, L7 |
| No cold statistics | Keep cold detail absent/unavailable as source semantics dictate; never invent cold values | L7 |
| Unknown compound, long driver/context, many stints | Label unknown; wrap text and preserve anchors; stack cards without page overflow | L5, L6, L7 |
| Details opened while comparing | Keep checkbox state, focus, and comparison unchanged | L4, L7 |

## Verification ownership

Implementer skips tests/build/lint/formatters. Coordinator runs translation compile, package typecheck, browser build, then shared real-app E1–E6 from [contract](stint-lap-scatter-contract.md#shared-end-to-end-scenarios). E1/E2/E3/E4/E5/E6 map to L1/L2/L3/L4/L5/L6 as specified there. Contract-conforming fixtures may support isolated UI work but cannot substitute for production API integration. Completion requires passing shared E2E evidence and inspected desktop/mobile captures.
