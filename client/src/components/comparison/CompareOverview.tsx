import { Fragment, useMemo, type ReactNode } from "react";
import { CircleGauge, Fuel, Thermometer, Timer, Zap } from "lucide-react";
import type { ComparisonData } from "@raceiq/shared/racing/comparison/types";
import { getGame } from "@raceiq/shared/games/registry";
import { getFuelAmount } from "@raceiq/shared/games/telemetry";
import { useCompareLineSpread, useLapSemanticTelemetry } from "@/hooks/laps";
import { useUnits } from "@/hooks/useUnits";
import { summarizeLapOverview } from "@/lib/lap-overview";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import { LoadingIndicator } from "@/components/LoadingIndicator";
import { useRequiredGameId } from "@/stores/game";
import { severityRangeColor } from "@raceiq/scene-3d/colors";

type StatRow = { label: string; a: string | null; b: string | null; winner?: "a" | "b" | null };

function winner(a: number | null, b: number | null, lower: boolean): "a" | "b" | null {
  if (a === null || b === null || a === b) return null;
  return (lower ? a < b : a > b) ? "a" : "b";
}

function comparisonColor(best: "a" | "b" | null | undefined, side: "a" | "b") {
  return best == null ? undefined : best === side ? "var(--status-success)" : "var(--status-danger)";
}

