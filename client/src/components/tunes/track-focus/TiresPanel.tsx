import { useMemo, useState } from "react";
import { WHEEL_COLOR_VARS } from "@/lib/colors";
import { indexAtFrac, type LapTrace, type TireAverages, type TireTraces } from "../../../lib/stint-traces";
import { Lane, type AnnotationMarker, type LaneSeries } from "./Lane";
import { Button } from "../../ui/button";

interface TiresPanelProps {
  /** Traces in lap order (undefined entries = not loaded yet, skipped). */
  traces: (LapTrace | undefined)[];
  bestLapId?: number | null;
  cornerFracs?: number[];
  annotationMarkers?: AnnotationMarker[];
  cursorFrac?: number | null;
  onCursorFrac?: (f: number | null) => void;
  visibleRange?: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
}

const CORNERS: { key: keyof TireAverages; label: string; color: string }[] = [
  { key: "FL", label: "FL", color: WHEEL_COLOR_VARS[0] },
  { key: "FR", label: "FR", color: WHEEL_COLOR_VARS[1] },
  { key: "RL", label: "RL", color: WHEEL_COLOR_VARS[2] },
  { key: "RR", label: "RR", color: WHEEL_COLOR_VARS[3] },
];

const REF_LINES_TEMP = [80, 90, 100];

type Mode = "temp" | "pressure" | "brake";

interface MetricConfig {
  mode: Mode;
  title: string;
  avgUnit: string;
  laneUnit: string;
  defaultDomain: [number, number];
  /** Fixed y-domain for the avg chart (temp only); null = auto-fit. */
  fixedAvgDomain: [number, number] | null;
  refLines: number[] | null;
  pad: number;
  fmt: (v: number) => string;
}

const METRICS: MetricConfig[] = [
  {
    mode: "temp",
    title: "Tyres — peak temperature (°C)",
    avgUnit: "°C",
    laneUnit: "temp per lap (°C)",
    defaultDomain: [60, 120],
    fixedAvgDomain: null,
    refLines: REF_LINES_TEMP,
    pad: 2,
    fmt: (v) => `${v.toFixed(1)}°C`,
  },
  {
    mode: "pressure",
    title: "Tyres — peak pressure (bar)",
    avgUnit: "bar",
    laneUnit: "pressure per lap (bar)",
    defaultDomain: [1.5, 2.5],
    fixedAvgDomain: null,
    refLines: null,
    pad: 0.02,
    fmt: (v) => `${v.toFixed(2)} bar`,
  },
  {
    mode: "brake",
    title: "Brakes — peak brake temperature (°C)",
    avgUnit: "°C",
    laneUnit: "brake temp per lap (°C)",
    defaultDomain: [100, 600],
    fixedAvgDomain: null,
    refLines: null,
    pad: 2,
    fmt: (v) => `${v.toFixed(0)}°C`,
  },
];

function traceOf(t: LapTrace, mode: Mode): TireTraces | null {
  return mode === "temp" ? t.tireTempTrace : mode === "pressure" ? t.pressureTrace : t.brakeTempTrace;
}
function tracePeakAt(t: LapTrace, mode: Mode, i: number): number | null {
  const trace = traceOf(t, mode);
  if (!trace) return null;
  let peak = Number.NEGATIVE_INFINITY;
  for (const c of CORNERS) peak = Math.max(peak, trace[c.key][i] ?? Number.NEGATIVE_INFINITY);
  return Number.isFinite(peak) ? peak : null;
}



/**
 * Tyres tab: three always-visible metric sections (tyre temperature, tyre
 * pressure, brake temperature). Each shows a per-lap average chart at the top
 * (one line per corner, laps along x, with a dashed OLS trend line per corner
 * to read stint-wide heating/pressure drift), then one lane per corner with
 * every lap's per-distance trace — dim per lap, best lap in accent, invalid
 * laps in red, matching the Consistency tab's visual language.
 */
export function TiresPanel({ traces, bestLapId = null, cornerFracs = [], annotationMarkers, cursorFrac = null, onCursorFrac = () => {}, visibleRange = null, onRangeSelect, onZoomOut }: TiresPanelProps) {
  const laps = useMemo(() => traces.filter((t): t is LapTrace => !!t), [traces]);

  return (
    <div className="space-y-5">
      {METRICS.map((cfg) => (
        <TireMetricSection key={cfg.mode} cfg={cfg} laps={laps} bestLapId={bestLapId} cornerFracs={cornerFracs} annotationMarkers={annotationMarkers} cursorFrac={cursorFrac} onCursorFrac={onCursorFrac} visibleRange={visibleRange} onRangeSelect={onRangeSelect} onZoomOut={onZoomOut} />
      ))}
    </div>
  );
}

