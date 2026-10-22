import { useMemo } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import type { FourWheels, LiveStrategy } from "@raceiq/shared/racing/live/strategy";
import type { RacePlan } from "@raceiq/shared/racing/live/race-plan";
import type { LiveTelemetryView } from "@raceiq/frontend-pure/live-telemetry-view";
import { resolveAdherenceCheckpoints, buildStrategyAdherence } from "./strategy-adherence-model";
import { usePitEstimatePage, useStrategyStints } from "./stint-strategy";
import { useRaceStrategyHost } from "./host";
import type { RaceStrategyMessages } from "../contracts/messages";
import type { StrategyAdherenceModel, AdherencePoint, AdherenceReason, AdherenceResource, AdaptivePitWindow } from "../contracts/strategy-adherence";
import { getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { supportsRaceRefueling } from "../contracts/race-rules";

export function StrategyAdherencePanel({ plan, gameId, currentLap, view, strategy, fuelRemaining, fuelUnit, fuelCapacity, tireWear }: {
  plan: RacePlan;
  gameId: GameId;
  currentLap: number | null;
  view?: LiveTelemetryView;
  strategy: LiveStrategy | null;
  fuelRemaining: number | null;
  fuelUnit: "L" | "tankFraction";
  fuelCapacity: number | null;
  tireWear: FourWheels<number | null>;
}) {
  const { useTelemetryState, useSettings } = useRaceStrategyHost();
  const { displaySettings } = useSettings();
  const liveLaps = useTelemetryState((state) => state.sessionLaps);
  const sessionId = strategy?.sessionId ?? null;
  const lapFractionStatus = view?.statusBySemanticId["timing.lap-fraction"];
  const lapFraction = !lapFractionStatus || (lapFractionStatus.resolution === "ok" && lapFractionStatus.freshness === "fresh")
    ? view?.timing.lapFraction ?? null
    : null;
  const energyStatus = view?.statusBySemanticId["fuel.virtual-energy"];
  const energyValue = view?.valuesBySemanticId["fuel.virtual-energy"];
  const energyUnit = view?.unitsBySemanticId["fuel.virtual-energy"];
  const virtualEnergy = gameId === "lmu" && energyUnit === "fraction" && typeof energyValue === "number" && Number.isFinite(energyValue) &&
    (!energyStatus || (energyStatus.resolution === "ok" && energyStatus.freshness === "fresh")) ? energyValue : null;
  const driverKey = strategy?.driverKey ?? null;
  const stintId = strategy?.stintId ?? null;
  const stintsQuery = useStrategyStints(gameId, sessionId);
  const historyQuery = usePitEstimatePage(gameId, sessionId, driverKey, null);
  const currentStint = stintsQuery.data?.stints.find((stint) => stint.id === stintId &&
    stint.sessionId === sessionId && stint.driverKey === driverKey) ?? null;
  const thresholds = useMemo(() => (currentStint?.compounds ?? [null, null, null, null]).map((compound) =>
    getTireThresholds(displaySettings.tireThresholdOverrides ?? {}, gameId, compound ?? "default"),
  ) as FourWheels<TireThresholds>, [currentStint?.compounds, displaySettings.tireThresholdOverrides, gameId]);
  const checkpoints = useMemo(() => resolveAdherenceCheckpoints({
    plan, sessionId, driverKey, stintId,
    estimates: historyQuery.data?.estimates ?? [],
    laps: liveLaps.map(({ id, sessionId: lapSessionId, lapNumber }) => ({ id, sessionId: lapSessionId, lapNumber })),
  }), [plan, sessionId, driverKey, stintId, historyQuery.data?.estimates, liveLaps]);
  const planCapacity = fuelCapacity;
  const model = useMemo(() => buildStrategyAdherence({
    plan,
    currentLap,
    lapFraction,
    fuelRemaining,
    fuelUnit,
    fuelCapacity: planCapacity,
    tireWear,
    virtualEnergy,
    strategy,
    currentStint,
    checkpoints,
    thresholds,
    evidenceLoading: stintsQuery.isLoading || historyQuery.isLoading,
    evidenceError: stintsQuery.isError || historyQuery.isError || strategy?.persistence === "error",
  }), [plan, currentLap, lapFraction, fuelRemaining, fuelUnit, planCapacity, tireWear, gameId, virtualEnergy, strategy, currentStint, checkpoints, thresholds, stintsQuery.isLoading, historyQuery.isLoading, stintsQuery.isError, historyQuery.isError]);
  return <StrategyAdherence model={model} currentLap={model.currentPosition} currentFuelUnit={fuelUnit === "L" ? " L" : "%"} showFuel={supportsRaceRefueling(gameId)} historyRecent={!!historyQuery.data?.nextCursor} historyWarning={historyQuery.isError || stintsQuery.isError} />;
}

const wheels = ["FL", "FR", "RL", "RR"] as const;
const wheelColors = ["var(--status-info)", "var(--status-success)", "var(--status-warning)", "var(--status-danger)"] as const;
type Metric = { name: string; resource: AdherenceResource; unit: string; scale: number };
type PlotLayout = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  minLap: number;
  maxLap: number;
  minValue: number;
  maxValue: number;
  unit: string;
  x: (lap: number) => number;
  y: (value: number) => number;
};