/** Whole-recording summaries stay independent of chart zoom and replay cursor. */
export function CompareOverview({ comparison, pickerA, pickerB, selectionStatus }: { comparison: ComparisonData | undefined; pickerA: ReactNode; pickerB: ReactNode; selectionStatus: ReactNode }) {
  const replayA = useLapSemanticTelemetry(comparison?.lapA.id ?? null);
  const replayB = useLapSemanticTelemetry(comparison?.lapB.id ?? null);
  const gameId = useRequiredGameId();
  const lineSpread = useCompareLineSpread(gameId, comparison ? [comparison.lapA.id, comparison.lapB.id] : []);
  const trace = lineSpread.data;
  const hasLineSpread = trace != null && trace.lapCount >= 2 && Number.isFinite(trace.consistencyScore) && Number.isFinite(trace.overallSpreadM);
  const a = useMemo(() => summarizeLapOverview(replayA.data), [replayA.data]);
  const b = useMemo(() => summarizeLapOverview(replayB.data), [replayB.data]);
  const units = useUnits();
  const number = (value: number | null, unit: string, convert = (n: number) => n, digits = 2) =>
    value === null ? null : `${convert(value).toFixed(digits)} ${unit}`;
  const fuelGameId = comparison?.gameId ?? comparison?.lapA.gameId;
  const fuelSpec = fuelGameId ? getGame(fuelGameId).telemetry.fuel : null;
  const fuel = (value: number | null) => {
    if (value === null || !fuelSpec) return null;
    const display = getFuelAmount(value, fuelSpec);
    return number(display.amount, display.unit);
  };
  const temperatureLabels: Record<string, string> = {
    "tire.temperature.surface.representative": `${m.label_tires()} · ${m.label_surface()}`,
    "tire.temperature.core": `${m.label_tires()} · ${m.label_core()}`,
    "tire.temperature.carcass.representative": `${m.label_tires()} · ${m.label_carcass()}`,
    "tire.temperature.surface.inner": `${m.label_surface()} · ${m.label_inner()}`,
    "tire.temperature.surface.middle": `${m.label_surface()} · ${m.label_middle()}`,
    "tire.temperature.surface.outer": `${m.label_surface()} · ${m.label_outer()}`,
    "tire.temperature.carcass.left": `${m.label_carcass()} · L`,
    "tire.temperature.carcass.middle": `${m.label_carcass()} · ${m.label_middle()}`,
    "tire.temperature.carcass.right": `${m.label_carcass()} · R`,
    "brakes.brake-temp": m.spectate_brake(),
  };
  const range = (min: number | null, max: number | null) => min === null || max === null ? null : `${units.temp(min).toFixed(1)} / ${units.temp(max).toFixed(1)} ${units.tempLabel}`;
  const groups: { title: string; icon: typeof CircleGauge; rows: StatRow[] }[] = [
    { title: m.review_sectors(), icon: Timer, rows: Array.from({ length: Math.max(comparison?.lapA.sectorTimes?.length ?? 0, comparison?.lapB.sectorTimes?.length ?? 0) }, (_, index) => {
      const valid = (value: number | undefined) => value != null && Number.isFinite(value) && value > 0 ? value : null;
      const timeA = valid(comparison?.lapA.sectorTimes?.[index]);
      const timeB = valid(comparison?.lapB.sectorTimes?.[index]);
      return { label: m.review_sector({ sector: index + 1 }), a: number(timeA, "s", undefined, 3), b: number(timeB, "s", undefined, 3), winner: winner(timeA, timeB, true) };
    }) },
    { title: m.label_speed(), icon: CircleGauge, rows: [
      { label: m.compare_overview_top_speed(), a: number(a.topSpeed, units.speedLabel, units.speed, 1), b: number(b.topSpeed, units.speedLabel, units.speed, 1), winner: winner(a.topSpeed, b.topSpeed, false) },
    ] },
    { title: m.label_tires(), icon: CircleGauge, rows: ["FL", "FR", "RL", "RR"].map((wheel, index) => ({
      label: m.compare_overview_wear({ wheel }), a: number(a.wear[index] ?? null, "%", (n) => n * 100), b: number(b.wear[index] ?? null, "%", (n) => n * 100), winner: winner(a.wear[index] ?? null, b.wear[index] ?? null, true),
    })) },
    { title: m.label_temperature(), icon: Thermometer, rows: a.temperatures.map((temperature) => {
      const other = b.temperatures.find(({ id }) => id === temperature.id);
      return { label: m.compare_overview_temp_range({ channel: temperatureLabels[temperature.id]! }), a: range(temperature.min, temperature.max), b: range(other?.min ?? null, other?.max ?? null) };
    }) },
    { title: m.label_fuel(), icon: Fuel, rows: [
      { label: m.compare_overview_starting_fuel(), a: fuel(a.startingFuel), b: fuel(b.startingFuel) },
      { label: m.compare_overview_fuel_used(), a: fuel(a.fuelUsed), b: fuel(b.fuelUsed), winner: winner(a.fuelUsed, b.fuelUsed, true) },
    ] },
    { title: "ERS", icon: Zap, rows: [
      { label: m.compare_overview_ers_deployed(), a: number(a.deployed, "MJ", (n) => n / 1e6), b: number(b.deployed, "MJ", (n) => n / 1e6) },
      { label: m.compare_overview_ers_recovered(), a: number(a.recovered, "MJ", (n) => n / 1e6), b: number(b.recovered, "MJ", (n) => n / 1e6) },
    ] },
  ];
  const visibleGroups = groups.map((group) => ({ ...group, rows: group.rows.filter((row) => row.a !== null || row.b !== null) })).filter((group) => group.rows.length > 0);
  const value = (side: "a" | "b", text: string | null) => {
    const replay = side === "a" ? replayA : replayB;
    if (replay.isError) return <span className="text-app-caption font-normal text-status-danger">{m.compare_telemetry_unavailable()}</span>;
    if (replay.isLoading) return <LoadingIndicator label={m.common_loading()} />;
    return text === null ? <span aria-label={m.compare_overview_unavailable()} title={m.compare_overview_unavailable()} className="text-app-text-dim">—</span> : text;
  };
  return (
    <section data-compare-overview="">
      {(selectionStatus || replayA.isLoading || replayB.isLoading || replayA.isError || replayB.isError || visibleGroups.length === 0) && (
        <p role="status" className="border-b border-app-border px-5 py-3 text-app-caption text-app-text-muted">
          {selectionStatus ?? (replayA.isLoading || replayB.isLoading ? <LoadingIndicator label={m.common_loading()} /> : m.compare_telemetry_unavailable())}
        </p>
      )}
      <table data-static-headers="" className="w-full table-fixed text-app-label">
        <colgroup><col className="w-[34%]" /><col className="w-[33%]" /><col className="w-[33%]" /></colgroup>
        <thead className="sticky top-0 z-10 bg-app-bg">
          <tr className="border-b border-app-border">
            <th scope="col" className="px-4 py-2 text-left text-app-caption font-medium text-app-text-muted sm:px-6">{m.compare_overview_stat()}</th>
            {(["a", "b"] as const).map((side) => {
              const color = side === "a" ? "var(--comparison-lap-a)" : "var(--comparison-lap-b)";
              return <th key={side} scope="col" className="border-l border-app-border px-3 py-2 text-left sm:px-5" style={{ boxShadow: `inset 0 3px 0 ${color}` }}>
                <div className="flex items-center gap-2 text-app-caption font-medium text-app-text-secondary">
                  <span className="flex size-5 items-center justify-center rounded-sm text-app-caption font-semibold" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{side.toUpperCase()}</span>
                  <span>{side === "a" ? m.compare_car_a() : m.compare_car_b()}</span>
                </div>
              </th>;
            })}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-app-border">
            <td />
            {(["a", "b"] as const).map((side) => {
              const lap = side === "a" ? comparison?.lapA : comparison?.lapB;
              return <td key={side} className="border-l border-app-border px-3 py-3 align-top sm:px-5">
                {side === "a" ? pickerA : pickerB}
                {lap && comparison && <div className="mt-3 font-mono text-app-detail font-semibold tabular-nums tracking-tight" style={{ color: comparisonColor(winner(Math.round(comparison.lapA.lapTime * 1000), Math.round(comparison.lapB.lapTime * 1000), true), side) }}>{formatLapTime(lap.lapTime)}</div>}
              </td>;
            })}
          </tr>
          <tr className="border-b border-app-border/40" data-overview-line-similarity="">
            <th scope="row" className="px-4 py-3 text-left text-app-caption font-normal text-app-text-secondary sm:px-6">{m.spectate_line_similarity()}</th>
            <td colSpan={2} className="border-l border-app-border/50 px-3 py-3 sm:px-5">
              {lineSpread.isLoading ? <LoadingIndicator label={m.common_loading()} /> : hasLineSpread ? <>
                <span className="font-mono text-app-compact font-semibold tabular-nums" style={{ color: severityRangeColor(100 - trace.consistencyScore, [20, 40]) }}>{trace.consistencyScore}%</span>
                <span className="ml-3 text-app-caption text-app-text-muted">{m.spectate_mean_spread({ spread: trace.overallSpreadM.toFixed(2) })}</span>
              </> : <span aria-label={m.compare_overview_unavailable()} className="text-app-text-dim">—</span>}
            </td>
          </tr>
          {visibleGroups.map(({ title, icon: Icon, rows }) => <Fragment key={title}>
          <tr className="border-y border-app-border bg-app-bg"><th colSpan={3} scope="colgroup" className="px-4 py-2.5 text-left text-app-caption font-semibold text-app-text-secondary sm:px-6"><span className="flex items-center gap-2"><Icon size={14} aria-hidden="true" />{title}</span></th></tr>
          {rows.map((row) => <tr key={row.label} className="border-b border-app-border/40 last:border-b-0">
            <th scope="row" className="px-4 py-3 text-left text-app-caption font-normal text-app-text-secondary sm:px-6">{row.label}</th>
            {(["a", "b"] as const).map((side) => {
              const best = row.a === row.b || replayA.isError || replayB.isError ? null : row.winner;
              return <td key={side} data-comparison-result={best == null ? "neutral" : best === side ? "better" : "worse"} style={{ color: comparisonColor(best, side) }} className="border-l border-app-border/50 px-3 py-2 text-left font-mono text-app-compact font-medium tabular-nums sm:px-5">
                {value(side, row[side])}
              </td>;
            })}
          </tr>)}
        </Fragment>)}</tbody>
      </table>
    </section>
  );
}
