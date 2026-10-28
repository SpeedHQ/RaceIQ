# Stint lap scatter contract

Implementation plans: [backend](stint-lap-scatter-backend-plan.md) and [UI](stint-lap-scatter-ui-plan.md). This contract defines their shared boundary; coordinator owns contract and final integration verification.

## Contract status

Boundary agreed from user-selected behavior and existing repository conventions. No unresolved interface decisions block parallel implementation.

## User behavior

- Plot every saved per-lap strategy contribution in five panels: x = lap number; y = fuel/lap or one wheel's wear/lap. No stint aggregation for dots.
- Display all eligible points by default. Two independent P50/P95 controls toggle reference lines computed from currently visible points. Use existing nearest-rank definition `floor(fraction * (n - 1))`; do not replace raw dots with percentiles.
- Keep existing Hot/Cold population control. A shared tire-compound filter appears only when multiple compound values exist, includes All and Unknown, and filters tire panels only; fuel panel is unaffected.
- Keep separate compatibility contexts, exact units, accessibility, focus/readout, compact stint cards below plots, comparison, navigation, loading/error/retry, and persisted-summary semantics. Cards surface each stint's lap span/status, compare selector, hot fuel/four-wheel P50/P95 and eligible counts. Expandable details retain cold rates, measured fuel/coverage, average lap, boundary confidence/reasons, completed/pace counts, and exclusions. Lap focus highlights corresponding points across panels; it never changes compare selection.

## API boundary

### `GET /api/sessions/:id/stint-lap-metrics`

- Authentication: existing application session auth; no new auth mechanism. Required `X-Game-Id: GameId` header.
- Path `id`: positive integer session ID.
- Query: optional `driverKey: string` (nonempty). Omitted means all drivers.
- Body: none.
- No pagination: return all current-version persisted strategy-lap contributions for the session. Order by `lapNumber ASC`, `driverKey ASC`, `lapId ASC`.

Response, all keys required:

```ts
{
  laps: Array<{
    lapId: number;
    lapNumber: number;
    driverKey: string;
    stintId: string;
    stintOrdinal: number;
    thermalState: "cold" | "warm" | "unavailable";
    fuel: {
      value: number | null;
      unit: "L/lap" | "tankFraction/lap";
      unavailableReason: string | null;
    };
    tires: [
      { value: number | null; unit: "wearFraction/lap"; unavailableReason: string | null; compound: string | null },
      { value: number | null; unit: "wearFraction/lap"; unavailableReason: string | null; compound: string | null },
      { value: number | null; unit: "wearFraction/lap"; unavailableReason: string | null; compound: string | null },
      { value: number | null; unit: "wearFraction/lap"; unavailableReason: string | null; compound: string | null }
    ];
  }>;
}
```

`value: 0` is measured zero; `null` is unavailable and must not become a point. `unavailableReason` preserves the contribution's existing exclusion reason. Values are finite in units already used by `LapMetricContribution`; fuel unit derives from the matching `StintSummary`. Wheel compound comes from matching stint summary. Rows come only from `strategy_lap_metrics` whose `algorithm_version` matches current `STRATEGY_ALGORITHM_VERSION`, joined to the same session's `laps` and `strategy_stints`; never synthesize values from stint aggregates or stale payloads. A row may have null fuel and valid tire values, or the reverse.

### Errors and state

- Invalid/missing game header, malformed ID, or malformed query: HTTP 400, existing `{code:"INVALID_STRATEGY_REQUEST", error:"Malformed strategy request"}` contract (missing/invalid game header keeps existing route message).
- Missing session or game mismatch: HTTP 404, `{code:"STRATEGY_NOT_FOUND", error:"Session not found"}`.
- Storage/parse failure: HTTP 503, `{code:"STRATEGY_STORAGE_UNAVAILABLE", error:"Strategy storage unavailable"}`.
- Existing session with no current-version metric rows: HTTP 200 `{laps:[]}`.
- Completed lap contribution is immutable; current-session additions publish existing `strategy-updated`, which invalidates lap-metric queries for that session. Query refetches on mount/reconnect. No client-side fake fallback.

