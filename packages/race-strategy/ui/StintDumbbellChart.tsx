import { useMemo } from "react";
import type { MetricRate, StrategyLapMetric, StintSummary } from "@raceiq/shared/racing/live/strategy";
import { useRaceStrategyHost } from "./host";
import { useStrategyFormat } from "./strategy-format";

const wheels = ["FL", "FR", "RL", "RR"] as const;
export type ThermalPopulation = "hot" | "cold";
export type StintMetric = "fuel" | number;
type Point = { lap: StrategyLapMetric; value: number; unit: string; compound: string | null; stint: StintSummary };
type Group = { key: string; label: string; context: string; points: Point[] };

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(fraction * (sorted.length - 1))]!;
}

function metricContext(stint: StintSummary, metric: StintMetric, unit: string) {
  const semantic = metric === "fuel" ? stint.compatibility.fuelSemanticVersion : stint.compatibility.tireSemanticVersions[metric];
  const compound = metric === "fuel" ? "" : stint.compounds[metric] ?? "unknown";
  return [stint.gameId, stint.trackId, stint.carId, stint.driverKey, unit, semantic ?? `unknown:${stint.id}`, stint.compatibility.setupKey ?? "unknown", stint.gameId === "fm-2023" ? stint.pi ?? `unknown:${stint.id}` : "not-required", compound].join("|");
}

export function StintDumbbellChart({ stints, laps, metric, population, selectedCompound, showP50, showP95, focusedLapId, onFocusLap }: {
  stints: StintSummary[];
  laps: StrategyLapMetric[];
  metric: StintMetric;
  population: ThermalPopulation;
  selectedCompound: string;
  showP50: boolean;
  showP95: boolean;
  focusedLapId: number | null;
  onFocusLap: (id: number | null) => void;
}) {
  const { m } = useRaceStrategyHost();
  const label = metric === "fuel" ? m.strategy_fuel_rate() : wheels[metric]!;
  const groups = useMemo(() => {
    const byContext = new Map<string, Group>();
    const stintById = new Map(stints.map((stint) => [stint.id, stint]));
    for (const lap of laps) {
      if (population === "cold" ? lap.thermalState !== "cold" : lap.thermalState === "cold") continue;
      const stint = stintById.get(lap.stintId);
      if (!stint) continue;
      const measurement = metric === "fuel" ? lap.fuel : lap.tires[metric]!;
      const compound = metric === "fuel" ? null : lap.tires[metric]!.compound;
      if (metric !== "fuel" && selectedCompound !== "all" && (selectedCompound === "unknown" ? compound != null : compound !== selectedCompound)) continue;
      const key = metricContext(stint, metric, measurement.unit);
      let group = byContext.get(key);
      if (!group) {
        const semantic = metric === "fuel" ? stint.compatibility.fuelSemanticVersion : stint.compatibility.tireSemanticVersions[metric];
        const unitLabel = measurement.unit === "L/lap" ? m.strategy_rate_litres({ value: "" }).trim() : m.strategy_rate_points({ value: "" }).trim();
        const context = [`${m.analyse_game_label()}: ${stint.gameId}`, `${m.analyse_track_label()}: ${stint.trackId}`, `${m.analyse_car_label()}: ${stint.carId}`, m.strategy_driver({ driver: lap.driverKey === "local-player" ? m.strategy_local_player() : lap.driverKey }), `${m.strategy_setup()}: ${stint.compatibility.setupKey ?? m.strategy_unknown()}`, ...(stint.gameId === "fm-2023" ? [`${m.cars_pi()}: ${stint.pi ?? m.strategy_unknown()}`] : []), `${label} · ${semantic ?? m.strategy_unknown()}`, ...(metric === "fuel" ? [] : [`${wheels[metric]} ${compound ?? m.strategy_unknown()}`]), ...(semantic == null || stint.gameId === "fm-2023" && stint.pi == null ? [m.strategy_stint({ ordinal: stint.ordinal })] : [])].join(" · ");
        group = { key, label: `${label}${metric === "fuel" ? "" : ` · ${compound ?? m.strategy_unknown()}`} · ${unitLabel}`, context, points: [] };
        byContext.set(key, group);
      }
      if (measurement.value != null && Number.isFinite(measurement.value)) group.points.push({ lap, value: measurement.value, unit: measurement.unit, compound, stint });
    }
    return [...byContext.values()];
  }, [stints, laps, metric, population, selectedCompound, m, label]);

  return <section role="group" aria-label={label} className="min-w-0 space-y-3">
    <h3 className="text-sm font-semibold text-app-text">{label}</h3>
    {groups.length === 0 && <p role="status" className="rounded border border-app-border/60 p-5 text-center text-sm text-app-text-muted">{m.strategy_unavailable()}</p>}
    {groups.map((group) => <ScatterContextChart key={group.key} group={group} metricLabel={label} metric={metric} showP50={showP50} showP95={showP95} focusedLapId={focusedLapId} onFocusLap={onFocusLap} />)}
  </section>;
}

