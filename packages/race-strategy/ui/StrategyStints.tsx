import { Link } from "@tanstack/react-router";
import { getGame } from "@raceiq/shared/games/registry";
import type { ReactNode } from "react";
import { useRaceStrategyHost } from "./host";
import type { RaceStrategyMessages } from "../contracts";
import { useEffect, useRef, useState } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { MetricRate, StrategyLapMetric, StintSummary } from "@raceiq/shared/racing/live/strategy";
import { useStrategyLapMetrics, useStrategyStints } from "./stint-strategy";
import { useStrategyFormat } from "./strategy-format";
import { StintDumbbellChart, type StintMetric, type ThermalPopulation } from "./StintDumbbellChart";

const wheels = ["FL", "FR", "RL", "RR"] as const;
type Statistics = { p50: number | null; p95: number | null };
function compatibleMetric(a: StintSummary, b: StintSummary, metric: "fuel" | number, piRequired: boolean) {
  if (a.gameId !== b.gameId || a.driverKey !== b.driverKey || a.carId !== b.carId || a.trackId !== b.trackId ||
    a.compatibility.setupKey !== b.compatibility.setupKey || piRequired && (a.pi == null || b.pi == null || a.pi !== b.pi)) return false;
  if (metric === "fuel") return a.fuelUnit === b.fuelUnit && a.compatibility.fuelSemanticVersion != null && a.compatibility.fuelSemanticVersion === b.compatibility.fuelSemanticVersion;
  return a.compounds[metric] === b.compounds[metric] && a.compatibility.tireSemanticVersions[metric] != null && a.compatibility.tireSemanticVersions[metric] === b.compatibility.tireSemanticVersions[metric];
}

function difference(a: MetricRate, b: MetricRate, compatible: boolean, m: RaceStrategyMessages) {
  if (!compatible) return m.strategy_not_comparable();
  if (a.value == null || b.value == null || a.unit !== b.unit) return m.strategy_missing_difference();
  const delta = b.value - a.value;
  const value = `${delta > 0 ? "+" : ""}${(a.unit === "L/lap" ? delta : delta * 100).toFixed(2)}`;
  return a.unit === "L/lap" ? m.strategy_rate_litres({ value }) : m.strategy_rate_points({ value });
}

