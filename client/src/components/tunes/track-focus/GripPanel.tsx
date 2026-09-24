import { useMemo } from "react";
import type { ReactNode } from "react";
import type { TrackCorner } from "../../../hooks/track-queries";
import type { LapTrace } from "../../../lib/stint-traces";
import { ChartSpread, ChartTooltip, LapTooltip, type TooltipDisplayMode } from "./ChartTooltip";
import { nearestCornerLabel } from "./detect-corners";
import type { AnnotationMarker, LaneSeries } from "./Lane";
import { GgScatter } from "./GgScatter";
import { Lane } from "./Lane";

interface GripPanelProps {
  traces: LapTrace[];
  primaryLapId: number | null;
  cornerFracs: number[];
  corners?: TrackCorner[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
  annotationMarkers?: AnnotationMarker[];
  visibleRange?: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
  tooltipMode?: TooltipDisplayMode;
}


/** Linear-interpolate an arbitrary per-frame value series at fraction `f`,
 *  using the trace's own (monotonic, unevenly-spaced) `frac` bins. */
function valueAt(t: LapTrace, arr: Float32Array, f: number): number {
  const fr = t.frac;
  const n = arr.length;
  if (n === 0) return 0;
  if (n === 1) return arr[0];
  const target = Math.max(0, Math.min(1, f));
  if (target <= fr[0]) return arr[0];
  if (target >= fr[n - 1]) return arr[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = fr[hi] - fr[lo];
  const t2 = span > 0 ? (target - fr[lo]) / span : 0;
  return arr[lo] + (arr[hi] - arr[lo]) * t2;
}

function gDomain(traces: LapTrace[], sel: (t: LapTrace) => Float32Array | null): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const t of traces) {
    const arr = sel(t);
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < min) min = arr[i];
      if (arr[i] > max) max = arr[i];
    }
  }
  if (!Number.isFinite(min)) return [-2, 2];
  const pad = Math.max(0.2, (max - min) * 0.1);
  return [min - pad, max + pad];
}
function gTooltip(traces: LapTrace[], primaryLapId: number | null, frac: number, getValue: (trace: LapTrace, frac: number) => number, mode: TooltipDisplayMode, unit: string): ReactNode {
  const samples = traces.map((lap) => ({ id: lap.lapId, label: `L${lap.lapNumber}`, value: getValue(lap, frac) }));
  return <><ChartSpread values={samples.map((sample) => sample.value)} format={(value) => `${value.toFixed(2)}${unit ? ` ${unit}` : ""}`} /><LapTooltip samples={samples} primaryId={primaryLapId} mode={mode} format={(value) => `${value.toFixed(2)}${unit ? ` ${unit}` : ""}`} /></>;
}

/**
 * Grip tab: latG + longG lanes (track position) and the G-G friction-circle
 * scatter. Every lap stays visible; primary lap receives accent treatment.
 */
export function GripPanel({ traces, primaryLapId, cornerFracs, corners = [], annotationMarkers, cursorFrac, onCursorFrac, visibleRange = null, onRangeSelect, onZoomOut, tooltipMode = "per-lap" }: GripPanelProps) {
  const withLatG = useMemo(() => traces.filter((t) => t.latG != null), [traces]);
  const withLongG = useMemo(() => traces.filter((t) => t.longG != null), [traces]);

  const bestLatG = withLatG.find((t) => t.lapId === primaryLapId) ?? null;
  const bestLongG = withLongG.find((t) => t.lapId === primaryLapId) ?? null;

  const latDomain = useMemo(() => gDomain(withLatG, (t) => t.latG), [withLatG]);
  const longDomain = useMemo(() => gDomain(withLongG, (t) => t.longG), [withLongG]);

  const lapSeries = (available: LapTrace[], best: LapTrace | null, values: (trace: LapTrace) => Float32Array): LaneSeries[] => [
    ...available
      .filter((trace) => trace.lapId !== primaryLapId)
      .map((trace) => ({
        x: trace.frac,
        values: values(trace),
        color: trace.isValid ? "color-mix(in srgb, var(--app-text-dim) 35%, transparent)" : "color-mix(in srgb, var(--status-danger) 55%, transparent)",
      })),
    ...(best ? [{ x: best.frac, values: values(best), color: "var(--app-accent)", width: 1.8 }] : []),
  ];
  const latSeries = useMemo(() => lapSeries(withLatG, bestLatG, (trace) => trace.latG!), [primaryLapId, bestLatG, withLatG]);
  const longSeries = useMemo(() => lapSeries(withLongG, bestLongG, (trace) => trace.longG!), [primaryLapId, bestLongG, withLongG]);

  return (
    <div className="space-y-3">
      {withLatG.length === 0 ? (
        <div>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Lateral g</div>
          <div className="h-[100px] flex items-center justify-center rounded bg-app-surface border border-app-border text-app-compact text-app-text-dim">No acceleration data for this game</div>
        </div>
      ) : (
        <div>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Lateral g</div>
          <Lane
            bgFill="transparent"
            visibleRange={visibleRange}
            onRangeSelect={onRangeSelect}
            onZoomOut={onZoomOut}
            height={100}
            domain={latDomain}
            cornerFracs={cornerFracs}
            annotationMarkers={annotationMarkers}
            cursorFrac={cursorFrac}
            onCursorFrac={onCursorFrac}
            series={latSeries}
            tooltip={(f) => (
              <div className="space-y-1">
                <ChartTooltip frac={f} cornerLabel={nearestCornerLabel(corners, cornerFracs, f)} rows={[]} />
                {gTooltip(withLatG, primaryLapId, f, (trace, frac) => valueAt(trace, trace.latG!, frac), tooltipMode, "g")}
              </div>
            )}
          />
        </div>
      )}

      {withLongG.length === 0 ? (
        <div>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Longitudinal g</div>
          <div className="h-[100px] flex items-center justify-center rounded bg-app-surface border border-app-border text-app-compact text-app-text-dim">No acceleration data for this game</div>
        </div>
      ) : (
        <div>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Longitudinal g (+ accel / − brake)</div>
          <Lane
            bgFill="transparent"
            visibleRange={visibleRange}
            onRangeSelect={onRangeSelect}
            onZoomOut={onZoomOut}
            height={100}
            domain={longDomain}
            cornerFracs={cornerFracs}
            annotationMarkers={annotationMarkers}
            cursorFrac={cursorFrac}
            onCursorFrac={onCursorFrac}
            series={longSeries}
            tooltip={(f) => (
              <div className="space-y-1">
                <ChartTooltip frac={f} cornerLabel={nearestCornerLabel(corners, cornerFracs, f)} rows={[]} />
                {gTooltip(withLongG, primaryLapId, f, (trace, frac) => valueAt(trace, trace.longG!, frac), tooltipMode, "g")}
              </div>
            )}
          />
        </div>
      )}


      <GgScatter traces={traces} primaryLapId={primaryLapId} cursorFrac={cursorFrac} />
    </div>
  );
}