function finitePoints(points: readonly AdherencePoint[]) {
  return points.filter((point) => Number.isFinite(point.lap) && Number.isFinite(point.value));
}
function path(points: readonly AdherencePoint[], x: (lap: number) => number, y: (value: number) => number) {
  let result = "";
  for (const point of points) result += `${result && !point.breakBefore ? "L" : "M"}${x(point.lap)},${y(point.value)} `;
  return result.trim();
}
function plotLayout(series: readonly (readonly AdherencePoint[])[], stopLaps: readonly number[], window: AdaptivePitWindow, currentLap: number | null, unit: string): PlotLayout {
  const width = 480, height = 140, left = 54, right = 12, top = 24, bottom = 30;
  const points = series.flat();
  const xCandidates = [...points.map((point) => point.lap), ...stopLaps, window.earliestLap, window.latestLap, currentLap]
    .filter((lap): lap is number => lap != null && Number.isFinite(lap));
  const minLap = xCandidates.length ? Math.min(...xCandidates) : 0;
  const maxLap = Math.max(minLap + 1, ...xCandidates);
  const values = points.map((point) => point.value);
  const minValue = Math.min(0, ...values), maxValue = Math.max(1, ...values);
  const x = (lap: number) => Math.max(left, Math.min(width - right, left + (lap - minLap) / (maxLap - minLap) * (width - left - right)));
  const y = (value: number) => Math.max(top, Math.min(height - bottom, top + (maxValue - value) / (maxValue - minValue || 1) * (height - top - bottom)));
  return { width, height, left, right, top, bottom, minLap, maxLap, minValue, maxValue, unit, x, y };
}
function PlotGuides({ layout, window }: { layout: PlotLayout; window: AdaptivePitWindow }) {
  const { width, height, left, right, top, bottom, minValue, x, y } = layout;
  const windowStart = window.earliestLap, windowEnd = window.latestLap;
  return <>
    {windowStart != null && windowEnd != null && <rect x={x(windowStart)} y={top} width={Math.max(0, x(windowEnd) - x(windowStart))} height={height - top - bottom} fill="var(--status-warning)" opacity="0.14" />}
    <line x1={left} y1={y(minValue)} x2={width - right} y2={y(minValue)} stroke="var(--app-border)" />
    <line x1={left} y1={height - 10} x2={width - right} y2={height - 10} stroke="var(--app-border)" />
  </>;
}
function PlotMarkers({ layout, currentLap, stopLaps, m }: { layout: PlotLayout; currentLap: number | null; stopLaps: readonly number[]; m: RaceStrategyMessages }) {
  const { width, height, left, right, top, bottom, minLap, maxLap, minValue, maxValue, unit, x } = layout;
  const labelX = (lap: number) => Math.max(left + 22, Math.min(width - right - 22, x(lap)));
  const currentValid = currentLap != null && Number.isFinite(currentLap);
  return <>
    {stopLaps.map((lap, index) => <g key={`${lap}-${index}`}>
      <line x1={x(lap)} y1={top} x2={x(lap)} y2={height - bottom} stroke="var(--app-text-dim)" strokeDasharray="2 3" />
      <text x={labelX(lap)} y={height - bottom + 13} textAnchor="middle" fill="var(--app-text-muted)" fontSize="11">{m.race_adherence_lap({ lap })}</text>
    </g>)}
    {currentValid && <g>
      <line x1={x(currentLap)} y1={top} x2={x(currentLap)} y2={height - bottom} stroke="var(--app-text)" strokeWidth="1.5" />
      <text x={labelX(currentLap)} y={top - 6} textAnchor="middle" fill="var(--app-text)" fontSize="12">{m.race_adherence_current()}</text>
    </g>}
    {[minLap, (minLap + maxLap) / 2, maxLap].map((lap, index) => <g key={index}>
      <line x1={x(lap)} y1={height - 10} x2={x(lap)} y2={height - 6} stroke="var(--app-text-muted)" />
      <text x={labelX(lap)} y={height - 3} textAnchor="middle" fill="var(--app-text-muted)" fontSize="11">{lap.toFixed(0)}</text>
    </g>)}
    <text x={left - 5} y={top + 4} textAnchor="end" fill="var(--app-text-muted)" fontSize="11">{maxValue.toFixed(1)}{unit}</text>
    <text x={left - 5} y={height - bottom} textAnchor="end" fill="var(--app-text-muted)" fontSize="11">{minValue.toFixed(1)}{unit}</text>
  </>;
}
function resourceStateText(resource: AdherenceResource, m: RaceStrategyMessages) {
  return resource.state === "within" ? m.race_adherence_within() : resource.state === "over" ? m.race_adherence_over() : m.race_adherence_unknown();
}
function FuelPlot({ metric, currentLap, stopLaps, window }: { metric: Metric; currentLap: number | null; stopLaps: readonly number[]; window: AdaptivePitWindow }) {
  const { m } = useRaceStrategyHost();
  const actual = finitePoints(metric.resource.actual).slice(-40).map((point) => ({ ...point, value: point.value * metric.scale }));
  const reference = finitePoints(metric.resource.reference).slice(-40).map((point) => ({ ...point, value: point.value * metric.scale }));
  const layout = plotLayout([actual, reference], stopLaps, window, currentLap, metric.unit);
  const actualPath = path(actual, layout.x, layout.y), referencePath = path(reference, layout.x, layout.y);
  const latestActual = actual[actual.length - 1];
  const stateLabel = resourceStateText(metric.resource, m);
  return <figure className="min-w-0" aria-label={`${metric.name}: ${stateLabel}`} data-testid="adherence-plot-fuel">
    <figcaption className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
      <span className="font-semibold">{metric.name}</span>
      <span className="text-app-text-muted">{latestActual ? `${m.race_adherence_actual()} ${latestActual.value.toFixed(1)}${metric.unit}` : "—"}</span>
      <span className={metric.resource.state === "over" ? "text-status-danger" : metric.resource.state === "within" ? "text-status-success" : "text-app-text-muted"}>{stateLabel}</span>
    </figcaption>
    <svg className="mt-1 block h-28 w-full overflow-hidden" viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none" role="img" aria-label={`${m.race_adherence_actual()} ${metric.name}; ${m.race_adherence_planned()} ${metric.name}`}>
      <PlotGuides layout={layout} window={window} />
      {referencePath && <path d={referencePath} fill="none" stroke="var(--app-text-muted)" strokeDasharray="6 4" strokeWidth="2" />}
      {actualPath && <path d={actualPath} fill="none" stroke={metric.resource.state === "over" ? "var(--status-danger)" : "var(--status-info)"} strokeWidth="2.5" />}
      {actual.map((point, index) => <circle key={`${point.lap}-${index}`} cx={layout.x(point.lap)} cy={layout.y(point.value)} r="3" fill="var(--status-info)"><title>{`${m.race_adherence_lap({ lap: point.lap })}: ${point.value.toFixed(1)}${metric.unit}`}</title></circle>)}
      <PlotMarkers layout={layout} currentLap={currentLap} stopLaps={stopLaps} m={m} />
    </svg>
  </figure>;
}
function TireResourceSummary({ metric, index }: { metric: Metric; index: number }) {
  const { m } = useRaceStrategyHost();
  const actual = finitePoints(metric.resource.actual);
  const latest = actual[actual.length - 1];
  const stateLabel = resourceStateText(metric.resource, m);
  return <figure className="min-w-0 rounded border border-app-border px-2 py-1" aria-label={`${metric.name}: ${stateLabel}`} data-testid={`adherence-plot-tire-${wheels[index].toLowerCase()}`}>
    <figcaption className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
      <span className="inline-flex items-center gap-1 font-semibold">
        <svg aria-hidden="true" className="size-3 shrink-0" viewBox="0 0 12 12">
          <circle cx="6" cy="6" r="4" fill={wheelColors[index]} />
        </svg>
        {wheels[index]}
      </span>
      <span className="text-app-text-muted">{latest ? `${m.race_adherence_actual()} ${(latest.value * 100).toFixed(1)}%` : "—"}</span>
      <span className={metric.resource.state === "over" ? "text-status-danger" : metric.resource.state === "within" ? "text-status-success" : "text-app-text-muted"}>{stateLabel}</span>
    </figcaption>
  </figure>;
}
function WheelMarker({ index, cx, cy, color, title }: { index: number; cx: number; cy: number; color: string; title: string }) {
  if (index === 0) return <circle cx={cx} cy={cy} r="3" fill={color}><title>{title}</title></circle>;
  if (index === 1) return <rect x={cx - 3} y={cy - 3} width="6" height="6" fill={color}><title>{title}</title></rect>;
  if (index === 2) return <polygon points={`${cx},${cy - 4} ${cx + 4},${cy} ${cx},${cy + 4} ${cx - 4},${cy}`} fill={color}><title>{title}</title></polygon>;
  return <polygon points={`${cx},${cy - 4} ${cx + 4},${cy + 3} ${cx - 4},${cy + 3}`} fill={color}><title>{title}</title></polygon>;
}
function TirePlot({ metrics, currentLap, stopLaps, window }: { metrics: readonly Metric[]; currentLap: number | null; stopLaps: readonly number[]; window: AdaptivePitWindow }) {
  const { m } = useRaceStrategyHost();
  const series = metrics.map((metric) => ({
    actual: finitePoints(metric.resource.actual).slice(-40).map((point) => ({ ...point, value: point.value * 100 })),
    reference: finitePoints(metric.resource.reference).slice(-40).map((point) => ({ ...point, value: point.value * 100 })),
  }));
  const layout = plotLayout(series.flatMap((item) => [item.actual, item.reference]), stopLaps, window, currentLap, "%");
  return <figure className="min-w-0" aria-label={`${m.race_adherence_tires()}: FL, FR, RL, RR; ${m.race_adherence_actual()}; ${m.race_adherence_planned()}`} data-testid="adherence-plot-tires">
    <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-app-text-muted">
      <span className="font-semibold text-app-text">{m.race_adherence_tires()} · %</span>
      {wheels.map((wheel, index) => <span key={wheel} className="inline-flex items-center gap-1">
        <svg aria-hidden="true" className="size-4 shrink-0" viewBox="0 0 16 10">
          <line x1="1" y1="5" x2="15" y2="5" stroke={wheelColors[index]} strokeWidth="2" />
          <WheelMarker index={index} cx={8} cy={5} color={wheelColors[index]} title={wheel} />
        </svg>
        {wheel}
      </span>)}
    </figcaption>
    <svg className="mt-1 block h-28 w-full overflow-hidden" viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none" role="img" aria-label={`${m.race_adherence_actual()} ${m.race_adherence_tires()}; ${m.race_adherence_planned()} FL, FR, RL, RR`}>
      <PlotGuides layout={layout} window={window} />
      {series.map(({ actual, reference }, index) => {
        const color = wheelColors[index];
        const referencePath = path(reference, layout.x, layout.y);
        const actualPath = path(actual, layout.x, layout.y);
        return <g key={wheels[index]}>
          {referencePath && <path d={referencePath} fill="none" stroke={color} strokeDasharray="6 4" strokeWidth="2" />}
          {actualPath && <path d={actualPath} fill="none" stroke={color} strokeWidth="2.5" />}
          {actual.map((point, pointIndex) => <WheelMarker key={`${point.lap}-${pointIndex}`} index={index} cx={layout.x(point.lap)} cy={layout.y(point.value)} color={color} title={`${wheels[index]} · ${m.race_adherence_lap({ lap: point.lap })}: ${point.value.toFixed(1)}%`} />)}
        </g>;
      })}
      <PlotMarkers layout={layout} currentLap={currentLap} stopLaps={stopLaps} m={m} />
    </svg>
  </figure>;
}

