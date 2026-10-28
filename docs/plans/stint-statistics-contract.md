# Stint fuel and wear statistics contract

Implementation: [backend](stint-statistics-backend-plan.md), [UI](stint-statistics-ui-plan.md).

## Agreed boundary

Extend the existing `StintsResponseSchema` / `StintSummary` response and persisted JSON, without adding endpoints or changing existing authorization, ordering, errors, or mean-based planner behavior. `fuel.value` and `tires[i].value` remain arithmetic means. Add optional `rateStatistics: { fuel: { median: number | null; peak: number | null }; tires: [statistics, statistics, statistics, statistics] }`. Values use the corresponding metric's existing unit. Example: fuel samples `[2, 3, 7]` produce existing mean `4`, median `3`, peak `7`, eligibleLaps `3`.

One eligible recorded lap is one sample. Use all eligible contributions in that stint, not rolling windows or means of stints. Fuel and individual wheels retain separate eligibility/counts, using existing `aggregateLapMetrics` exclusions. Median of even samples is the mean of the middle pair; peak is maximum consumption/wear. Zero is valid. No samples yields null statistics; one sample yields identical mean/median/peak. Missing legacy statistics remain unavailable, never inferred from the mean. Bump the aggregation algorithm version so the existing safe startup backfill regenerates old recorded sessions; unavailable recordings retain honest unavailable statistics. Do not rewrite saved race-plan evidence or alter generation forecasts.

UI offers Average / Median / Peak for fuel and four-wheel tire wear, consistently across table, charts, and comparison. Pace and measured total fuel stay unchanged. Show eligible lap evidence counts; preserve metric-specific counts when they differ. Raw semantic identifiers are not ordinary visible copy. Empty chart entries remain excluded; comparison compatibility rules remain unchanged.

## Acceptance

- S1: New persisted summaries and existing response/schema preserve exact mean, median, peak for every eligible fuel/wear lap and retain separate counts.
- S2: Zero/missing/single/even/odd samples, exclusions, fork isolation, and windows longer than five fuel or three tire laps follow the definitions above.
- S3: Existing historical summaries rebuild through the existing startup path; reload returns the same statistics; unavailable sources do not fabricate values or lose records.
- S4: Average / Median / Peak updates table, charts, and comparison together, displays lap-count evidence, and leaves pace, totals, planning generation, and compatibility semantics unchanged.
- S5: Desktop/mobile, missing data, and comparison-selection transitions remain accessible and free of page overflow.

## Shared E2E strategy and owner

Coordinator owns integration execution and outcomes. Extend existing feature `test/e2e/stint-strategy.spec.ts` or use its real compiled-runtime support, controlled native telemetry input, and isolated persistence (no mocked statistics endpoint). E1: ingest deterministic multi-lap stint (odd/even, zero, excluded lap, wheel-specific missing data, more than rolling-window limits), open real session Overview, switch all three statistics, compare exact API/UI values and counts; select two stints, disable third, deselect. Covers S1/S2/S4/S5. E2: restart the real backend with outdated aggregates and retained recorded evidence, verify algorithm upgrade and durable exact statistics after reload; unavailable recording remains honest. Covers S3/S2. E3: supplied running session 10 browser smoke at desktop and 390px: actual recorded rates, selectors, details, charts, comparison and overflow. Covers S3/S4/S5 with real existing evidence. Supplemental accumulator/schema checks cover exact boundaries and fork independence. Record executed outcomes below; planned/unrun scenarios are not evidence.

## Verification outcomes

- S1/S2/S4/S5: All five tests in the complete compiled `stint-strategy.spec.ts` module passed, including full-stint populations beyond rolling windows, independent wheel counts, zero samples, all three statistic selections, comparison and restart persistence. All five `fuel-units.spec.ts` tests also passed after the final table-spacing correction. [Complete module log](../../.omp/evidence/strategy-adherence/table-e2e.log).
- S3: Both complete `strategy-backfill.spec.ts` scenarios passed against native recorded inputs, preserving original lap/session metadata and handling active or missing recordings honestly. [Native module log](../../.omp/evidence/strategy-adherence/native-e2e.log). Its unrelated earlier F1 scenario failure was corrected and the complete affected module rerun successfully; it is not counted as passing evidence.
- E3: The supplied live session 10 page passed actual desktop and 390px browser smoke. Average/Median/Peak fuel and all four chart values matched the API to display precision, metric lap evidence remained visible, details and comparison-selection transitions worked, and both viewport sizes had zero wheel-text overlap, document overflow or browser errors. [Selected observations](../../.omp/evidence/strategy-adherence/session10.json), [desktop capture](../../.omp/evidence/strategy-adherence/session10-desktop.png), [mobile capture](../../.omp/evidence/strategy-adherence/session10-mobile.png), [readable wheel cells](../../.omp/evidence/strategy-adherence/session10-wheels-mobile.png).
- Feature integration, unit, build, type, lint, boundary and all-locale checks passed. Shared final scopes and retained evidence are recorded in the [adherence outcomes](strategy-adherence-contract.md#outcomes).
