import type { TrackCorner } from "../../../hooks/track-queries";
import { sampleAt, type LapTrace } from "../../../lib/stint-traces";
import type { TuneIssue } from "../../../../../shared/racing/tuning/issues";
import { Lane, type LaneSeries } from "./Lane";
import { buildCornerInputMetrics } from "./input-analysis";
import { ChartTooltip } from "./ChartTooltip";
import { nearestCornerLabel } from "./detect-corners";

export function BrakingPanel({
  traces,
  metricTraces = traces,
  bestLapId,
  corners,
  cornerFracs,
  nominalSpanMeters,
  issues,
  cursorFrac,
  onCursorFrac,
  visibleRange = null,
  onRangeSelect,
  onZoomOut,
}: {
  traces: LapTrace[];
  metricTraces?: LapTrace[];
  bestLapId: number | null;
  corners: TrackCorner[];
  cornerFracs: number[];
  nominalSpanMeters: number;
  issues: TuneIssue[];
  cursorFrac: number | null;
  onCursorFrac: (frac: number | null) => void;
  visibleRange?: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
}) {
  if (corners.length === 0) return <div className="text-app-text-dim text-sm">No braking segments available for this track.</div>;
  const metrics = buildCornerInputMetrics(metricTraces, bestLapId, corners, cornerFracs, nominalSpanMeters);
  const series = (channel: "brake" | "speedKmh"): LaneSeries[] =>
    traces.map((trace) => ({
      x: trace.frac,
      values: trace[channel],
      color: trace.lapId === bestLapId ? "var(--app-accent)" : "color-mix(in srgb, var(--app-text-dim) 35%, transparent)",
      width: trace.lapId === bestLapId ? 1.8 : 1,
    }));
  const markers = issues
    .filter((issue) => issue.kind === "brake-lockup" || issue.kind === "bottoming")
    .flatMap((issue) => (issue.distanceFrac == null ? [] : [{ frac: issue.distanceFrac, color: issue.severity === "critical" ? "var(--status-danger)" : "var(--status-warning)" }]));
  const tooltip = (channel: "brake" | "speedKmh") => (frac: number) => (
    <ChartTooltip
      frac={frac}
      cornerLabel={nearestCornerLabel(corners, cornerFracs, frac)}
      rows={traces.map((trace) => ({
        lapNumber: trace.lapNumber,
        color: trace.lapId === bestLapId ? "var(--app-accent)" : "var(--app-text-dim)",
        isBest: trace.lapId === bestLapId,
        isInvalid: !trace.isValid,
        speedKmh: channel === "speedKmh" ? sampleAt(trace, "speedKmh", frac) : null,
        brakePct: channel === "brake" ? sampleAt(trace, "brake", frac) * 100 : null,
      }))}
    />
  );
  const hoveredMetricIndex = cursorFrac == null ? -1 : metrics.findIndex((metric) => cursorFrac >= metric.corner.distanceStart && cursorFrac <= metric.corner.distanceEnd);
  return (
    <div className="space-y-3">
      <Lane
        title="Brake input"
        domain={[0, 1]}
        cornerFracs={cornerFracs}
        annotationMarkers={markers}
        cursorFrac={cursorFrac}
        onCursorFrac={onCursorFrac}
        visibleRange={visibleRange}
        onRangeSelect={onRangeSelect}
        onZoomOut={onZoomOut}
        tooltip={tooltip("brake")}
        series={series("brake")}
      />
      <Lane
        title="Speed under braking"
        domain={[0, Math.max(100, ...traces.flatMap((trace) => Array.from(trace.speedKmh)))]}
        cornerFracs={cornerFracs}
        annotationMarkers={markers}
        cursorFrac={cursorFrac}
        onCursorFrac={onCursorFrac}
        visibleRange={visibleRange}
        onRangeSelect={onRangeSelect}
        onZoomOut={onZoomOut}
        tooltip={tooltip("speedKmh")}
        series={series("speedKmh")}
      />
      <div className="rounded border border-app-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {["Segment", "Brake onset", "Peak input", "Brake release", "Braking distance", "Trail brake past apex", "Onset variation"].map((h) => (
                <th key={h} className="p-2 text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m, index) => (
              <tr
                key={m.corner.index}
                className={`border-t border-app-border cursor-pointer transition-colors ${index === hoveredMetricIndex ? "bg-app-accent/15" : "hover:bg-app-surface-hover"}`}
                onClick={() => onCursorFrac(m.brakeOnsetFrac ?? m.frac)}
              >
                <td className="p-2">{m.corner.label}</td>
                <td className="p-2">{m.brakeOnsetFrac == null ? "—" : `${(m.brakeOnsetFrac * 100).toFixed(1)}%`}</td>
                <td className="p-2">{m.peakBrakeInput == null ? "—" : `${(m.peakBrakeInput * 100).toFixed(0)}%`}</td>
                <td className="p-2">{m.brakeReleaseFrac == null ? "—" : `${(m.brakeReleaseFrac * 100).toFixed(1)}%`}</td>
                <td className="p-2">{m.brakingDistanceM == null ? "—" : `${m.brakingDistanceM.toFixed(1)} m`}</td>
                <td className="p-2">{m.trailBrakingDistanceM == null ? "—" : `${m.trailBrakingDistanceM.toFixed(1)} m`}</td>
                <td className="p-2">{m.brakeOnsetSpreadM == null ? "—" : `±${m.brakeOnsetSpreadM.toFixed(1)} m`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-app-caption text-app-text-dim">Trail brake past apex: distance braking remains active after apex.</p>
    </div>
  );
}
