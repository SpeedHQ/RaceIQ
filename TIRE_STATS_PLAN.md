# tire-stats-plan

Session-analyse stint statistics become **Stint Trends**: tire wear and fuel reported at p50/p95 instead of the average/median/peak selector, and driving on cold tires is measured separately from driving on hot tires because lap behaviour differs. Scope is stint statistics only — pit estimates, race plans, and charts keep their current inputs.

## Context

- Section renders from `packages/race-strategy/ui/StrategyStints.tsx` (`StrategyStints`, `data-testid="stint-analysis"`), mounted by session analyse. Title currently `m.strategy_title()`.
- Per-lap samples are accumulated in `packages/race-strategy/server/stint-accumulator.ts`; `statistics(samples)` returns `{ median, peak }` and `summary.rateStatistics` is persisted in the stint payload.
- Wire type: `shared/racing/live/strategy.ts` `rateStatistics?: { fuel: { median; peak }; tires: FourWheels<{ median; peak }> }`; schema mirror in `shared/racing/live/strategy-schemas.ts`.
- Cold detection uses measured core values only. Sources: ACC/AC Evo expose `acc.tireCoreTemp` (four wheels, °C); F1 2025 and AC Evo also expose one core value per wheel as `TireCarcassTemp*` (F1 `tyresInnerTemp*`). LMU and Forza expose only surface/selected `TireTemp*`, and iRacing only lateral carcass bands — those MUST NOT be treated as core, so their laps stay `"unavailable"` and contribute to the hot population. The cold cutoff is the minimum of `GameAdapter.tireTempOptimal` for the fitted compound (`getTireCoreTempRange`), with fallback to `tireTempThresholds.cold`. Seeded ranges: ACC dry 70–100 / wet 50–70 (official ACC v1.9 physics notes; Coach Dave wet telemetry), F1 soft 75–95, medium 80–105, hard 85–115, inter 60–80, wet 50–70 (F1 25 compound table), AC Evo dry 75–100 / wet 50–70 (game thermal reference).
- Per-lap wear rate is computed in `packages/race-strategy/server/lap-metrics.ts` `aggregateLapMetrics(packets, …)`, which already has the packets and returns `LapMetricContribution`.

## Approach

### 1. Persisted statistics: median/peak → p50/p95 (`stint-accumulator.ts`, schema, wire type)

- In `stint-accumulator.ts` replace `type RateStatistics = { median; peak }` with:
  ```ts
  type RateStatistics = { p50: number | null; p95: number | null };
  ```