function reasonText(reason: AdherenceReason | null, m: RaceStrategyMessages) {
  if (!reason) return null;
  const labels = { evidence: m.race_adherence_reason_evidence(), position: m.race_adherence_reason_position(), settings: m.race_adherence_reason_settings(), capacity: m.race_adherence_reason_capacity(), compound: m.race_adherence_reason_compound(), energy: m.race_adherence_reason_energy(), history: m.race_adherence_reason_history(), infeasible: m.race_adherence_reason_infeasible() };
  return labels[reason];
}
function windowText(window: AdaptivePitWindow, m: RaceStrategyMessages, showFuel: boolean) {
  switch (window.state) {
    case "upcoming": return window.earliestLap != null && window.latestLap != null ? m.race_adherence_window_upcoming({ first: window.earliestLap, last: window.latestLap }) : m.race_adherence_window_unknown();
    case "open": return window.latestLap != null ? m.race_adherence_window_open({ last: window.latestLap }) : m.race_adherence_window_unknown();
    case "overdue": return m.race_adherence_window_overdue();
    case "finish": return showFuel ? m.race_adherence_window_finish() : m.race_adherence_tires_finish();
    default: return m.race_adherence_window_unknown();
  }
}

function StrategyAdherence({ model, currentLap, currentFuelUnit, showFuel, historyRecent, historyWarning }: { model: StrategyAdherenceModel; currentLap: number | null; currentFuelUnit: string; showFuel: boolean; historyRecent: boolean; historyWarning: boolean }) {
  const { m } = useRaceStrategyHost();
  const nextPlannedStop = model.plannedStopLaps.find((lap) => model.currentPosition == null || lap >= model.currentPosition);
  const stopLaps = nextPlannedStop == null ? [] : [nextPlannedStop];
  const fuelMetric: Metric = { name: m.race_adherence_fuel(), resource: model.fuel, unit: currentFuelUnit, scale: currentFuelUnit === "%" ? 100 : 1 };
  const tireMetrics = model.tires.map((resource, index) => ({ name: `${m.race_adherence_tires()} ${wheels[index]}`, resource, unit: "%", scale: 100 }));
  const stateText = model.state === "within" ? m.race_adherence_within() : model.state === "over" ? m.race_adherence_over() : m.race_adherence_unknown();
  const reason = reasonText(model.window.reason, m);
  return <section data-testid="strategy-adherence" data-adherence-state={model.state} className="min-w-0 space-y-2 border-t border-app-border pt-2" aria-labelledby="strategy-adherence-title">
    <header className="flex flex-wrap items-baseline justify-between gap-2"><h4 id="strategy-adherence-title" className="text-xs font-semibold uppercase tracking-wide">{m.race_adherence_title()}</h4><span role="status" className={`text-xs font-semibold ${model.state === "within" ? "text-status-success" : model.state === "over" ? "text-status-danger" : "text-app-text-muted"}`}>{stateText}</span></header>
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-app-text-muted">
      <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="w-3 border-t-2 border-solid border-status-info" />{m.race_adherence_actual()}</span>
      <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="w-3 border-t-2 border-dashed border-app-text-muted" />{m.race_adherence_planned()}</span>
      <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="h-2 border-l border-app-text" />{m.race_adherence_current()}</span>
      <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="h-2 border-l border-dotted border-app-text-dim" />{m.race_adherence_saved_plan()}</span>
    </div>
    <div data-testid="strategy-adherence-window" data-window-state={model.window.state} data-earliest-lap={model.window.earliestLap ?? ""} data-latest-lap={model.window.latestLap ?? ""} className="rounded border border-app-border bg-app-bg/40 p-2"><p className="text-xs font-semibold">{windowText(model.window, m, showFuel)}</p>{model.window.stopsRemaining != null && <p className="text-xs text-app-text-muted">{m.race_adherence_stops({ count: model.window.stopsRemaining })}</p>}{model.window.basis === "plan" && <p className="text-xs text-status-warning">{m.race_adherence_provisional()}</p>}{(model.window.state === "upcoming" || model.window.state === "open" || model.window.state === "overdue") && <p className="text-xs text-app-text-muted">{showFuel ? m.race_adherence_assumption() : m.race_adherence_tires_assumption()}</p>}{reason && <p className="text-xs text-app-text-muted">{reason}</p>}{model.currentPosition != null && <p className="text-xs text-app-text-muted">{m.race_adherence_current()}: {m.race_adherence_lap({ lap: model.currentPosition })}</p>}</div>
    {historyRecent && <p className="text-xs text-app-text-muted">{m.race_adherence_recent()}</p>}{historyWarning && <p role="alert" className="text-xs text-status-warning">{m.race_adherence_reason_history()}</p>}
    <div className="min-w-0 space-y-2">
    {showFuel && <FuelPlot metric={fuelMetric} currentLap={currentLap} stopLaps={stopLaps} window={model.window} />}
    <div role="group" aria-label={m.race_adherence_tires()} className="grid min-w-0 grid-cols-2 gap-1.5">
      {tireMetrics.map((metric, index) => <TireResourceSummary key={wheels[index]} metric={metric} index={index} />)}
    </div>
    <TirePlot metrics={tireMetrics} currentLap={currentLap} stopLaps={stopLaps} window={model.window} />
    </div>
  </section>;
}
