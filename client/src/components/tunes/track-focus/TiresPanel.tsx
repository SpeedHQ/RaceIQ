import { useMemo, useState } from "react";
import type { TireAverages, TireTraces } from "../../../lib/stint-traces";
import { Lane, type AnnotationMarker, type LaneSeries } from "./Lane";
import type { TrackFocusTrace } from "./types";
import { Button } from "../../ui/button";

interface TiresPanelProps {
  traces: (TrackFocusTrace | undefined)[];
  bestLapId?: number | null;
  cornerFracs?: number[];
  annotationMarkers?: AnnotationMarker[];
  cursorFrac?: number | null;
  onCursorFrac?: (f: number | null) => void;
  visibleRange?: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
  fuelUnit?: "litre" | "fraction";
  tireWearContinuous?: boolean;
}

const WHEELS: (keyof TireAverages)[] = ["FL", "FR", "RL", "RR"];
const WHEEL_LABELS: Record<keyof TireAverages, string> = { FL: "Front left", FR: "Front right", RL: "Rear left", RR: "Rear right" };

function peak(trace: TireTraces | null, index: number): number {
  if (!trace) return Number.NaN;
  return Math.max(...WHEELS.map((wheel) => trace[wheel][index] ?? Number.NaN));
}

function peakSeries(laps: TrackFocusTrace[], getTrace: (lap: TrackFocusTrace) => TireTraces | null): LaneSeries[] {
  return laps.map((lap) => ({
    x: lap.frac,
    values: Float32Array.from({ length: lap.n }, (_, index) => peak(getTrace(lap), index)),
    color: "var(--app-accent)",
    width: lap.lapId === undefined ? 1 : 1.5,
  }));
}

function wheelSeries(laps: TrackFocusTrace[], getTrace: (lap: TrackFocusTrace) => TireTraces | null, wheel: keyof TireAverages): LaneSeries[] {
  return laps.map((lap) => ({
    x: lap.frac,
    values: getTrace(lap)?.[wheel] ?? new Float32Array(lap.n),
    color: "var(--app-accent)",
    width: lap.lapId === undefined ? 1 : 1.5,
  }));
}

function TireMetricSection({
  title,
  laps,
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
  if (available.length === 0) return null;
  const domain: [number, number] = [0, Math.max(1, ...available.flatMap((lap) => Array.from(getTrace(lap)!.FL)))];

  return (
    <div className="relative space-y-2">
      <Lane title={title} domain={domain} cornerFracs={cornerFracs} annotationMarkers={annotationMarkers} cursorFrac={cursorFrac} onCursorFrac={onCursorFrac} visibleRange={visibleRange} onRangeSelect={onRangeSelect} onZoomOut={onZoomOut} series={peakSeries(available, getTrace)} />
      <Button variant="app-outline" size="app-sm" onClick={() => setExpanded((value) => !value)} className="flex items-center gap-1.5 uppercase tracking-wider text-app-text-dim hover:text-app-text">
        <span className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
        {expanded ? "Hide per-wheel detail" : "Show per-wheel detail"}
      </Button>
      {expanded && WHEELS.map((wheel) => (
        <Lane key={wheel} title={WHEEL_LABELS[wheel]} domain={domain} cornerFracs={cornerFracs} annotationMarkers={annotationMarkers} cursorFrac={cursorFrac} onCursorFrac={onCursorFrac} visibleRange={visibleRange} onRangeSelect={onRangeSelect} onZoomOut={onZoomOut} series={wheelSeries(available, getTrace, wheel)} />
      ))}
    </div>
  );
}

export function TiresPanel({ traces, bestLapId = null, cornerFracs = [], annotationMarkers, cursorFrac = null, onCursorFrac = () => {}, visibleRange = null, onRangeSelect, onZoomOut, fuelUnit = "litre", tireWearContinuous = false }: TiresPanelProps) {
  const laps = useMemo(() => traces.filter((trace): trace is TrackFocusTrace => !!trace), [traces]);
  const metrics: Array<[string, (lap: TrackFocusTrace) => TireTraces | null]> = [
    ["Tyres — peak temperature (°C)", (lap) => lap.tireTempTrace],
    ["Tyres — peak pressure (bar)", (lap) => lap.pressureTrace],
    ["Brakes — peak brake temperature (°C)", (lap) => lap.brakeTempTrace],
  ];
  const fuelLaps = laps.filter((lap) => Array.from(lap.fuel).filter((value) => Number.isFinite(value) && value >= 0).length >= 2 && lap.fuel.some((value) => Number.isFinite(value) && value > 0));
  const wearLaps = laps.filter((lap) => lap.tireWearTrace != null);
  return (
    <div className="space-y-5">
      {metrics.map(([title, getTrace]) => <TireMetricSection key={title} title={title} laps={laps} getTrace={getTrace} cornerFracs={cornerFracs} annotationMarkers={annotationMarkers} cursorFrac={cursorFrac} onCursorFrac={onCursorFrac} visibleRange={visibleRange} onRangeSelect={onRangeSelect} onZoomOut={onZoomOut} />)}
      {tireWearContinuous && wearLaps.length ? <Lane title="Tyre wear (% worn)" domain={[0, 100]} cursorFrac={cursorFrac} onCursorFrac={onCursorFrac} series={peakSeries(wearLaps, (lap) => lap.tireWearTrace) .map((item) => ({ ...item, values: Float32Array.from(item.values, (value) => value * 100) }))} /> : <div className="text-app-text-dim text-sm">Tyre wear unavailable for this game/source.</div>}
      {fuelLaps.length ? <Lane title={`Fuel level (${fuelUnit === "fraction" ? "% tank" : "L"})`} domain={[0, fuelUnit === "fraction" ? 100 : Math.max(...fuelLaps.flatMap((lap) => Array.from(lap.fuel)))]} cursorFrac={cursorFrac} onCursorFrac={onCursorFrac} series={fuelLaps.map((lap) => ({ x: lap.frac, values: fuelUnit === "fraction" ? Float32Array.from(lap.fuel, (value) => value * 100) : lap.fuel, color: lap.lapId === bestLapId ? "var(--app-accent)" : "var(--app-text-dim)" }))} /> : <div className="text-app-text-dim text-sm">Fuel data unavailable for this session.</div>}
      <div className="text-app-caption text-app-text-dim">Stint evolution: {laps.map((lap) => { const values = Array.from(lap.fuel).filter((value) => Number.isFinite(value) && value >= 0); const start = values[0]; const end = values.at(-1); return <span key={lap.lapId} className="block">Lap {lap.lapNumber}: Fuel start {start == null ? "—" : start.toFixed(2)} · Fuel used {start != null && end != null && start > end ? (start - end).toFixed(2) : "—"}</span>; })}</div>
    </div>
  );
}
