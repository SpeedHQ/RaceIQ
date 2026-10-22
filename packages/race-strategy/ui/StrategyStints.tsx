import { getGame } from "@raceiq/shared/games/registry";
import type { ReactNode } from "react";
import { useRaceStrategyHost } from "./host";
import type { RaceStrategyMessages } from "../contracts";
import { useEffect, useState } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { MetricRate, StintSummary } from "@raceiq/shared/racing/live/strategy";
import { useStrategyStints } from "./stint-strategy";
import { useStrategyFormat } from "./strategy-format";

const wheels = ["FL", "FR", "RL", "RR"] as const;
function compatibleMetric(a: StintSummary, b: StintSummary, metric: "fuel" | number, piRequired: boolean) {
  if (a.gameId !== b.gameId || a.driverKey !== b.driverKey || a.carId !== b.carId || a.trackId !== b.trackId ||
    a.compatibility.setupKey !== b.compatibility.setupKey || piRequired && (a.pi == null || b.pi == null || a.pi !== b.pi)) return false;
  if (metric === "fuel") return a.fuelUnit === b.fuelUnit && a.compatibility.fuelSemanticVersion != null && a.compatibility.fuelSemanticVersion === b.compatibility.fuelSemanticVersion;
  return a.compounds[metric] === b.compounds[metric] && a.compatibility.tireSemanticVersions[metric] != null && a.compatibility.tireSemanticVersions[metric] === b.compatibility.tireSemanticVersions[metric];
}
function RateChart({ stints, metric }: { stints: StintSummary[]; metric: "fuel" | number }) {
  const { m } = useRaceStrategyHost();
  const { strategyRateText: rateValue } = useStrategyFormat();
  const entries = stints.map((stint) => {
    const rate = metric === "fuel" ? stint.fuel : stint.tires[metric];
    const semantic = metric === "fuel" ? stint.compatibility.fuelSemanticVersion : stint.compatibility.tireSemanticVersions[metric];
    const compound = metric === "fuel" ? "" : stint.compounds[metric] ?? m.strategy_unknown();
    const piContext = stint.gameId === "fm-2023" ? stint.pi ?? `unknown:${stint.id}` : "not-required";
    const context = [stint.gameId, stint.trackId, stint.carId, stint.driverKey, rate.unit, semantic ?? `unknown:${stint.id}`, stint.compatibility.setupKey ?? "unknown", piContext, compound].join("|");
    const unit = (rate.unit === "L/lap" ? m.strategy_rate_litres({ value: "" }) : m.strategy_rate_points({ value: "" })).trim();
    return { stint, rate, context, label: `${unit} · ${semantic ?? m.strategy_unknown()} · ${stint.compatibility.setupKey ?? m.strategy_setup_uncertain()}${stint.gameId === "fm-2023" ? ` · ${m.cars_pi()} ${stint.pi ?? m.strategy_unknown()}` : ""}${metric === "fuel" ? "" : ` · ${wheels[metric]} ${compound}`}` };
  });
  const contexts = [...new Set(entries.map((entry) => entry.context))];
  return <div className="space-y-2">{contexts.map((context) => {
    const group = entries.filter((entry) => entry.context === context);
    const max = Math.max(...group.map(({ rate }) => rate.value ?? 0), Number.EPSILON);
    return <div key={context} role="group" aria-label={group[0]!.label} className="space-y-1"><p className="text-xs text-app-text-muted">{group[0]!.label}</p>
      {group.map(({ stint, rate }) => <div key={stint.id} className="grid grid-cols-[5rem_1fr_auto] items-center gap-2 text-xs">
        <span>{m.strategy_stint({ ordinal: stint.ordinal })}</span>
        <div role="img" aria-label={m.strategy_rate_for_stint({ rate: rateValue(rate), ordinal: stint.ordinal })} className="h-2 rounded bg-app-border"><div className="h-full rounded bg-app-accent" style={{ width: rate.value == null ? "0%" : `${Math.max(0, Math.min(100, rate.value / max * 100))}%` }} /></div>
        <span className="font-mono">{rateValue(rate)}</span>
      </div>)}
    </div>;
  })}</div>;
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
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  useEffect(() => setSelectedIds([]), [gameId, sessionId]);
  const stints = query.data?.stints ?? [];
  const selected = stints.filter((stint) => selectedIds.includes(stint.id));
  const setSelected = (id: string, checked: boolean) => setSelectedIds((ids) => checked ? [...ids, id] : ids.filter((item) => item !== id));
  const piRequired = gameId === "fm-2023";
  const metrics: Array<{ label: string; first: ReactNode; second: ReactNode; diff: string }> = selected.length === 2 ? (() => {
    const [a, b] = selected as [StintSummary, StintSummary];
    const rows: Array<{ label: string; first: ReactNode; second: ReactNode; diff: string }> = [];
    const addRate = (label: string, left: MetricRate, right: MetricRate, metric: "fuel" | number) => {
      const compatible = compatibleMetric(a, b, metric, piRequired);
      rows.push({ label, first: rateValue(left), second: rateValue(right), diff: difference(left, right, compatible, m) });
    };
    addRate(m.strategy_fuel_rate(), a.fuel, b.fuel, "fuel");
    a.tires.forEach((rate, i) => addRate(wheels[i]!, rate, b.tires[i]!, i));
    rows.push({ label: m.strategy_completed_laps({ count: "" }), first: String(a.completedLaps), second: String(b.completedLaps), diff: "—" });
    const measured = (stint: StintSummary) => `${strategyFuelUsedText(stint.measuredFuelUsed, stint.fuelUnit)} · ${stint.fuelCoverage === "complete" ? m.strategy_coverage_complete() : stint.fuelCoverage === "partial" ? m.strategy_coverage_partial() : m.strategy_coverage_unavailable()}`;
    rows.push({ label: m.strategy_fuel_coverage(), first: measured(a), second: measured(b), diff: "—" });
    rows.push({ label: m.strategy_average_lap(), first: a.averageLapSeconds == null ? m.strategy_unavailable() : `${a.averageLapSeconds.toFixed(2)}s`, second: b.averageLapSeconds == null ? m.strategy_unavailable() : `${b.averageLapSeconds.toFixed(2)}s`, diff: a.averageLapSeconds == null || b.averageLapSeconds == null ? m.strategy_missing_difference() : `${b.averageLapSeconds - a.averageLapSeconds > 0 ? "+" : ""}${(b.averageLapSeconds - a.averageLapSeconds).toFixed(2)}s` });
    rows.push({ label: m.strategy_setup(), first: a.compatibility.setupKey ?? m.strategy_unknown(), second: b.compatibility.setupKey ?? m.strategy_unknown(), diff: a.compatibility.setupKey == null && b.compatibility.setupKey == null ? m.strategy_setup_uncertain() : "—" });
    rows.push({ label: m.cars_pi(), first: a.pi == null ? m.strategy_unknown() : String(a.pi), second: b.pi == null ? m.strategy_unknown() : String(b.pi), diff: piRequired && (a.pi == null || b.pi == null || a.pi !== b.pi) ? m.strategy_not_comparable() : "—" });
    rows.push({ label: m.strategy_fuel_semantics(), first: a.compatibility.fuelSemanticVersion ?? m.strategy_unknown(), second: b.compatibility.fuelSemanticVersion ?? m.strategy_unknown(), diff: "—" });
    rows.push({ label: m.strategy_tire_semantics(), first: a.compatibility.tireSemanticVersions.map((value, i) => `${wheels[i]} ${value ?? m.strategy_unknown()}`).join(" · "), second: b.compatibility.tireSemanticVersions.map((value, i) => `${wheels[i]} ${value ?? m.strategy_unknown()}`).join(" · "), diff: "—" });
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
      <a className="rounded bg-app-accent px-3 py-2 text-sm text-app-on-filled focus-visible:outline-2 focus-visible:outline-app-accent" href={`/${getGame(gameId).routePrefix}/strategy?sessionId=${sessionId}`}>{m.race_plan_generate()}</a>
    </div>
    {query.isLoading && <p role="status">{m.common_loading()}</p>}
    {query.isError && <div role="alert" className="text-status-danger">{m.common_error()}: {m.strategy_stints_error()} <button type="button" className="underline" onClick={() => void query.refetch()}>{m.strategy_retry()}</button></div>}
    {!query.isLoading && !query.isError && stints.length === 0 && <p role="status" className="text-sm text-app-text-muted">{m.strategy_stints_empty()}</p>}
    {stints.length > 0 && <div role="region" aria-label={m.strategy_table_caption()} tabIndex={0} className="overflow-x-auto"><table data-testid="stint-summary-table" className="min-w-[70rem] w-full border-collapse text-left text-xs">
      <caption className="sr-only">{m.strategy_table_caption()}</caption>
      <thead><tr className="border-b border-app-border text-app-text-muted">{stints.length > 1 && <th scope="col" className="p-2">{m.strategy_compare()}</th>}<th scope="col" className="p-2">{m.strategy_stint_laps()}</th><th scope="col" className="p-2">{m.strategy_status_boundary()}</th><th scope="col" className="p-2">{m.strategy_fuel_rate()}</th><th scope="col" className="p-2">{m.strategy_wheel_rates()}</th><th scope="col" className="p-2">{m.strategy_fuel_coverage()}</th><th scope="col" className="p-2">{m.strategy_average_lap()}</th><th scope="col" className="p-2">{m.strategy_compounds_exclusions()}</th></tr></thead>
      <tbody>{stints.map((stint) => <tr id={`stint-${stint.id}`} key={stint.id} className="border-b border-app-border/60 align-top">
        {stints.length > 1 && <td className="p-2"><input aria-label={m.strategy_compare_stint({ ordinal: stint.ordinal })} type="checkbox" checked={selectedIds.includes(stint.id)} disabled={!selectedIds.includes(stint.id) && selected.length === 2} aria-describedby={!selectedIds.includes(stint.id) && selected.length === 2 ? "stint-selection-limit" : undefined} onChange={(event) => setSelected(stint.id, event.target.checked)} /></td>}
        <th scope="row" className="p-2 font-mono">{stint.ordinal} · {stint.firstLapNumber ?? "?"}–{stint.lastLapNumber ?? "?"}<small className="block text-app-text-muted">{m.strategy_driver({ driver: stint.driverKey === "local-player" ? m.strategy_local_player() : stint.driverKey })}</small><small className="block text-app-text-muted">{m.strategy_completed_laps({ count: stint.completedLaps })} · {m.strategy_eligible_laps({ count: stint.fuel.eligibleLaps })} · {stint.tires.map((rate, index) => `${wheels[index]} ${rate.eligibleLaps}`).join(" · ")}</small></th>
        <td className="p-2">{stint.status === "active" ? m.strategy_status_active() : stint.status === "completed" ? m.strategy_status_completed() : m.strategy_status_interrupted()} · {stint.boundary.confidence === "observed" ? m.strategy_confidence_observed() : stint.boundary.confidence === "inferred" ? m.strategy_confidence_inferred() : m.strategy_confidence_unknown()}<small className="block text-app-text-muted">{reasonText(stint.boundary.reason)}</small></td>
        <td className="p-2">{rateValue(stint.fuel)}<small className="block text-app-text-muted">{m.strategy_eligible_laps({ count: stint.fuel.eligibleLaps })}</small></td>
        <td className="p-2">{stint.tires.map((rate, index) => <span key={wheels[index]} className="block">{wheels[index]} {rateValue(rate)} · {stint.compounds[index] ?? m.strategy_unknown()} · {m.strategy_eligible_laps({ count: rate.eligibleLaps })}</span>)}</td>
        <td className="p-2">{strategyFuelUsedText(stint.measuredFuelUsed, stint.fuelUnit)} · {stint.fuelCoverage === "complete" ? m.strategy_coverage_complete() : stint.fuelCoverage === "partial" ? m.strategy_coverage_partial() : m.strategy_coverage_unavailable()}</td>
        <td className="p-2">{stint.averageLapSeconds == null ? m.strategy_unavailable() : `${stint.averageLapSeconds.toFixed(2)}s`} · {m.strategy_pace_laps({ count: stint.paceLaps })}</td>
        <td className="p-2">{stint.compounds.map((compound, index) => `${wheels[index]} ${compound ?? m.strategy_unknown()}`).join(" · ")}<details><summary>{m.strategy_exclusions({ count: stint.exclusions.reduce((sum, item) => sum + item.count, 0) })}</summary>{stint.exclusions.map((item) => <p key={item.reason}>{reasonText(item.reason)}: {item.count}</p>)}</details></td>
      </tr>)}</tbody>
    </table></div>}
    {stints.length > 0 && <div data-testid="stint-summary-chart" aria-label={m.strategy_chart_label()} className="space-y-2 rounded border border-app-border p-3">
      <h3 className="text-xs font-semibold">{m.strategy_chart_heading()}</h3>
      <fieldset className="space-y-1"><legend className="text-xs font-medium">{m.strategy_fuel_rate()}</legend><RateChart stints={stints} metric="fuel" /></fieldset>
      <div className="grid gap-2 sm:grid-cols-2">{wheels.map((wheel, index) => <fieldset key={wheel} className="space-y-1"><legend className="text-xs font-medium">{m.strategy_wheel_rate({ wheel })}</legend><RateChart stints={stints} metric={index} /></fieldset>)}</div>
    </div>}
    {selected.length === 2 && <p className="text-app-text-muted">{m.strategy_conditions()}</p>}
    {selected.length === 2 && <p id="stint-selection-limit" className="text-app-text-muted">{m.strategy_remove_first()}</p>}
    {selected.length === 2 && <div data-testid="stint-comparison" role="region" aria-label={m.strategy_compare()} tabIndex={0} aria-live="polite" className="overflow-x-auto rounded border border-app-border p-3 text-xs">
      {selected.length === 2 && <div className="space-y-2"><h3 className="font-semibold">{m.strategy_comparison_heading({ first: selected[0]!.ordinal, second: selected[1]!.ordinal })}</h3><table className="min-w-[40rem] w-full text-left"><thead><tr><th scope="col">{m.strategy_metric()}</th><th scope="col">{m.strategy_stint({ ordinal: selected[0]!.ordinal })}</th><th scope="col">{m.strategy_stint({ ordinal: selected[1]!.ordinal })}</th><th scope="col">{m.strategy_difference()}</th></tr></thead><tbody>{metrics.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.first}</td><td>{row.second}</td><td>{row.diff}</td></tr>)}</tbody></table><p>{m.strategy_conditions()}</p><a className="underline" href={`/${getGame(gameId).routePrefix}/sessions/${selected[0]!.sessionId}/analyse`}>{m.strategy_evidence_link({ session: selected[0]!.sessionId, stint: selected[0]!.id })}</a></div>}
    </div>}
  </section>;
}