export function StrategyStints({ gameId, sessionId }: { gameId: GameId; sessionId: number }) {
  const { m } = useRaceStrategyHost();
  const { strategyReasonText: reasonText, strategyRateText: rateValue, strategyFuelUsedText } = useStrategyFormat();
  const query = useStrategyStints(gameId, sessionId);
  const lapQuery = useStrategyLapMetrics(gameId, sessionId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [population, setPopulation] = useState<ThermalPopulation>("hot");
  const [focusedLapId, setFocusedLapId] = useState<number | null>(null);
  const [selectedCompound, setSelectedCompound] = useState("all");
  const [showP50, setShowP50] = useState(true);
  const [showP95, setShowP95] = useState(true);
  const comparisonRef = useRef<HTMLDivElement>(null);
  const previousSelectionCount = useRef(0);
  useEffect(() => {
    setSelectedIds([]);
    setPopulation("hot");
    setFocusedLapId(null);
    setSelectedCompound("all");
    setShowP50(true);
    setShowP95(true);
  }, [gameId, sessionId]);
  const stints = query.data?.stints ?? [];
  const laps = lapQuery.data?.laps ?? [];
  const coldData = (stint: StintSummary) => stint.coldRateStatistics?.p50 != null || stint.coldRateStatistics?.p95 != null ||
    stint.coldTireRateStatistics?.some((stats) => stats.p50 != null || stats.p95 != null) === true;
  const hasCold = stints.some(coldData);
  const hasColdLaps = laps.some((lap) => lap.thermalState === "cold");
  const compounds = [...new Set(laps.flatMap((lap) => lap.tires.map((tire) => tire.compound)))];
  const hasCompoundFilter = compounds.length > 1;
  useEffect(() => {
    const focused = laps.find((lap) => lap.lapId === focusedLapId);
    const excludedThermal = focused != null && (population === "cold" ? focused.thermalState !== "cold" : focused.thermalState === "cold");
    const visibleMeasurements = focused == null ? [] : [focused.fuel, ...focused.tires.filter((tire) =>
      selectedCompound === "all" || (selectedCompound === "unknown" ? tire.compound == null : tire.compound === selectedCompound))];
    const hasVisibleMeasurement = visibleMeasurements.some((measurement) => measurement.value != null && Number.isFinite(measurement.value));
    if (focusedLapId != null && (!focused || excludedThermal || !hasVisibleMeasurement)) setFocusedLapId(null);
    if (!compounds.includes(selectedCompound === "unknown" ? null : selectedCompound)) setSelectedCompound("all");
  }, [hasColdLaps, focusedLapId, laps, compounds, selectedCompound, population]);
  const statsText = (rate: MetricRate, stats: Statistics | undefined) => stats == null ? "—" :
    `${m.strategy_percentile_p50()} ${stats.p50 == null ? "—" : rateValue({ ...rate, value: stats.p50 })} · ${m.strategy_percentile_p95()} ${stats.p95 == null ? "—" : rateValue({ ...rate, value: stats.p95 })}`;
  const statsRate = (rate: MetricRate, stats: Statistics | undefined): MetricRate => ({ ...rate, value: stats?.p50 ?? null });
  const rateReason = (rate: MetricRate, stint: StintSummary) =>
    rate.value == null && stint.status !== "active" && rate.unavailableReason === "no-current-samples"
      ? m.strategy_reason_missing()
      : rateValue(rate);
  const hasEvidence = (stint: StintSummary) => stint.fuel.eligibleLaps + stint.tires.reduce((sum, rate) => sum + rate.eligibleLaps, 0) > 0 || coldData(stint);
  const focusedLap = laps.find((lap) => lap.lapId === focusedLapId);
  const readoutMetrics: Array<{ label: string; metric: StintMetric }> = [
    { label: m.strategy_fuel_rate(), metric: "fuel" },
    ...wheels.map((wheel, index) => ({ label: wheel, metric: index })),
  ];
  const percentileText = (measurement: StrategyLapMetric["fuel"] | StrategyLapMetric["tires"][number]) => measurement.value == null
    ? reasonText(measurement.unavailableReason)
    : rateValue({ value: measurement.value, unit: measurement.unit, eligibleLaps: 1, source: "current-stint", provisional: false, unavailableReason: null });
  const selected = stints.filter((stint) => selectedIds.includes(stint.id));
  const setSelected = (id: string, checked: boolean) => setSelectedIds((ids) => checked ? [...ids, id] : ids.filter((item) => item !== id));
  useEffect(() => {
    if (selected.length === 2 && previousSelectionCount.current < 2) {
      comparisonRef.current?.focus();
      comparisonRef.current?.scrollIntoView({ block: "nearest" });
    }
    previousSelectionCount.current = selected.length;
  }, [selected.length]);
  const piRequired = gameId === "fm-2023";
  const metrics: Array<{ label: string; first: ReactNode; second: ReactNode; diff: string }> = selected.length === 2 ? (() => {
    const [a, b] = selected as [StintSummary, StintSummary];
    const rows: Array<{ label: string; first: ReactNode; second: ReactNode; diff: string }> = [];
    const addRate = (label: string, left: MetricRate, right: MetricRate, leftStats: Statistics | undefined, rightStats: Statistics | undefined, metric: "fuel" | number) => {
      const compatible = compatibleMetric(a, b, metric, piRequired);
      rows.push({ label, first: statsText(left, leftStats), second: statsText(right, rightStats), diff: difference(statsRate(left, leftStats), statsRate(right, rightStats), compatible, m) });
    };
    addRate(m.strategy_fuel_rate(), a.fuel, b.fuel, a.rateStatistics?.fuel, b.rateStatistics?.fuel, "fuel");
    a.tires.forEach((rate, i) => addRate(wheels[i]!, rate, b.tires[i]!, a.rateStatistics?.tires[i], b.rateStatistics?.tires[i], i));
    if (coldData(a) && coldData(b)) {
      addRate(m.strategy_cold_fuel(), a.fuel, b.fuel, a.coldRateStatistics, b.coldRateStatistics, "fuel");
      a.tires.forEach((rate, i) => addRate(`${wheels[i]} · ${m.strategy_cold_wear()}`, rate, b.tires[i]!, a.coldTireRateStatistics?.[i], b.coldTireRateStatistics?.[i], i));
    }
    rows.push({ label: m.strategy_completed_laps({ count: "" }), first: String(a.completedLaps), second: String(b.completedLaps), diff: "—" });
    const measured = (stint: StintSummary) => `${strategyFuelUsedText(stint.measuredFuelUsed, stint.fuelUnit)} · ${stint.fuelCoverage === "complete" ? m.strategy_coverage_complete() : stint.fuelCoverage === "partial" ? m.strategy_coverage_partial() : m.strategy_coverage_unavailable()}`;
    rows.push({ label: m.strategy_fuel_coverage(), first: measured(a), second: measured(b), diff: "—" });
    rows.push({ label: m.strategy_average_lap(), first: a.averageLapSeconds == null ? m.strategy_unavailable() : `${a.averageLapSeconds.toFixed(2)}s`, second: b.averageLapSeconds == null ? m.strategy_unavailable() : `${b.averageLapSeconds.toFixed(2)}s`, diff: a.averageLapSeconds == null || b.averageLapSeconds == null ? m.strategy_missing_difference() : `${b.averageLapSeconds - a.averageLapSeconds > 0 ? "+" : ""}${(b.averageLapSeconds - a.averageLapSeconds).toFixed(2)}s` });
    rows.push({ label: m.strategy_setup(), first: a.compatibility.setupKey ?? m.strategy_unknown(), second: b.compatibility.setupKey ?? m.strategy_unknown(), diff: a.compatibility.setupKey == null && b.compatibility.setupKey == null ? m.strategy_setup_uncertain() : "—" });
    rows.push({ label: m.cars_pi(), first: a.pi == null ? m.strategy_unknown() : String(a.pi), second: b.pi == null ? m.strategy_unknown() : String(b.pi), diff: piRequired && (a.pi == null || b.pi == null || a.pi !== b.pi) ? m.strategy_not_comparable() : "—" });
    rows.push({ label: m.strategy_compounds(), first: a.compounds.map((value, i) => `${wheels[i]} ${value ?? m.strategy_unknown()}`).join(" · "), second: b.compounds.map((value, i) => `${wheels[i]} ${value ?? m.strategy_unknown()}`).join(" · "), diff: "—" });
    rows.push({ label: m.strategy_conditions(), first: [a.compatibility.conditions.weather ?? m.strategy_unknown(), a.compatibility.conditions.airTemperatureC == null ? m.strategy_unknown() : `${a.compatibility.conditions.airTemperatureC} °C`, a.compatibility.conditions.trackTemperatureC == null ? m.strategy_unknown() : `${a.compatibility.conditions.trackTemperatureC} °C`].join(" · "), second: [b.compatibility.conditions.weather ?? m.strategy_unknown(), b.compatibility.conditions.airTemperatureC == null ? m.strategy_unknown() : `${b.compatibility.conditions.airTemperatureC} °C`, b.compatibility.conditions.trackTemperatureC == null ? m.strategy_unknown() : `${b.compatibility.conditions.trackTemperatureC} °C`].join(" · "), diff: "—" });
    for (const [label, left, right] of [
      [`${m.strategy_fuel_rate()} · ${m.strategy_eligible_laps({ count: "" })}`, a.fuel.eligibleLaps, b.fuel.eligibleLaps],
      ...wheels.map((wheel, index) => [`${wheel} · ${m.strategy_eligible_laps({ count: "" })}`, a.tires[index]!.eligibleLaps, b.tires[index]!.eligibleLaps]),
      [m.strategy_pace_laps({ count: "" }), a.paceLaps, b.paceLaps],
    ] as Array<[string, number, number]>) rows.push({ label, first: String(left), second: String(right), diff: "—" });
    return rows;
  })() : [];
  return <section data-testid="stint-analysis" aria-labelledby="stint-analysis-title" className="border-t border-app-border p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="stint-analysis-title" className="text-sm font-semibold text-app-text">{m.strategy_title()}</h2>
      <Link className="rounded bg-app-accent px-3 py-2 text-sm text-app-on-filled focus-visible:outline-2 focus-visible:outline-app-accent" to="/$gameid/strategy" params={{ gameid: getGame(gameId).routePrefix }} search={{ sessionId }}>{m.race_plan_generate()}</Link>
    </div>

    {query.isLoading && <p role="status">{m.common_loading()}</p>}
    {query.isError && <div role="alert" className="text-status-danger">{m.common_error()}: {m.strategy_stints_error()} <button type="button" className="underline" onClick={() => void query.refetch()}>{m.strategy_retry()}</button></div>}
    {!query.isLoading && !query.isError && stints.length === 0 && <p role="status" className="text-sm text-app-text-muted">{m.strategy_stints_empty()}</p>}
    {stints.length > 0 && <div data-testid="stint-summary-chart" role="region" aria-label={m.strategy_chart_label()} className="min-w-0 space-y-4 rounded-lg border border-app-border bg-app-surface/40 p-4">
      {hasColdLaps && <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-app-border/60 pb-3">
        <p className="max-w-prose text-xs text-app-text-muted">{m.strategy_cold_help()}</p>
        <div role="group" aria-label={m.strategy_population_label()} className="inline-flex shrink-0 rounded-md border border-app-border bg-app-surface p-0.5">
          <button type="button" aria-pressed={population === "hot"} onClick={() => setPopulation("hot")} className={`min-h-10 rounded px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent ${population === "hot" ? "bg-app-accent text-app-on-filled" : "text-app-text-muted hover:text-app-text"}`}>{m.strategy_population_hot()}</button>
          <button type="button" aria-pressed={population === "cold"} onClick={() => setPopulation("cold")} className={`min-h-10 rounded px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent ${population === "cold" ? "bg-app-accent text-app-on-filled" : "text-app-text-muted hover:text-app-text"}`}>{m.strategy_population_cold()}</button>
        </div>
      </div>}
      <div role="group" aria-label={m.strategy_chart_heading()} className="flex flex-wrap items-center gap-3 text-xs text-app-text-muted">
        <label className="inline-flex min-h-10 items-center gap-2"><input type="checkbox" checked={showP50} onChange={(event) => setShowP50(event.target.checked)} />{m.strategy_percentile_p50()}</label>
        <label className="inline-flex min-h-10 items-center gap-2"><input type="checkbox" checked={showP95} onChange={(event) => setShowP95(event.target.checked)} />{m.strategy_percentile_p95()}</label>
        {hasCompoundFilter && <label className="inline-flex min-h-10 items-center gap-2">{m.strategy_compounds()}
          <select aria-label={m.strategy_compounds()} value={selectedCompound} onChange={(event) => setSelectedCompound(event.target.value)} className="min-h-10 rounded border border-app-border bg-app-surface px-2 text-app-text">
            <option value="all">{m.strategy_filter_all()}</option>
            {compounds.includes(null) && <option value="unknown">{m.strategy_unknown()}</option>}
            {compounds.filter((compound): compound is string => compound != null).sort().map((compound) => <option key={compound} value={compound}>{compound}</option>)}
          </select>
        </label>}
      </div>
      {lapQuery.isError ? <div role="alert" className="text-status-danger">{m.common_error()}: {m.strategy_stints_error()} <button type="button" className="underline" onClick={() => void lapQuery.refetch()}>{m.strategy_retry()}</button></div>
        : query.isLoading || lapQuery.isLoading ? <p role="status">{m.common_loading()}</p>
        : <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-flow-dense xl:grid-cols-2 xl:grid-rows-2">
          <div className="min-w-0 xl:row-span-2"><StintDumbbellChart stints={stints} laps={laps} metric="fuel" population={population} selectedCompound={selectedCompound} showP50={showP50} showP95={showP95} focusedLapId={focusedLap?.lapId ?? null} onFocusLap={setFocusedLapId} /></div>
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:col-start-2 xl:row-span-2">
            {wheels.map((wheel, index) => <div key={wheel} className="min-w-0"><StintDumbbellChart stints={stints} laps={laps} metric={index} population={population} selectedCompound={selectedCompound} showP50={showP50} showP95={showP95} focusedLapId={focusedLap?.lapId ?? null} onFocusLap={setFocusedLapId} /></div>)}
          </div>
        </div>}
      {focusedLap ? <div className="min-w-0 space-y-2 border-t border-app-border/60 pt-3">
        <h3 className="text-xs font-semibold text-app-text">{m.strategy_stint({ ordinal: focusedLap.stintOrdinal })} · {m.strategy_lap_number({ lap: focusedLap.lapNumber })} · {m.strategy_driver({ driver: focusedLap.driverKey === "local-player" ? m.strategy_local_player() : focusedLap.driverKey })} · {m.strategy_population_label()}: {focusedLap.thermalState === "cold" ? m.strategy_population_cold() : focusedLap.thermalState === "warm" ? m.strategy_population_hot() : m.strategy_unavailable()}</h3>
        <div role="region" aria-label={m.strategy_chart_heading()} tabIndex={0} className="min-w-0 overflow-x-auto rounded border border-app-border">
          <table data-testid="stint-lap-readout" className="min-w-[38rem] w-full text-left text-xs tabular-nums">
            <caption className="sr-only">{m.strategy_chart_heading()}</caption>
            <thead><tr className="border-b border-app-border bg-app-surface-alt text-app-text-muted"><th scope="col" className="px-3 py-2">{m.strategy_metric()}</th><th scope="col" className="px-3 py-2">{m.strategy_value()}</th><th scope="col" className="px-3 py-2">{m.strategy_compounds()}</th></tr></thead>
            <tbody>{readoutMetrics.map(({ label, metric }) => {
              const measurement = metric === "fuel" ? focusedLap.fuel : focusedLap.tires[metric]!;
              return <tr key={label} className="border-b border-app-border/60 last:border-0"><th scope="row" className="px-3 py-2 font-medium">{label}</th><td className="px-3 py-2 font-mono">{percentileText(measurement)}</td><td className="px-3 py-2">{metric === "fuel" ? "—" : focusedLap.tires[metric]!.compound ?? m.strategy_unknown()}</td></tr>;
            })}</tbody>
          </table>
        </div>
      </div> : <p role="status" className="border-t border-app-border/60 pt-3 text-xs text-app-text-muted">{m.strategy_lap_select_guidance()}</p>}
    </div>}
    {stints.length > 1 && <div className="flex items-center gap-3 text-sm text-app-text-muted"><span role="status">{selected.length}/2 · {m.strategy_compare()}</span>{selected.length === 2 && <button type="button" className="underline focus-visible:outline-2 focus-visible:outline-app-accent" onClick={() => { comparisonRef.current?.focus(); comparisonRef.current?.scrollIntoView({ block: "nearest" }); }}>{m.strategy_view_comparison()}</button>}</div>}
    {selected.length === 2 && <p className="text-app-text-muted">{m.strategy_conditions()}</p>}
    {selected.length === 2 && <p id="stint-selection-limit" className="text-app-text-muted">{m.strategy_remove_first()}</p>}
    {selected.length === 2 && <div ref={comparisonRef} id="stint-comparison" data-testid="stint-comparison" role="region" aria-label={m.strategy_compare()} tabIndex={-1} aria-live="polite" className="overflow-x-auto rounded border border-app-border p-3 text-xs">
      {selected.length === 2 && <div className="space-y-2"><h3 className="font-semibold">{m.strategy_comparison_heading({ first: selected[0]!.ordinal, second: selected[1]!.ordinal })}</h3><table className="min-w-[40rem] w-full text-left"><thead><tr><th scope="col">{m.strategy_metric()}</th><th scope="col">{m.strategy_stint({ ordinal: selected[0]!.ordinal })}</th><th scope="col">{m.strategy_stint({ ordinal: selected[1]!.ordinal })}</th><th scope="col">{m.strategy_difference()}</th></tr></thead><tbody>{metrics.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.first}</td><td>{row.second}</td><td>{row.diff}</td></tr>)}</tbody></table><p>{m.strategy_conditions()}</p><Link className="underline" to="/$gameid/sessions/$sessionId/analyse" params={{ gameid: getGame(gameId).routePrefix, sessionId: String(selected[0]!.sessionId) }} search={true} hash={`stint-${encodeURIComponent(selected[0]!.id)}`}>{m.strategy_evidence_link({ session: selected[0]!.sessionId, stint: selected[0]!.id })}</Link></div>}
    </div>}
    {stints.length > 0 && <div data-testid="stint-summary-cards" role="region" aria-label={m.strategy_stint_summary_label()} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      {[...stints].sort((a, b) => Number(hasEvidence(b)) - Number(hasEvidence(a))).map((stint) => {
        const evidence = hasEvidence(stint);
        const metricRows = <div className="mt-4 grid min-w-0 grid-cols-1 gap-3">
          <section className="min-w-0" title={rateReason(stint.fuel, stint)}>
            <h4 className="text-xs font-semibold text-app-text-muted">{m.strategy_fuel_rate()} · {m.strategy_sample_laps({ count: stint.fuel.eligibleLaps })}</h4>
            <p className="mt-1 break-words font-mono text-sm text-app-text">{statsText(stint.fuel, stint.rateStatistics?.fuel)}</p>
          </section>
          <section className="grid min-w-0 grid-cols-2 gap-3">
            {stint.tires.map((rate, index) => <div key={wheels[index]} className="min-w-0" title={rateReason(rate, stint)}>
              <h4 className="text-xs font-semibold text-app-text-muted">{wheels[index]} · {stint.compounds[index] ?? m.strategy_unknown()} · {m.strategy_sample_laps({ count: rate.eligibleLaps })}</h4>
              <p className="mt-1 break-words font-mono text-sm text-app-text">{statsText(rate, stint.rateStatistics?.tires[index])}</p>
            </div>)}
          </section>
        </div>;
        const audit = <div className="min-w-0 space-y-2 pt-3 break-words">
          {hasCold && <><p>{m.strategy_cold_fuel()}: {statsText(stint.fuel, stint.coldRateStatistics)} · {m.strategy_sample_laps({ count: stint.coldLaps ?? 0 })}</p>
            {stint.tires.map((rate, index) => <p key={wheels[index]}>{m.strategy_cold_wear()} · {wheels[index]} · {stint.compounds[index] ?? m.strategy_unknown()}: {statsText(rate, stint.coldTireRateStatistics?.[index])}</p>)}</>}
          <p>{m.strategy_fuel_rate()}: {rateReason(stint.fuel, stint)} · {m.strategy_eligible_laps({ count: stint.fuel.eligibleLaps })}</p>
          {stint.tires.map((rate, index) => <p key={wheels[index]}>{wheels[index]} · {stint.compounds[index] ?? m.strategy_unknown()} · {rateReason(rate, stint)} · {m.strategy_eligible_laps({ count: rate.eligibleLaps })}</p>)}
          <p>{m.strategy_fuel_coverage()}: {stint.measuredFuelUsed == null ? "—" : strategyFuelUsedText(stint.measuredFuelUsed, stint.fuelUnit)} · {stint.fuelCoverage === "complete" ? m.strategy_coverage_complete() : stint.fuelCoverage === "partial" ? m.strategy_coverage_partial() : m.strategy_coverage_unavailable()}</p>
          <p>{m.strategy_average_lap()}: {stint.averageLapSeconds == null ? "—" : `${stint.averageLapSeconds.toFixed(2)}s`}</p>
          <p>{m.strategy_driver({ driver: stint.driverKey === "local-player" ? m.strategy_local_player() : stint.driverKey })}</p>
          <p>{m.strategy_completed_laps({ count: stint.completedLaps })} · {m.strategy_pace_laps({ count: stint.paceLaps })}</p>
          <p>{stint.boundary.confidence === "observed" ? m.strategy_confidence_observed() : stint.boundary.confidence === "inferred" ? m.strategy_confidence_inferred() : m.strategy_confidence_unknown()} · {reasonText(stint.boundary.reason)}</p>
          <p>{m.strategy_exclusions({ count: stint.exclusions.reduce((sum, item) => sum + item.count, 0) })}</p>
          {stint.exclusions.map((item) => <p key={item.reason}>{reasonText(item.reason)}: {item.count}</p>)}
        </div>;
        return <article id={`stint-${stint.id}`} key={stint.id} className="min-w-0 rounded-lg border border-app-border bg-app-surface/40 p-4">
        <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold text-app-text">{m.strategy_stint({ ordinal: stint.ordinal })}</h3>
            <p className="text-sm text-app-text-muted">{m.strategy_stint_laps()}: {stint.firstLapNumber == null ? "—" : `${stint.firstLapNumber}–${stint.lastLapNumber ?? "?"}`} · {stint.status === "active" ? m.strategy_status_active() : stint.status === "completed" ? m.strategy_status_completed() : m.strategy_status_interrupted()}</p>
          {stints.length > 1 && <label className="flex items-center gap-2 text-sm text-app-text">
            <input type="checkbox" checked={selectedIds.includes(stint.id)} disabled={!selectedIds.includes(stint.id) && selected.length === 2} aria-label={m.strategy_compare_stint({ ordinal: stint.ordinal })} aria-describedby={!selectedIds.includes(stint.id) && selected.length === 2 ? "stint-selection-limit" : undefined} onChange={(event) => setSelected(stint.id, event.target.checked)} className="accent-app-accent focus-visible:outline-2 focus-visible:outline-app-accent" />
            {m.strategy_compare()}
          </label>}
          </div>
          {selected.length === 2 && selectedIds.includes(stint.id) && <button type="button" className="text-sm underline focus-visible:outline-2 focus-visible:outline-app-accent" onClick={() => { comparisonRef.current?.focus(); comparisonRef.current?.scrollIntoView({ block: "nearest" }); }}>{m.strategy_view_comparison()}</button>}
        </header>
        {evidence ? <>{metricRows}<details className="mt-4 border-t border-app-border/60 pt-3 text-sm text-app-text-muted">
          <summary className="cursor-pointer text-app-text focus-visible:outline-2 focus-visible:outline-app-accent">{m.strategy_stint_details()}</summary>{audit}
        </details></> : <details className="mt-4 border-t border-app-border/60 pt-3 text-sm text-app-text-muted">
          <summary className="cursor-pointer text-app-text focus-visible:outline-2 focus-visible:outline-app-accent">{m.strategy_stint_details()}</summary>{metricRows}{audit}
        </details>}
      </article>;
      })}
    </div>}
  </section>;
}
