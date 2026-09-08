import { useMemo, useState } from "react";
import { indexAtFrac, type TireAverages, type TireTraces } from "../../../lib/stint-traces";
import { Lane, type AnnotationMarker, type LaneSeries } from "./Lane";
import type { TrackFocusTrace } from "./types";
import { ChartTooltip } from "./ChartTooltip";
import { Button } from "../../ui/button";

interface SharedPanelProps {
  traces: (TrackFocusTrace | undefined)[];
  bestLapId?: number | null;
  cornerFracs?: number[];
  annotationMarkers?: AnnotationMarker[];
  cursorFrac?: number | null;
  onCursorFrac?: (f: number | null) => void;
  visibleRange?: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
}

interface TiresPanelProps extends SharedPanelProps {
  tireWearContinuous?: boolean;
}

interface FuelPanelProps extends SharedPanelProps {
  fuelUnit?: "litre" | "fraction";
}

const WHEELS: (keyof TireAverages)[] = ["FL", "FR", "RL", "RR"];
const WHEEL_LABELS: Record<keyof TireAverages, string> = { FL: "Front left", FR: "Front right", RL: "Rear left", RR: "Rear right" };

function peak(trace: TireTraces | null, index: number): number {
  if (!trace) return Number.NaN;
  return Math.max(...WHEELS.map((wheel) => trace[wheel][index] ?? Number.NaN));
}

function lineSeries(laps: TrackFocusTrace[], getTrace: (lap: TrackFocusTrace) => TireTraces | null, bestLapId: number | null, wheel?: keyof TireAverages): LaneSeries[] {
  return laps.map((lap) => ({
    x: lap.frac,
    values: wheel ? (getTrace(lap)?.[wheel] ?? new Float32Array(lap.n)) : Float32Array.from({ length: lap.n }, (_, index) => peak(getTrace(lap), index)),
    color: lap.lapId === bestLapId ? "var(--app-accent)" : "color-mix(in srgb, var(--app-text-dim) 35%, transparent)",
    width: lap.lapId === bestLapId ? 1.8 : 1,
  }));
}

function TireMetricSection({
  title,
  laps,
  bestLapId,
  getTrace,
  cornerFracs,
  annotationMarkers,
  cursorFrac,
  onCursorFrac,
  visibleRange,
  onRangeSelect,
  onZoomOut,
}: {
  title: string;
  laps: TrackFocusTrace[];
  bestLapId: number | null;
  getTrace: (lap: TrackFocusTrace) => TireTraces | null;
  cornerFracs: number[];
  annotationMarkers?: AnnotationMarker[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
  visibleRange: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const available = useMemo(() => laps.filter((lap) => getTrace(lap)), [getTrace, laps]);
  if (!available.length) return null;
  const domain: [number, number] = [0, Math.max(1, ...available.flatMap((lap) => Array.from(getTrace(lap)!.FL)))];
  const best = available.find((lap) => lap.lapId === bestLapId) ?? available[0];
  const tooltip = (wheel?: keyof TireAverages) => (frac: number) => {
    const trace = getTrace(best);
    if (!trace) return null;
    const index = indexAtFrac(best, frac);
    const value = wheel ? trace[wheel][index] : peak(trace, index);
    return (
      <div className="space-y-1">
        <ChartTooltip frac={frac} rows={[]} />
        <div className="font-mono tabular-nums text-app-text-dim">
          {wheel ? WHEEL_LABELS[wheel] : "Peak"}: {Number.isFinite(value) ? value.toFixed(1) : "—"}
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
        series={lineSeries(available, getTrace, bestLapId)}
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
            series={lineSeries(available, getTrace, bestLapId, wheel)}
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
  bestLapId = null,
  cornerFracs = [],
  annotationMarkers,
  cursorFrac = null,
  onCursorFrac = () => {},
  visibleRange = null,
  onRangeSelect,
  onZoomOut,
  tireWearContinuous = false,
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
          bestLapId={bestLapId}
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
          series={lineSeries(wearLaps, (lap) => lap.tireWearTrace, bestLapId).map((item) => ({ ...item, values: Float32Array.from(item.values, (value) => value * 100) }))}
        />
      ) : (
        <div className="text-app-text-dim text-sm">Tyre wear unavailable for this game/source.</div>
      )}
    </div>
  );
}

export function FuelPanel({ traces, bestLapId = null, cursorFrac = null, onCursorFrac = () => {}, visibleRange = null, onRangeSelect, onZoomOut, fuelUnit = "litre" }: FuelPanelProps) {
  const laps = useMemo(() => panelTraces(traces), [traces]);
  const fuelLaps = laps.filter((lap) => Array.from(lap.fuel).filter((value) => Number.isFinite(value) && value >= 0).length >= 2 && lap.fuel.some((value) => Number.isFinite(value) && value > 0));
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
          series={fuelLaps.map((lap) => ({
            x: lap.frac,
            values: fuelUnit === "fraction" ? Float32Array.from(lap.fuel, (value) => value * 100) : lap.fuel,
            color: lap.lapId === bestLapId ? "var(--app-accent)" : "color-mix(in srgb, var(--app-text-dim) 35%, transparent)",
            width: lap.lapId === bestLapId ? 1.8 : 1,
          }))}
        />
      ) : (
        <div className="text-app-text-dim text-sm">Fuel data unavailable for this session.</div>
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
