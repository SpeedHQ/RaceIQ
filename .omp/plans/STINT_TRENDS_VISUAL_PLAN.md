# Stint trends visual refresh

## Context

Redesign Session Analyse's Stint trends as a chart-first dashboard using actual TanStack Charts and its [Dumbbell comparison example](https://tanstack.com/charts/catalog/charts/17-dumbbell). Each stint is a row: filled p50 endpoint, outlined p95 endpoint, connecting segment. Fuel occupies one large panel; FL/FR/RL/RR occupy four small multiples; one Hot / Cold switch controls all five.

This supersedes the cards-first/custom-renderer proposal. Preserve existing evidence, comparison, session navigation, persisted data, APIs, and percentile arithmetic. This is UI-only; no backend implementation or cross-layer contract change is required.

## Approach

### 1. Add the actual TanStack dumbbell renderer

- From `packages/race-strategy`, run `bun add --exact @tanstack/charts@1.1.0`; retain the dependency and workspace lockfile change. Registry metadata confirms 1.1.0 is published. Existing React 19 satisfies documented React 18/19 support. Add no D3, GSAP, or second chart dependency.
- Add private `packages/race-strategy/ui/StintDumbbellChart.tsx`. Existing `RateChart` only draws average-value CSS bars, so no equivalent percentile renderer exists. Compose `defineChart`, `link`, and two `dot` marks from `@tanstack/charts`, compact linear/band scales from `/scales/linear` and `/scales/band`, and SVG `Chart` from `/react`. Reuse the catalog's mark composition, not its wage data, year labels, or direct D3 imports.
- Website docs follow unreleased main. Use installed 1.1.0 declarations and [release-source docs](https://github.com/TanStack/charts/tree/v1.1.0/docs) for exact option signatures. Translate newer catalog options into installed public equivalents; never substitute handmade SVG. The pinned release quick start confirms responsive measurement, typed datum focus, memoized definition updates, and framework-owned cleanup.
- Define private `ThermalPopulation = "hot" | "cold"`. Chart props: `stints: StintSummary[]`, `metric: "fuel" | number`, `population: ThermalPopulation`, `focusedStintId: string | null`, `onFocusStint: (id: string | null) => void`. Use stint IDs as datum keys and ordinal as row label. Do not add a package public export.

### 2. Keep percentile meaning and scale integrity

- Replace all five `RateChart` callers in `StrategyStints.tsx`, then remove that obsolete function. Hot values come from `rateStatistics.fuel` or `.tires[index]`; cold values from `coldRateStatistics` or `coldTireRateStatistics[index]`. Do not plot average `MetricRate.value` as a percentile or modify server calculations.
- Preserve the context key currently constructed by `RateChart`: game, track, car, driver, unit, semantic version, setup, required Forza PI, and wheel compound. Missing semantic versions/required PI remain isolated by stint ID. Render separately labeled groups for incompatible contexts; retain current `compatibleMetric` and `difference`.
- Within each metric/context, set x domain `[0, max * 1.1]` using finite p50/p95 across both hot and cold. If max is absent or zero, use `[0, 1]` in underlying units. Domains remain stable across the thermal switch. Each wheel retains its own context domains; do not imply a common scale for incompatible compounds or units.
- Retain missing rows and their reasons. Render each available endpoint independently; draw a segment only when both exist. Zero is valid. Equal endpoints show an outlined p95 ring around filled p50. No hot fallback for missing cold data. Label endpoints p50/p95, never confidence interval or within-stint progression.
- Format exact values/units through `useStrategyFormat`. Fractional rates display percentage points through existing formatting. Tooltips include stint, wheel/metric, both percentiles, units, and evidence. Hot count is the metric's `eligibleLaps`; cold count is `coldLaps ?? 0`, explicitly population count, not invented per-wheel eligibility.

### 3. Compose the dashboard and thermal switch

- Keep `stint-analysis`, its title, Generate race plan link, and Overview mounting location. Place `stint-summary-chart` before the evidence table.
- At `xl`, use `grid-flow-dense` with two equal columns and two rows: fuel spans both rows on the left; the right contains FL/FR then RL/RR. This fills every cell. Below `xl`, fuel goes above the two-column wheel grid; below `sm`, wheel panels stack FL, FR, RL, RR. All containers use `min-w-0`. Chart height is `max(200, 76 + 36 * rowCount)` per context, avoiding clipped long sessions and excessive empty one-stint canvases.
- Use existing Geist, `app-*` theme tokens, subdued gridlines, tabular numerals, rounded borders, subtle surface highlight, and 16–24px padding. Distinguish percentile endpoints by shape, not color alone. Do not introduce landing-page hero/navigation, stock images, marketing components, scroll pinning, or randomized layouts into this embedded analysis view.
- Add `population` state defaulting `"hot"` and a native button group with `aria-pressed`. Show Hot / Cold only when existing `hasCold` detection finds cold figures. Cold displays existing `strategy_cold_help`. Toggle all five plots and linked readout together, preserving focus, stint order, and comparison selection.
- Reset population to Hot and focus to null on game/session change; reset Hot if refreshed data loses all cold figures. Do not persist this view preference.
- Add `strategy_population_label: () => string`, `strategy_population_hot: () => string`, `strategy_population_cold: () => string` to `RaceStrategyMessages` and every `client/messages/*.json`; English is `"Tire temperature"`, `"Hot"`, `"Cold"`. Preserve existing locale parity and host wiring. Reuse existing metric, percentile, stint and evidence messages.

### 4. Link focus and preserve full evidence

- Keep one `focusedStintId` in `StrategyStints`. Wire documented TanStack pointer/keyboard focus callbacks to it; emphasize the corresponding stint across all plots without moving DOM focus or modifying compare selection. Clear transient focus on chart blur/pointer leave. Clear stale IDs when stints disappear. Missing points remain missing.
- Beneath charts show a compact HTML exact-value readout for the focused stint, or first stint by default: five metrics, selected thermal population, both percentiles, counts and unavailable reasons. Values must remain accessible without hover. Keyboard and pointer focus expose identical data.
- Preserve the actual semantic `stint-summary-table`, open and visible below the dashboard; refine spacing/borders rather than replacing it with cards or giving non-table markup a table test ID. Keep hot/cold evidence columns under existing rules, measured fuel/coverage, average lap, status disclosures/exclusions, `stint-{id}` anchors, and checkbox labels/limits. Thermal switch changes only charts/readout; the table remains a complete audit view.
- Preserve the selected-two comparison table, all metric rows, cold inclusion rule, p50 difference, incompatibility messages, `aria-live`, selection-limit hints and navigation link. Dumbbell endpoints always mean p50/p95, not selected stint A/B.
- Memoize chart definitions against captured inputs. Use built-in SVG tween updates with reduced-motion respected; no delayed values or looping animation. Rely on React chart lifecycle cleanup. Keep query loading/status, error alert/retry and empty-state behavior. Restrict overflow to keyboard-scrollable table regions, never document width.

## Critical files & anchors

- `packages/race-strategy/ui/StrategyStints.tsx` — current renderer, compatibility grouping, formatting, summary table and comparison.
- `packages/race-strategy/ui/strategy-format.ts` — authoritative units, fraction conversion and missing-reason formatting.
- `packages/race-strategy/test/e2e/stint-strategy.spec.ts` — real ingestion, route, evidence, comparison, persistence and screenshots.
- `packages/race-strategy/test/e2e/runtime.ts` — isolated compiled runtime and disposable database fixture helper.
- `packages/race-strategy/contracts/messages.ts` — three new thermal-control functions; all existing members remain.

## Acceptance criteria

- **AC1:** Actual TanStack SVG dumbbells render fuel and four wheels: stint rows, labeled p50/p95, units, separate compatibility groups.
- **AC2:** Hot default; switch appears only with cold figures and updates five plots/readout together without changing domains or comparison selection.
- **AC3:** Exact values/counts and missing reasons remain available without hover; existing evidence, disclosures, anchors, comparison and navigation work.
- **AC4:** 1440px/390px dashboard fits without page overflow; keyboard-linked focus, visible focus, shape distinction and reduced motion work.
- **AC5:** Zero/equal/partial/missing endpoints, incompatible contexts, one/many stints, empty/loading/error/retry and session resets behave correctly.

## Verification

No execution checks have run during planning. Record each scenario's outcome and screenshot paths after implementation; unexecuted or blocked checks are not completion evidence.

### Runtime and commands

Use repository root, Bun, installed workspace dependencies and Playwright Chromium. Existing package E2E script uses compiled isolated mode. Run `bun run build:browser` after source/dependency changes; this invokes the repository's Turbo build with F1/iRacing feature flags. `StrategyRuntime` consumes fresh `dist/raceiq` on macOS or `PW_COMPILED_BINARY`. Runtime allocates ports, `DATA_DIR` and access settings automatically; never use a user's real DB.

1. Run `bun run --cwd client i18n:compile`.
2. Run `bun run --cwd packages/race-strategy typecheck`.
3. Run `bun run --cwd packages/race-strategy test:e2e stint-strategy.spec.ts`.
4. Inspect generated desktop/mobile screenshots and the actual isolated analysis page through authorized page-only browser automation. Check console errors, chart focus and switching. No native desktop control.

### Real-app E2E scenarios

- **E1 → AC1/AC3:** Extend existing percentile case with `[0.04, 0, 0.02, 0.01, 0.08, 0.03, 0.09]` fuel samples and unequal wheel evidence. Open `/fm23/sessions/{id}/analyse`; exact chart/readout values and counts match real stints API with existing formatting. Expect five named SVG plots and axis units. Keyboard/pointer focus on another stint updates the shared HTML readout and highlights that stint across plots. Do not assert private SVG nesting.
- **E2 → AC2/AC5:** In a separate runner after real native ingestion, crash backend and use `databaseStatement` to update only that session's `strategy_stints.payload`, preserving current algorithmVersion, identity and rebuild state. Set one stint's cold fuel to `{p50:0.04,p95:0.08}`, four cold wear pairs to `{p50:0.004,p95:0.008}`, and `coldLaps:2`; leave another stint without cold pairs. Restart and first verify API returns those fixtures. Real page defaults Hot; Cold shows 4/8 percent-per-lap fuel and 0.4/0.8 wear with two laps, while the other stint shows unavailable. Switching back restores hot figures, same domains and selection. An untouched no-cold session has no switch. This validates persistence→API/schema→query→chart, not cold-detection arithmetic.
- **E3 → AC3/AC5:** Extend existing multi-stint setup to three stints. Select two checkboxes; third is disabled; comparison retains exact percentiles/p50 differences. Uncheck one, select third, follow comparison navigation and verify client navigation plus `#stint-{id}` anchors. Using the same disposable fixture technique, vary setup/unit/compound; expect separate context headings and existing not-comparable output rather than a shared comparison.
- **E4 → AC1/AC5:** Prepare disposable persisted pairs: zero/zero, equal positive values, p50-only, p95-only and neither. Open real route: zeros and equal values remain visible, partial pairs show only available endpoints without a segment, neither shows missing reason; no NaN/Infinity geometry or console errors. One stint has no compare checkbox; long context groups retain all rows.
- **E5 → AC4:** Capture populated dashboard in Hot/Cold at 1440×1000 and 390×844, including light/dark themes. Assert document width ≤ viewport and chart widths ≤ containers; confirm readable labels, all five panels reachable, local table overflow and filled/outlined markers. Keyboard reaches thermal controls, chart points, checkboxes, disclosures and links with visible focus. Under `reducedMotion: "reduce"`, switching updates values immediately without continuing animation.
- **E6 → AC2/AC5:** Reuse existing completed-empty-generation fixture: empty status and no charts/comparison. Delay a real stints response to observe loading; abort one request and retry against actual backend to verify error/retry. Navigate to another session after selecting Cold: state resets Hot and prior focus/data does not persist.

Extend `stint-strategy.spec.ts` and its existing fixture patterns, not a mock-only render or new parallel test harness. Static checks supplement E1–E6; all criteria and boundary cases require passing application-path evidence before completion.

## Assumptions & contingencies

- Hot names the existing non-cold population, including thermally unavailable laps under current server semantics. Do not change inclusion rules or imply measured core temperature for every hot sample.
- Installed 1.1.0 public declarations take precedence over unreleased-main website examples. If required rendering or keyboard integration cannot be achieved with published APIs, report the exact blocker rather than silently changing libraries or dropping behavior.
- No backend production changes are planned. Dependency, localized controls and E2E fixtures belong to this one bounded UI deliverable; no separate backend plan is needed.