function TireMetricSection({
  cfg,
  laps,
  bestLapId,
  cornerFracs,
  annotationMarkers,
  cursorFrac,
  onCursorFrac,
  visibleRange,
  onRangeSelect,
  onZoomOut,
}: {
  cfg: MetricConfig;
  laps: LapTrace[];
  bestLapId: number | null;
  cornerFracs: number[];
  annotationMarkers?: AnnotationMarker[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
  visibleRange: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
}) {
  const { mode } = cfg;
  const [expanded, setExpanded] = useState(false);
  const domain = useMemo<[number, number]>(() => {
    if (cfg.fixedAvgDomain) return cfg.fixedAvgDomain;
    const all: number[] = [];
    for (const t of laps) {
      const trace = traceOf(t, mode);
      if (!trace) continue;
      for (const c of CORNERS) for (const value of trace[c.key]) if (Number.isFinite(value)) all.push(value);
    }
    if (all.length === 0) return cfg.defaultDomain;
    return [Math.min(...all) - cfg.pad, Math.max(...all) + cfg.pad];
  }, [laps, cfg, mode]);
  const laneDomain = useMemo<[number, number]>(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of laps) {
      const trace = traceOf(t, mode);
      if (!trace) continue;
      for (const c of CORNERS) for (const value of trace[c.key]) { lo = Math.min(lo, value); hi = Math.max(hi, value); }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return cfg.defaultDomain;
    const pad = Math.max(cfg.pad, (hi - lo) * 0.08);
    return [lo - pad, hi + pad];
  }, [laps, cfg, mode]);
  const lapsWithTrace = useMemo(() => laps.filter((t) => traceOf(t, mode)), [laps, mode]);
  const peakSeries = useMemo(
    () => lapsWithTrace.map((trace): LaneSeries => {
      const values = new Float32Array(trace.n);
      for (let index = 0; index < trace.n; index++) values[index] = tracePeakAt(trace, mode, index) ?? Number.NaN;
      return {
        x: trace.frac,
        values,
        color: trace.lapId === bestLapId ? "var(--app-accent)" : "color-mix(in srgb, var(--app-text-dim) 35%, transparent)",
        width: trace.lapId === bestLapId ? 1.8 : 1,
      };
    }),
    [bestLapId, lapsWithTrace, mode],
  );
  const wheelSeries = useMemo(
    () => Object.fromEntries(CORNERS.map((corner) => [
      corner.key,
      [
        ...lapsWithTrace
          .filter((trace) => trace.lapId !== bestLapId)
          .map((trace): LaneSeries => ({
            x: trace.frac,
            values: traceOf(trace, mode)![corner.key],
            color: trace.isValid ? "color-mix(in srgb, var(--app-text-dim) 35%, transparent)" : "color-mix(in srgb, var(--status-danger) 55%, transparent)",
          })),
        ...lapsWithTrace
          .filter((trace) => trace.lapId === bestLapId)
          .map((trace): LaneSeries => ({ x: trace.frac, values: traceOf(trace, mode)![corner.key], color: corner.color, width: 1.8 })),
      ],
    ])) as Record<keyof TireAverages, LaneSeries[]>,
    [bestLapId, lapsWithTrace, mode],
  );
  if (lapsWithTrace.length === 0) return null;

  return (
    <div className="relative space-y-2">
      <Lane
        title={cfg.title}
        height={100}
        domain={domain}
        visibleRange={visibleRange}
        onRangeSelect={onRangeSelect}
        onZoomOut={onZoomOut}
        annotationMarkers={annotationMarkers}
        cornerFracs={cornerFracs}
        cursorFrac={cursorFrac}
        onCursorFrac={onCursorFrac}
        tooltip={(f) => {
          const best = lapsWithTrace.find((t) => t.lapId === bestLapId) ?? lapsWithTrace[0];
          if (!best) return null;
          const value = tracePeakAt(best, mode, indexAtFrac(best, f));
          return <span>best lap peak: {value == null ? "—" : cfg.fmt(value)}</span>;
        }}
        series={peakSeries}
        bgFill="transparent"
      />
      {lapsWithTrace.length > 0 && (
        <Button variant="app-outline" size="app-sm" onClick={() => setExpanded((v) => !v)} className="flex items-center gap-1.5 uppercase tracking-wider text-app-text-dim hover:text-app-text">
          <span className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
          {expanded ? "Hide per-wheel detail" : "Show per-wheel detail"}
        </Button>
      )}
      {expanded &&
        lapsWithTrace.length > 0 &&
        CORNERS.map((c) => (
          <div key={c.key} className="space-y-1">
            <div className="flex items-center gap-2 text-app-caption uppercase tracking-wider text-app-text-dim">
              <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: c.color }} />
              {c.label} — {cfg.laneUnit}
            </div>
            <Lane
              height={80}
              domain={laneDomain}
              cornerFracs={cornerFracs}
              visibleRange={visibleRange}
              onRangeSelect={onRangeSelect}
              onZoomOut={onZoomOut}
              annotationMarkers={annotationMarkers}
              cursorFrac={cursorFrac}
              onCursorFrac={onCursorFrac}
              tooltip={(f) => {
                const best = lapsWithTrace.find((t) => t.lapId === bestLapId);
                const tt = best ? traceOf(best, mode) : null;
                if (!tt) return null;
                const idx = indexAtFrac(best!, f);
                return (
                  <span>
                    best lap {c.label}: {cfg.fmt(tt[c.key][idx])}
                  </span>
                );
              }}
              series={wheelSeries[c.key]}
            />
          </div>
        ))}
    </div>
  );
}