function ScatterContextChart({ group, metricLabel, metric, showP50, showP95, focusedLapId, onFocusLap }: {
  group: Group;
  metricLabel: string;
  metric: StintMetric;
  showP50: boolean;
  showP95: boolean;
  focusedLapId: number | null;
  onFocusLap: (id: number | null) => void;
}) {
  const { m } = useRaceStrategyHost();
  const { strategyRateText, strategyReasonText } = useStrategyFormat();
  const points = group.points;
  const first = points[0];
  if (!first) return <div role="group" aria-label={group.label}><h4 className="break-words text-xs text-app-text-muted">{group.label}</h4><details className="text-xs text-app-text-muted"><summary className="cursor-pointer">{m.strategy_stint_details()}</summary><p>{group.context}</p></details><p role="status" className="p-5 text-center text-sm text-app-text-muted">{m.strategy_unavailable()}</p></div>;
  const values = points.map((point) => point.value);
  const p50 = percentile(values, 0.5);
  const p95 = percentile(values, 0.95);
  const lapNumbers = points.map((point) => point.lap.lapNumber);
  const minLap = Math.min(...lapNumbers);
  const maxLap = Math.max(...lapNumbers);
  const xMin = minLap === maxLap ? minLap - 0.5 : minLap;
  const xMax = minLap === maxLap ? maxLap + 0.5 : maxLap;
  const maxValue = Math.max(...values, 0);
  const paddedMax = maxValue * 1.1;
  const yMax = maxValue > 0 ? Number.isFinite(paddedMax) ? paddedMax : maxValue : 1;
  const width = 560;
  const height = Math.max(220, 76 + 30 * Math.min(points.length, 20));
  const left = 100, right = 14, top = 14, bottom = 40;
  const x = (value: number) => left + (value - xMin) / (xMax - xMin) * (width - left - right);
  const y = (value: number) => height - bottom - value / yMax * (height - top - bottom);
  const unit = first.unit === "L/lap" ? m.strategy_rate_litres({ value: "" }).trim() : m.strategy_rate_points({ value: "" }).trim();
  const rate = (value: number) => strategyRateText({ ...first.stint.fuel, unit: first.unit, value } as MetricRate);
  const ticks = [xMin, xMin + (xMax - xMin) / 2, xMax];
  return <div role="group" aria-label={group.label} className="min-w-0 space-y-1.5">
    <h4 className="break-words text-xs text-app-text-muted">{group.label}</h4>
    <details className="text-xs text-app-text-muted"><summary className="cursor-pointer">{m.strategy_stint_details()}</summary><p className="break-words">{group.context}</p></details>
    <div className="min-w-0 overflow-x-auto rounded border border-app-border/60" role="region" aria-label={group.label} tabIndex={0}>
    <svg data-testid="stint-lap-scatter-plot" data-context={group.key} data-point-count={points.length} role="group" aria-label={`${metricLabel} · ${group.label}`} viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block min-w-[560px] rounded focus-visible:outline-2">
      <text x={width / 2} y={height - 5} textAnchor="middle" className="fill-app-text-muted" fontSize="11">{m.strategy_lap_axis()}</text>
      <text x="12" y={height / 2} transform={`rotate(-90 12 ${height / 2})`} textAnchor="middle" className="fill-app-text-muted" fontSize="11">{unit}</text>
      {[0, 0.5, 1].map((fraction) => <g key={fraction}><line x1={left} x2={width - right} y1={top + fraction * (height - top - bottom)} y2={top + fraction * (height - top - bottom)} stroke="var(--app-border)" strokeOpacity=".5"/><text x={left - 6} y={top + fraction * (height - top - bottom) + 4} textAnchor="end" className="fill-app-text-muted" fontSize="11">{rate(yMax * (1 - fraction))}</text></g>)}
      {ticks.map((tick) => <text key={tick} x={x(tick)} y={height - bottom + 16} textAnchor="middle" className="fill-app-text-muted" fontSize="11">{Number.isInteger(tick) ? tick : tick.toFixed(1)}</text>)}
      {showP50 && p50 != null && <line data-testid="stint-p50-overlay" x1={left} x2={width - right} y1={y(p50)} y2={y(p50)} stroke="var(--app-accent)" strokeWidth="2" strokeDasharray="5 4"><title>{m.strategy_percentile_p50()} {rate(p50)}</title></line>}
      {showP95 && p95 != null && <line data-testid="stint-p95-overlay" x1={left} x2={width - right} y1={y(p95)} y2={y(p95)} stroke="var(--app-text-muted)" strokeWidth="2" strokeDasharray="2 4"><title>{m.strategy_percentile_p95()} {rate(p95)}</title></line>}
      {points.map((point) => {
        const value = metric === "fuel" ? point.lap.fuel : point.lap.tires[metric]!;
        const focused = point.lap.lapId === focusedLapId;
        const valueText = strategyRateText({ ...first.stint.fuel, unit: value.unit, value: point.value } as MetricRate);
        return <g key={point.lap.lapId}><circle data-lap-id={point.lap.lapId} data-lap-number={point.lap.lapNumber} data-value={point.value} tabIndex={0} role="button" aria-pressed={focused} aria-label={`${m.strategy_lap_number({ lap: point.lap.lapNumber })} · ${metricLabel} ${valueText}${point.compound ? ` · ${point.compound}` : ""}`} cx={x(point.lap.lapNumber)} cy={y(point.value)} r="12" fill="transparent" stroke="transparent" onClick={() => onFocusLap(point.lap.lapId)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onFocusLap(point.lap.lapId); } }} onFocus={() => onFocusLap(point.lap.lapId)} onPointerEnter={() => onFocusLap(point.lap.lapId)}><title>{`${m.strategy_lap_number({ lap: point.lap.lapNumber })} · ${valueText} · ${point.compound ?? strategyReasonText(value.unavailableReason)}`}</title></circle><circle cx={x(point.lap.lapNumber)} cy={y(point.value)} r={focused ? 7 : 4.5} pointerEvents="none" fill={focused ? "var(--app-accent)" : "var(--app-text-muted)"} stroke={focused ? "var(--app-text)" : "var(--app-accent)"} strokeWidth={focused ? 2 : 1}/></g>;
      })}
    </svg>
    </div>
    <p className="text-[11px] text-app-text-muted">{showP50 ? `${m.strategy_percentile_p50()} ${p50 == null ? m.strategy_unavailable() : rate(p50)}` : ""}{showP50 && showP95 ? " · " : ""}{showP95 ? `${m.strategy_percentile_p95()} ${p95 == null ? m.strategy_unavailable() : rate(p95)}` : ""}</p>
  </div>;
}
