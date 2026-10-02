import { useMemo, useState } from "react";
import { indexAtFrac, type TireAverages, type TireTraces } from "../../../lib/stint-traces";
import { Lane, type AnnotationMarker, type LaneSeries } from "./Lane";
import type { TrackFocusTrace } from "./types";
import { ChartSpread, type TooltipDisplayMode } from "./ChartTooltip";

import { Button } from "../../ui/button";
interface SharedPanelProps {
  traces: (TrackFocusTrace | undefined)[];
  primaryLapId?: number | null;
  cornerFracs?: number[];
  annotationMarkers?: AnnotationMarker[];
  cursorFrac?: number | null;
  onCursorFrac?: (f: number | null) => void;
  visibleRange?: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
  tooltipMode?: TooltipDisplayMode;
}

interface TiresPanelProps extends SharedPanelProps {
  tireWearContinuous?: boolean;
}


interface FuelPanelProps extends SharedPanelProps {
  fuelUnit?: "litre" | "fraction";
  tooltipMode?: TooltipDisplayMode;
}

const WHEELS: (keyof TireAverages)[] = ["FL", "FR", "RL", "RR"];
const WHEEL_LABELS: Record<keyof TireAverages, string> = { FL: "Front left", FR: "Front right", RL: "Rear left", RR: "Rear right" };

function peak(trace: TireTraces | null, index: number): number {
  if (!trace) return Number.NaN;
  return Math.max(...WHEELS.map((wheel) => trace[wheel][index] ?? Number.NaN));
}
function valueRange(values: ArrayLike<number>): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null;
}

function peakValues(trace: TireTraces): Float32Array {
  return Float32Array.from({ length: trace.FL.length }, (_, index) => peak(trace, index));
}


function lineSeries(laps: TrackFocusTrace[], getTrace: (lap: TrackFocusTrace) => TireTraces | null, primaryLapId: number | null, wheel?: keyof TireAverages): LaneSeries[] {
  return laps.map((lap) => ({
    x: lap.frac,
    values: wheel ? (getTrace(lap)?.[wheel] ?? new Float32Array(lap.n)) : Float32Array.from({ length: lap.n }, (_, index) => peak(getTrace(lap), index)),
    color: lap.lapId === primaryLapId ? "var(--app-accent)" : "color-mix(in srgb, var(--app-text-dim) 35%, transparent)",
    width: lap.lapId === primaryLapId ? 1.8 : 1,
  }));
}