Example: lap 12 with fraction fuel consumption `0.02`, FL wear `0`, other tires unavailable, cold state, stint ordinal 3 returns fuel `{value:0.02,unit:"tankFraction/lap",unavailableReason:null}`, FL `{value:0,unit:"wearFraction/lap",unavailableReason:null,compound:"soft"}`, null values/reasons for other unavailable wheels.

## Acceptance criteria

- **L1:** Actual API returns complete ordered current-algorithm per-lap contributions with matching lap, stint, driver, unit, compound and thermal identity; no aggregate fallback.
- **L2:** UI plots every finite metric value at correct lap number in the correct metric/context; zero plots; null/missing never plots.
- **L3:** P50/P95 overlays toggle independently and use existing percentile arithmetic over the currently visible metric/context sample. Hot/Cold and compound filters recompute overlays without changing underlying points outside their filter; context boundaries stay separate.
- **L4:** Lap focus highlights matching points across panels and exposes exact fuel/four-wheel values, missing reasons, compounds and measured thermal state. Before selection, show localized guidance rather than an unrelated lap. Clear selection only when no finite metric for that lap remains visible. Stint cards preserve persisted evidence, comparison selection, anchors and navigation.
- **L7:** Responsive per-stint cards make hot P50/P95 fuel/tire rates and eligible counts scannable; retain lap span, status and compare control. Measured summaries precede zero-evidence summaries, whose metrics and audit evidence remain in a closed native disclosure. Comparison precedes the card grid, focuses after the second selection, and remains reachable from selection controls. Expandable details preserve cold stats, measured fuel/coverage, average lap, boundaries and exclusions.
- **L5:** Compound filter appears only for multiple compound values, offers All/each known/Unknown, affects tires only, and never pools incompatible contexts.
- **L6:** Real compiled app/backend integration passes scenarios below; desktop/mobile fit without document overflow. Plot-local horizontal scrolling preserves at least 11 CSS-pixel axis labels and 24 CSS-pixel point targets. Keyboard, pointer and tap controls work; diagnostic context stays expandable rather than dominating headings. Loading/error/retry/session reset remain honest.

## Edge cases and handling

| Case | Handling | Criteria |
|---|---|---|
| Zero-valued valid metric | Return and plot at y=0; keep distinguishable marker | L1, L2 |
| Null, excluded, or nonfinite metric | Preserve null/reason in response/readout; omit point; never coerce to zero | L1, L2, L4 |
| One lap or constant lap number | Expand x-domain around singleton to avoid degenerate scale | L2, L6 |
| No complete metric points | Keep panel and display explicit unavailable state; cards retain unavailable reasons; summary evidence remains accessible | L2, L4, L7 |
| Multiple drivers or duplicate lap numbers | Use lapId identity; retain separate driver/context groups and stable order | L1, L2 |
| Compound varies or is unknown | Keep separate groups; expose All/known/Unknown filter only when distinct values > 1 | L3, L5 |
| No compound change | Hide compound filter | L5 |
| Hot/Cold or compound filter changes | Recompute overlays; preserve focus if any finite metric remains visible, otherwise clear it. Fuel remains unaffected by compound filtering. Card hot summaries stay stable; cold evidence remains in details. | L3, L4, L5, L7 |
| New saved lap while page open | Existing `strategy-updated` invalidates query; chart updates from API | L1, L6 |
| Empty/stale data, route/session change | Empty status, no aggregate fallback; reset filters/focus on session change; card selection/details remain scoped to current stints | L3, L6, L7 |
| 400/404/503 and network retry | Reuse current strategy error/retry presentation; never show prior session points | L1, L6 |
| One stint / comparison limit | Omit selector for one stint; allow at most two selected. Focus comparison above cards after the second selection; expose View comparison controls and disabled-state hint. | L4, L7 |
| Missing cold stats or incomplete summary | Render available hot rates; show unavailable reasons/counts; cold detail only when present, never synthesize values | L4, L7 |
| Long labels, many stints, or mobile viewport | Keep concise headings and expandable diagnostic context. Scroll plots locally instead of shrinking labels or point targets. Stack cards; collapse zero-evidence content while preserving anchors and compare controls. | L4, L6, L7 |

## Shared end-to-end scenarios

Use existing `packages/race-strategy/test/e2e/stint-strategy.spec.ts`, `StrategyRuntime`, actual native ingestion, real compiled `dist/raceiq`, actual HTTP/RPC and isolated database. Mocks may support UI development only; they cannot replace this integration.