- Replace `statistics(samples)` body with nearest-rank percentiles over the already-sorted array (samples are inserted sorted by `insertSample`):
  ```ts
  const percentile = (samples: number[], fraction: number) =>
    samples.length === 0 ? null : samples[Math.min(samples.length - 1, Math.floor(fraction * (samples.length - 1)))];
  function statistics(samples: number[]): RateStatistics {
    return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
  }
  ```
  Single-sample array yields `p50 === p95 === sample`; empty array yields both `null` (same null semantics as today's `{median: null, peak: null}`).
- Rename the accumulator's `rateStatistics` field content only; the summary key `rateStatistics` keeps its name so persistence stays readable, but its shape is now `{p50, p95}`.
- Update `shared/racing/live/strategy.ts` (`rateStatistics?` shape) and `shared/racing/live/strategy-schemas.ts` (`z.object({ p50: nullableNumber, p95: nullableNumber })` for `fuel` and each of `tires`).
- Bump `STRATEGY_ALGORITHM_VERSION` in `lap-metrics.ts` from `"stint-metrics-v4"` to `"stint-metrics-v5"` so startup backfill (`strategy-backfill.ts`) rebuilds stored `{median, peak}` payloads into p50/p95; stored laps untouched, per existing backfill contract.

### 2. Cold-tire separation (`lap-metrics.ts` → `stint-accumulator.ts`)

Cold separation is done at the sample level: each eligible lap contributes fuel/wear to the **hot** population when it is thermally hot, and is excluded from the hot population when it is cold; cold laps accumulate in parallel cold populations so the UI can show them.

- In `lap-metrics.ts` add to `LapMetricContribution`:
  ```ts
  thermalState: "cold" | "warm" | "unavailable";
  ```
  Compute it inside `aggregateLapMetrics` from the measured core channel only:
  - Collect frames where `packet.acc?.tireCoreTemp != null && Number.isFinite(...)` for all four wheels and `(packet.Speed ?? 0) > 5` (same loaded-frame rule as `tireTempSymptoms`).
  - `mean core` = mean over those frames of the four-wheel mean.
  - Fewer than `MIN_FRAMES` loaded frames (30, matching `tireTempSymptoms`) or no `acc.tireCoreTemp` at all → `"unavailable"` (covers games without a core channel; never fall back to `TireTemp*`).
  - Mean core below `getServerGame(gameId).tireTempThresholds.cold` → `"cold"`; otherwise → `"warm"` (a lap is never "hot" for splitting purposes; the cutoff is the game's existing optimal-range minimum).
- In `stint-accumulator.ts` add parallel populations:
  ```ts
  private coldFuelPopulation: number[] = [];
  private coldTirePopulations: FourWheels<number[]> = [[], [], [], []];
  private coldLaps = 0;
  ```
  and summary fields:
  ```ts
  coldRateStatistics?: { p50: number | null; p95: number | null };
  coldTireRateStatistics?: FourWheels<{ p50: number | null; p95: number | null }>;
  coldLaps?: number;
  ```
  In `add()`:
  - if `metrics.thermalState === "cold"` → push the lap's fuel/tire samples into the cold populations only, and increment `coldLaps`; do **not** push them into `fuelPopulation`/`tirePopulations` (hot).
  - otherwise (`"warm"` or `"unavailable"`) → unchanged behaviour (push into hot populations). Unavailable stays in hot so games without a core channel keep their current numbers rather than losing all data.
  - Excluded/invalid laps (`metrics.exclusionReason` non-null) remain excluded from both populations, matching today's `note()`-only handling — they already never reach the push sites because their metric values are `null`.
  - Refresh `coldRateStatistics`/`coldTireRateStatistics` in the same place `rateStatistics` is refreshed, using `statistics()` on the cold populations.
- `rebuildStintSummary` needs no change (it delegates to `add`). `fork()` MUST copy the new arrays (`coldFuelPopulation`, `coldTirePopulations`, `coldLaps`) with the same spread style as existing fields.
- Update `shared/racing/live/strategy.ts` + `strategy-schemas.ts` with the three new optional fields (optional so pre-v5 payloads parse; backfill removes the need to keep them stale).

### 3. Stint Trends UI (`StrategyStints.tsx`, messages)

- Rename the section: `m.strategy_title()` value changes from `"Stint averages"` to `"Stint trends"` in `client/messages/en.json` key `strategy_title` (all other locale catalogs get the same key's translated value; untranslated locales fall back as they do today).
- Remove the statistic selector (`Statistic = "average" | "median" | "peak"`, the `role="group"` button row, `statistic` state, the `useMemo` that swaps rates by statistic, and the `strategy_peak_help` paragraph). Delete now-unused `strategy_statistic_average` / `strategy_statistic_median` / `strategy_statistic_peak` / `strategy_statistic_label` / `strategy_peak_help` from `RaceStrategyMessages` (`packages/race-strategy/contracts/messages.ts`) and from every `client/messages/*.json` catalog (clean cutover; leave `strategy_sample_laps` and `strategy_table_caption`).
- Table rows come from `query.data.stints` directly (`stints = query.data?.stints ?? []`, no rate substitution). The fuel cell and each tire cell render **both** percentiles instead of one value:
  ```
  p50 <value> · p95 <value>
  ```
  using existing `useStrategyFormat().strategyRateText` for each number; `—` when null; keep the existing `strategy_sample_laps({count: rate.eligibleLaps})` sub-line once per cell.
- Add two columns after the wheel-rates column, shown only when at least one stint has `coldRateStatistics?.p50 != null || coldTireRateStatistics?.[i]?.p50 != null`:
  - `m.strategy_cold_fuel()` — `p50 · p95` plus `m.strategy_sample_laps({count: stint.coldLaps ?? 0})`
  - `m.strategy_cold_wear()` — same grid as the hot wheel cell, `p50 · p95` per wheel.
  When no stint has cold data, both columns are omitted (games without core temps see no empty column).
- New message keys (add to `RaceStrategyMessages` in `contracts/messages.ts` and all `client/messages/*.json`):
  - `strategy_cold_fuel: () => string`
  - `strategy_cold_wear: () => string`
  - `strategy_percentile_p50: () => string` (label text used as prefix "p50")
  - `strategy_percentile_p95: () => string`
  Add `strategy_cold_help` (short note: "Laps measured on cold tires (below the game's optimal core temperature) are kept out of the hot-tire figures.") rendered as the muted help paragraph that replaces the old peak help.
- Comparison table (`selected.length === 2`): `addRate` rows now receive the hot `p50`/`p95` pair instead of a statistic-swapped rate. Render each compared value as `p50 · p95`; the existing `difference()` helper stays untouched and is applied to the `p50` values. Add cold rows for fuel and each wheel when both selected stints have cold statistics.
- Charts (`RateChart`) unchanged — they continue to use `stint.fuel`/`stint.tires` (hot averages). Scope boundary: charts and pit estimates keep current inputs.

### 4. Tests to update alongside (existing assertions on `median`/`peak` break)

- `packages/race-strategy/test/integration/stint-strategy.test.ts`: replace `{ median, peak }` expectations with `{ p50, p95 }` using nearest-rank values for the existing sample sets (e.g. `[0.09, 0, 0.02, 0.01, 0.08, 0.03, 0.04]` sorted → p50 `0.03`, p95 `0.08`); add one case asserting a lap with `thermalState: "cold"` contributes to `coldRateStatistics`/`coldLaps` and not to `rateStatistics`.
- `packages/race-strategy/test/e2e/stint-strategy.spec.ts`: remove the Average/Median/Peak button interactions (lines around `getByRole("button", { name: "Median" … })`) and assert the table shows `p50`/`p95` text; keep persistence round-trip assertion comparing `rateStatistics`.
- `packages/race-strategy/test/e2e/strategy-backfill.spec.ts`: stored-version string `stint-metrics-v1` in the simulated stale payload must become the new previous version so backfill still triggers (use `stint-metrics-v4`); assertion that `rateStatistics != null` unchanged.

## Critical files & anchors

- `packages/race-strategy/server/stint-accumulator.ts` — `RateStatistics`, `statistics()`, `add()`, `fork()`, `rebuildStintSummary()`.
- `packages/race-strategy/server/lap-metrics.ts` — `LapMetricContribution`, `aggregateLapMetrics`, `STRATEGY_ALGORITHM_VERSION`.
- `packages/race-strategy/ui/StrategyStints.tsx` — selector removal, p50/p95 cells, cold columns, comparison rows.
- `shared/racing/live/strategy.ts` + `shared/racing/live/strategy-schemas.ts` — `rateStatistics` shape and new cold fields.
- `packages/race-strategy/contracts/messages.ts` + `client/messages/en.json` — key removals/additions (all locale catalogs must stay key-identical; existing catalog parity test enforces it).

## Verification

Prerequisites: run from repo root with existing dev DB; `bun install` already done.

1. Typecheck + unit: `bun run typecheck` and `bunx vitest run packages/race-strategy/test/integration/stint-strategy.test.ts`. Expect percentile cases: samples `[0.01, 0.02, 0.03, 0.08, 0.09]` → `p50 = 0.03`, `p95 = 0.08` (nearest-rank index `floor(fraction * (n - 1))`); one sample `[0.03]` → `{p50: 0.03, p95: 0.03}`; empty → `{p50: null, p95: null}`.
2. Cold split unit case (same suite): feed 3 warm laps at `0.02` and 1 cold lap at `0.06` → `rateStatistics.fuel.p50 = 0.02`, `coldRateStatistics.fuel.p50 = 0.06`, `coldLaps = 1`, and `fuel.value` still averages only the 3 hot laps. A separate case asserts the game optimal-range cutoff: 74 °C is cold for Forza (75) and 76 °C is warm; 76 °C is cold for F1 (80); fewer than 30 loaded frames is unavailable.
3. E2E: `bun run --cwd packages/race-strategy test:e2e stint-strategy.spec.ts`. Percentile and cold-split arithmetic is covered by the integration tests; E2E asserts the heading **"Stint trends"**, no Average/Median/Peak buttons, `p50`/`p95` present in fuel, tire, and comparison cells, and the persistence round-trip after restart.
4. Backfill: `bun run --cwd packages/race-strategy test:e2e strategy-backfill.spec.ts`. Expect stored payloads with the previous algorithm version rebuild to `{p50, p95}` after restart, seed-version row included.
5. Manual smoke: open a recorded ACC/AC Evo session's Overview in the app; confirm hot-vs-cold values differ, the cold columns are absent for a game without `acc.tireCoreTemp` (e.g. LMU/Forza), and no page overflow at 390 px width.

## Assumptions & contingencies

- Cold cutoff uses the fitted compound's core-channel `tireTempOptimal` entry from game metadata and falls back to `tireTempThresholds.cold` when absent (LMU/Forza have no core channel). Car-class-specific windows are not wired: ACC/AC Evo/F1 packets carry `CarClass: 0`, and class lives only in car catalogues. AC Evo tyre type (road/semi-slick/slick) is not exposed per packet, so its compound range assumes the slick/GT window; tune the metadata entry when a type signal lands. Compound/source values are documented next to each adapter and change only in the game metadata package.
- Cold detection is whole-lap (mean over loaded frames). If a lap is half cold/half hot in practice, it stays a single "warm" or "cold" bucket by that mean; upgrading to per-sample splitting would require persisting samples and is out of scope.
- `coldRateStatistics`/`coldTireRateStatistics`/`coldLaps` are optional on the wire so pre-v5 rows parse; the version bump makes backfill replace them, so no migration script is written.