function TireMetricSection({
  title,
  laps,
  primaryLapId,
  getTrace,
  cornerFracs,
  annotationMarkers,
  cursorFrac,
  onCursorFrac,
  visibleRange,
  onRangeSelect,
  onZoomOut,
  tooltipMode = "per-lap",
}: {
  title: string;
  laps: TrackFocusTrace[];
  primaryLapId: number | null;
  getTrace: (lap: TrackFocusTrace) => TireTraces | null;
  cornerFracs: number[];
  annotationMarkers?: AnnotationMarker[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
  visibleRange: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
  tooltipMode?: TooltipDisplayMode;
}) {
  const [expanded, setExpanded] = useState(false);
  const available = useMemo(() => laps.filter((lap) => getTrace(lap)), [getTrace, laps]);
  if (!available.length) return null;
  const domain: [number, number] = [0, Math.max(1, ...available.flatMap((lap) => Array.from(getTrace(lap)!.FL)))];
  const best = available.find((lap) => lap.lapId === primaryLapId) ?? available[0];
  const tooltip = (wheel?: keyof TireAverages) => (frac: number) => {
    const metricValues = available.map((lap) => ({ lap, value: (wheel ? getTrace(lap)![wheel][indexAtFrac(lap, frac)] : peak(getTrace(lap), indexAtFrac(lap, frac))) }));
    if (tooltipMode === "per-lap") {
      return <div className="space-y-0.5 font-mono tabular-nums"><ChartSpread values={metricValues.map((sample) => sample.value)} format={(value) => value.toFixed(1)} />{metricValues.sort((a, b) => b.value - a.value).map(({ lap, value }) => <div key={lap.lapId}><span className={lap.lapId === primaryLapId ? "text-app-accent" : "text-app-text-muted"}>L{lap.lapNumber}</span>: {value.toFixed(1)}</div>)}</div>;
    }
    const trace = getTrace(best);
    if (!trace) return null;
    const primaryRange = valueRange(wheel ? trace[wheel] : peakValues(trace));
    const index = indexAtFrac(best, frac);
    const value = wheel ? trace[wheel][index] : peak(trace, index);
    return (
      <div className="space-y-1">
        <ChartSpread values={metricValues.map((sample) => sample.value)} format={(value) => value.toFixed(1)} />
        <div className="font-mono tabular-nums text-app-text-dim">
          {wheel ? WHEEL_LABELS[wheel] : "Peak"}: {Number.isFinite(value) ? value.toFixed(1) : "—"}
          {primaryRange && <span className="block text-app-text-muted">min–max: {primaryRange[0].toFixed(1)}–{primaryRange[1].toFixed(1)}</span>}
        </div>
      </div>
    );
  };
  return (
    <div className="relative space-y-2">
      <Lane
        title={title}
        domain={domain}
        cornerFracs={cornerFracs}
        annotationMarkers={annotationMarkers}
        cursorFrac={cursorFrac}
        onCursorFrac={onCursorFrac}
        visibleRange={visibleRange}
        onRangeSelect={onRangeSelect}
        onZoomOut={onZoomOut}
        tooltip={tooltip()}
        series={lineSeries(available, getTrace, primaryLapId)}
      />
      <Button variant="app-outline" size="app-sm" onClick={() => setExpanded((value) => !value)}>
        {expanded ? "Hide per-wheel detail" : "Show per-wheel detail"}
      </Button>
      {expanded &&
        WHEELS.map((wheel) => (
          <Lane
            key={wheel}
            title={WHEEL_LABELS[wheel]}
            domain={domain}
            cornerFracs={cornerFracs}
            cursorFrac={cursorFrac}
            onCursorFrac={onCursorFrac}
            visibleRange={visibleRange}
            onRangeSelect={onRangeSelect}
            onZoomOut={onZoomOut}
            tooltip={tooltip(wheel)}
            series={lineSeries(available, getTrace, primaryLapId, wheel)}
          />
        ))}
    </div>
  );
}

function panelTraces(traces: (TrackFocusTrace | undefined)[]) {
  return traces.filter((trace): trace is TrackFocusTrace => !!trace);
}

export function TiresPanel({
  traces,
  primaryLapId = null,
  cornerFracs = [],
  annotationMarkers,
  cursorFrac = null,
  onCursorFrac = () => {},
  visibleRange = null,
  onRangeSelect,
  onZoomOut,
  tireWearContinuous = false,
  tooltipMode = "per-lap",
}: TiresPanelProps) {
  const laps = useMemo(() => panelTraces(traces), [traces]);
  const metrics: Array<[string, (lap: TrackFocusTrace) => TireTraces | null]> = [
    ["Tyres — peak temperature (°C)", (lap) => lap.tireTempTrace],
    ["Tyres — peak pressure (bar)", (lap) => lap.pressureTrace],
    ["Brakes — peak brake temperature (°C)", (lap) => lap.brakeTempTrace],
  ];
  const wearLaps = laps.filter((lap) => lap.tireWearTrace != null);
  return (
    <div className="space-y-5">
      {metrics.map(([title, getTrace]) => (
        <TireMetricSection
          key={title}
          title={title}
          laps={laps}
          primaryLapId={primaryLapId}
          tooltipMode={tooltipMode}
          getTrace={getTrace}
          cornerFracs={cornerFracs}
          annotationMarkers={annotationMarkers}
          cursorFrac={cursorFrac}
          onCursorFrac={onCursorFrac}
          visibleRange={visibleRange}
          onRangeSelect={onRangeSelect}
          onZoomOut={onZoomOut}
        />
      ))}
      {tireWearContinuous && wearLaps.length ? (
        <Lane
          title="Tyre wear (% worn)"
          domain={[0, 100]}
          cursorFrac={cursorFrac}
          onCursorFrac={onCursorFrac}
          visibleRange={visibleRange}
          onRangeSelect={onRangeSelect}
          onZoomOut={onZoomOut}
          tooltip={(frac) => {
            const samples = wearLaps.map((lap) => ({ lap, value: lap.tireWearTrace ? peak(lap.tireWearTrace, indexAtFrac(lap, frac)) * 100 : 0 }));
            if (tooltipMode === "per-lap") return <div className="space-y-0.5 font-mono tabular-nums"><ChartSpread values={samples.map((sample) => sample.value)} format={(value) => `${value.toFixed(1)}%`} />{samples.sort((a, b) => b.value - a.value).map(({ lap, value }) => <div key={lap.lapId}><span className={lap.lapId === primaryLapId ? "text-app-accent" : "text-app-text-muted"}>L{lap.lapNumber}</span>: {value.toFixed(1)}%</div>)}</div>;
            const sorted = samples.map(({ value }) => value).sort((a, b) => a - b);
            const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
            const primary = samples.find(({ lap }) => lap.lapId === primaryLapId)?.value;
            const stats: Array<readonly [string, number | undefined]> = [["max", sorted.at(-1)], ["median", median], ["min", sorted[0]]];
            stats.splice(primary == null ? 1 : primary >= median ? 1 : 2, 0, ["primary", primary]);
            return <div className="space-y-0.5 font-mono tabular-nums">{stats.map(([label, value]) => <div key={label} className={label === "primary" ? "text-app-accent" : "text-app-text-muted"}>{label}: <span className="text-app-text">{value == null ? "—" : `${value.toFixed(1)}%`}</span></div>)}</div>;
          }}
          series={lineSeries(wearLaps, (lap) => lap.tireWearTrace, primaryLapId).map((item) => ({ ...item, values: Float32Array.from(item.values, (value) => value * 100) }))}
        />
      ) : (
        <div className="text-app-text-dim text-sm">Tyre wear unavailable for this game/source.</div>
      )}
    </div>
  );
}

function fuelBurnRate(lap: TrackFocusTrace): Float32Array {
  const rate = new Float32Array(lap.fuel.length);
  const window = Math.max(1, Math.floor(lap.fuel.length / 50));
  for (let i = 0; i < lap.fuel.length; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(lap.fuel.length - 1, i + window);
    const distance = lap.frac[end] - lap.frac[start];
    const consumed = lap.fuel[start] - lap.fuel[end];
    rate[i] = distance > 0 && Number.isFinite(consumed) ? Math.max(0, consumed / distance) : 0;
  }
  return rate;
}

function fuelValue(value: number, unit: FuelPanelProps["fuelUnit"]): number {
  return unit === "fraction" ? value * 100 : value;
}

function fuelUnitLabel(unit: FuelPanelProps["fuelUnit"]): string {
  return unit === "fraction" ? "% tank/lap" : "L/lap";
}

export function FuelPanel({ traces, primaryLapId = null, cursorFrac = null, onCursorFrac = () => {}, visibleRange = null, onRangeSelect, onZoomOut, fuelUnit = "litre", tooltipMode = "per-lap" }: FuelPanelProps) {
  const laps = useMemo(() => panelTraces(traces), [traces]);
  const fuelLaps = laps.filter((lap) => Array.from(lap.fuel).filter((value) => Number.isFinite(value) && value >= 0).length >= 2 && lap.fuel.some((value) => Number.isFinite(value) && value > 0));
  const burnRateLaps = fuelLaps.map((lap) => ({ lap, values: fuelBurnRate(lap) }));
  const renderTooltip = (_frac: number, valueForLap: (lap: TrackFocusTrace) => number) => {
    const values = fuelLaps.map((lap) => ({ lap, value: fuelValue(valueForLap(lap), fuelUnit) })).filter(({ value }) => Number.isFinite(value));
    if (values.length === 0) return null;
    if (tooltipMode === "per-lap") {
      const descending = [...values].sort((a, b) => b.value - a.value);
      return (
        <div className="space-y-0.5 font-mono tabular-nums">
          <ChartSpread values={values.map((sample) => sample.value)} format={(value) => `${value.toFixed(2)} ${fuelUnit === "fraction" ? "%" : "L"}`} />
          {descending.map(({ lap, value }) => (
            <div key={lap.lapId} className="flex items-center gap-1.5 whitespace-nowrap">
              <span>{value.toFixed(2)} {fuelUnit === "fraction" ? "%" : "L"}</span>
            </div>
          ))}
        </div>
      );
    }
    const sorted = values.map(({ value }) => value).sort((a, b) => a - b);
    const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
    const primary = values.find(({ lap }) => lap.lapId === primaryLapId)?.value;
    const stats: Array<readonly [string, number | undefined]> = [
      ["max", sorted.at(-1)],
      ["median", median],
      ["min", sorted[0]],
    ];
    const insertAt = primary == null ? 1 : primary >= median ? 1 : 2;
    const summary = [...stats];
    summary.splice(insertAt, 0, ["primary", primary]);
    return (
      <div className="space-y-0.5 font-mono tabular-nums">
        {summary.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 whitespace-nowrap">
            <span className={label === "primary" ? "text-app-accent" : "text-app-text-muted"}>{label}</span>
            <span className="text-app-text">{value == null ? "—" : `${value.toFixed(2)} ${fuelUnit === "fraction" ? "%" : "L"}`}</span>
          </div>
        ))}
      </div>
    );
  };
  const burnRateMax = Math.max(0, ...burnRateLaps.flatMap(({ values }) => Array.from(values, (value) => fuelValue(value, fuelUnit))));
  return (
    <div className="space-y-3">
      {fuelLaps.length ? (
        <Lane
          title={`Fuel level (${fuelUnit === "fraction" ? "% tank" : "L"})`}
          domain={[0, fuelUnit === "fraction" ? 100 : Math.max(...fuelLaps.flatMap((lap) => Array.from(lap.fuel)))]}
          cursorFrac={cursorFrac}
          onCursorFrac={onCursorFrac}
          visibleRange={visibleRange}
          onRangeSelect={onRangeSelect}
          onZoomOut={onZoomOut}
          tooltip={(frac) => renderTooltip(frac, (lap) => lap.fuel[indexAtFrac(lap, frac)])}
          series={fuelLaps.map((lap) => ({
            x: lap.frac,
            values: fuelUnit === "fraction" ? Float32Array.from(lap.fuel, (value) => value * 100) : lap.fuel,
            color: lap.lapId === primaryLapId ? "var(--app-accent)" : "color-mix(in srgb, var(--app-text-dim) 35%, transparent)",
            width: lap.lapId === primaryLapId ? 1.8 : 1,
          }))}
        />
      ) : (
        <div className="text-app-text-dim text-sm">Fuel data unavailable for this session.</div>
      )}
      {burnRateLaps.length > 0 && (
        <Lane
          title={`Fuel burn rate (${fuelUnitLabel(fuelUnit)})`}
          domain={[0, Math.max(0.01, burnRateMax * 1.1)]}
          cursorFrac={cursorFrac}
          onCursorFrac={onCursorFrac}
          visibleRange={visibleRange}
          onRangeSelect={onRangeSelect}
          onZoomOut={onZoomOut}
          tooltip={(frac) => renderTooltip(frac, (lap) => burnRateLaps.find(({ lap: candidate }) => candidate.lapId === lap.lapId)?.values[indexAtFrac(lap, frac)] ?? 0)}
          series={burnRateLaps.map(({ lap, values }) => ({
            x: lap.frac,
            values: fuelUnit === "fraction" ? Float32Array.from(values, (value) => value * 100) : values,
            color: lap.lapId === primaryLapId ? "var(--app-accent)" : "color-mix(in srgb, var(--app-text-dim) 35%, transparent)",
            width: lap.lapId === primaryLapId ? 1.8 : 1,
          }))}
        />
      )}
      <div className="text-app-caption text-app-text-dim">
        Stint evolution:{" "}
        {laps.map((lap) => {
          const values = Array.from(lap.fuel).filter((value) => Number.isFinite(value) && value >= 0);
          const start = values[0];
          const end = values.at(-1);
          return (
            <span key={lap.lapId} className="block">
              Lap {lap.lapNumber}: Fuel start {start == null ? "—" : start.toFixed(2)} · Fuel used {start != null && end != null && start > end ? (start - end).toFixed(2) : "—"}
            </span>
          );
        })}
      </div>
    </div>
  );
}