- **E1 → L1/L2/L4/L7:** Ingest deterministic laps with distinct fuel and four-wheel rates, including zero and a wheel-specific missing value. Verify API values/order/identity against persisted rows, then open `/fm23/sessions/{id}/analyse`; inspect all five plot point coordinates, focus a lap by pointer and keyboard, and verify linked highlight/readout. Confirm stint cards show lap span/status/compare control and hot metric P50/P95 plus counts; expand details to verify audit evidence.
- **E2 → L3/L5/L7:** Seed durable current-version lap contributions with cold/warm states and two stint summaries using different compounds; verify API after restart. Toggle Hot/Cold, P50/P95 independently, All/one compound/Unknown; expected values, overlays, domains, fuel invariance and comparison selection are observed. Expand a card and verify cold rates remain accessible without changing its hot headline values.
- **E3 → L1/L3/L5/L7:** No current metrics returns 200 empty. Wrong-game session returns 404; malformed query/header returns 400; storage failure returns 503. A real saved lap after page load triggers websocket invalidation and new point appears; no mocked endpoint. Verify cards preserve two-selection limit, disable a third, and retain compare navigation and anchors.
- **E4 → L2/L4:** Include zero, partial, fully missing, excluded and repeated lap numbers from separate drivers. Verify zero only plots when valid; all missing reasons remain available; no NaN/Infinity; singleton and empty panels retain readable axes/status.
- **E5 → L3/L4/L6/L7:** At 1440×1000 and 390×844, exercise Hot/Cold, compound and P50/P95 controls with keyboard and pointer. Measure rendered axis labels and hit targets, verify plot-local scrolling without page overflow, select matching points across plots, and inspect exact thermal labels. Verify closed empty-card disclosures retain evidence and anchors, measured cards precede them, the second comparison selection focuses the result above cards, and View comparison works from either selected card.
- **E6 → L6/L7:** Delay and fail actual lap-metrics response, verify loading/error/retry; navigate to another session and verify filters/focus reset and no previous data flashes. Card summaries/details contain only current-session stint data.

## Verification evidence

Passed: `bun run typecheck` (race-strategy UI/server: 62/250 files); `bun run build:browser` (client types across 1,225 files + compiled backend); `bun run test:e2e stint-strategy.spec.ts` (8 passed, 4.6m, real compiled app/backend). Focused E2/E5 passed after the final mobile assertions (1/1). Reviewed desktop 1440×1000 and mobile 390×844; [desktop cards](../../playwright/test-results/race-strategy/stint-strategy-E2-E5-persi-1574b-s-focus-and-responsive-view-race-strategy/stint-cards-desktop-dark.png), [mobile card 1](../../playwright/test-results/race-strategy/stint-strategy-E2-E5-persi-1574b-s-focus-and-responsive-view-race-strategy/stint-cards-mobile-dark.png), [mobile card 2](../../playwright/test-results/race-strategy/stint-strategy-E2-E5-persi-1574b-s-focus-and-responsive-view-race-strategy/stint-card-second-mobile-dark.png), [desktop chart](../../playwright/test-results/race-strategy/stint-strategy-E2-E5-persi-1574b-s-focus-and-responsive-view-race-strategy/stint-cold-desktop-dark.png), [mobile chart](../../playwright/test-results/race-strategy/stint-strategy-E2-E5-persi-1574b-s-focus-and-responsive-view-race-strategy/stint-cold-mobile-dark.png). Browser bundle emits >2 MB chunk warning. Locale compile reused validated translations during browser build.

UI audit refinement verification: `bun run typecheck` passed (37 tasks), `bun run build:browser` passed, final feature lint passed, all 16 locale key sets passed, and changelog validation passed (11 tests). Eight targeted real-app E2E scenarios passed across the integration and corrected focused runs. Desktop 1440×1000 and mobile 390×844 inspection confirmed readable labels, 24px targets, no document overflow, persistent lap evidence, honest thermal labels, comparison focus and collapsed empty cards. See [scoped outcomes and exact evidence files](../../.omp/evidence/strategy-design-validation.json). The full repository suite and live hardware session were not run.
