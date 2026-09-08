import { useMemo } from "react";
import type { LineSpreadTrace } from "@/hooks/experiments";
import type { TrackCorner } from "@/hooks/track-queries";
import { severityColor, severityRangeColor } from "@/lib/colors";
import type { TuneIssue } from "../../../../../shared/racing/tuning/issues";
import { consistencyAt, type LapTrace, sampleAt } from "../../../lib/stint-traces";
import { ChartTooltip } from "./ChartTooltip";
import { nearestCornerLabel } from "./detect-corners";
import { Lane, type LaneSegment, type LaneSeries } from "./Lane";

interface ConsistencyLanesProps {
  traces: LapTrace[];
  bestLapId: number | null;
  cornerFracs: number[];
  corners?: TrackCorner[];
  issues: TuneIssue[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
  /** Null means no valid resampled laps were available. */
  lineSpread?: LineSpreadTrace | null;
  /** Fires true when the cursor enters a lane that drives the track zoom (brake,
   *  throttle, speed, race-line spread), false on leave. Steer and Δ-time do not. */
  onZoomHover?: (active: boolean) => void;
  visibleRange?: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;

}
// Same threshold as server/lap-analysis/consistency.ts LINE_SPREAD_THRESHOLD_M.
const LINE_SPREAD_THRESHOLD_M = 1.5;

function spreadColor(spreadM: number): string {
  return spreadM < LINE_SPREAD_THRESHOLD_M ? severityColor(0) : spreadM < LINE_SPREAD_THRESHOLD_M * 2 ? severityColor(1) : severityColor(3);
}

/** Same theme-owned severity banding as the lap-time consistency readout. */
function scoreColor(score: number): string {
  return severityRangeColor(100 - score, [20, 40]);
}


function spreadSegments(trace: LineSpreadTrace): LaneSegment[] {
  const segments: LaneSegment[] = [];
  const thresholds = [LINE_SPREAD_THRESHOLD_M, LINE_SPREAD_THRESHOLD_M * 2];
  for (let index = 1; index < trace.fracs.length; index++) {
    const f0 = trace.fracs[index - 1];
    const f1 = trace.fracs[index];
    const v0 = trace.spreadM[index - 1];
    const v1 = trace.spreadM[index];
    const cuts = [0, ...thresholds.flatMap((threshold) => {
      const t = (threshold - v0) / (v1 - v0);
      return t > 0 && t < 1 ? [t] : [];
    }), 1].sort((a, b) => a - b);
    for (let cut = 1; cut < cuts.length; cut++) {
      const t0 = cuts[cut - 1];
      const t1 = cuts[cut];
      const a = v0 + (v1 - v0) * t0;
      const b = v0 + (v1 - v0) * t1;
      segments.push({ x1: f0 + (f1 - f0) * t0, y1: a, x2: f0 + (f1 - f0) * t1, y2: b, color: spreadColor((a + b) / 2), width: 1.8, opacity: 0.9 });
    }
  }
  return segments;
}

/** Linear-interpolate `spreadM` at fraction `f` along the trace's own fracs array. */
function spreadValueAt(trace: LineSpreadTrace, f: number): number {
  const { fracs, spreadM } = trace;
  const n = fracs.length;
  if (n === 0) return 0;
  if (n === 1 || f <= fracs[0]) return spreadM[0];
  if (f >= fracs[n - 1]) return spreadM[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fracs[mid] <= f) lo = mid;
    else hi = mid;
  }
  const span = fracs[hi] - fracs[lo];
  if (span <= 0) return spreadM[lo];
  const t = (f - fracs[lo]) / span;
  return spreadM[lo] + (spreadM[hi] - spreadM[lo]) * t;
}

const CHANNELS = [
  { key: "steer" as const, label: "Steering", domain: [-1.05, 1.05] as [number, number], color: "var(--ch-steer)", issueKinds: new Set(["oversteer", "understeer"]) },
  { key: "brake" as const, label: "Brake", domain: [0, 1.05] as [number, number], color: "var(--ch-brake)", issueKinds: new Set(["brake-lockup", "bottoming"]) },
  { key: "throttle" as const, label: "Throttle", domain: [0, 1.05] as [number, number], color: "var(--ch-throttle)", issueKinds: new Set<string>() },
];


/**
 * Input-consistency lanes (steer/brake/throttle) — every lap drawn dim, the
 * stint's best (fastest, scored) lap in accent. Invalid laps are excluded
 * upstream (TrackFocusView filters them out). Issue
 * ticks appear along the top edge of the matching channel's lane. Hovering
 * anywhere reports a point consistency score + gap-vs-best for that channel.
 */
export function ConsistencyLanes({ traces, bestLapId, cornerFracs, corners = [], issues, cursorFrac, onCursorFrac, lineSpread, onZoomHover, visibleRange, onRangeSelect, onZoomOut }: ConsistencyLanesProps) {
  // Wrap onCursorFrac so a lane that drives the zoom also toggles zoomActive.
  const zoomCursor = (f: number | null) => {
    onCursorFrac(f);
    onZoomHover?.(f != null);
  };
  const bestTrace = useMemo(() => traces.find((t) => t.lapId === bestLapId) ?? null, [traces, bestLapId]);

  // Speed domain across every lap so all traces share one scale.
  const speedDomain = useMemo<[number, number]>(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const t of traces) {
      for (let i = 0; i < t.n; i++) {
        const v = t.speedKmh[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min)) return [0, 300];
    return [Math.max(0, min - 10), max + 10];
  }, [traces]);

  // Cumulative time delta vs best for every lap (best is the zero line).
  const deltas = useMemo(() => {
    if (!bestTrace) return new Map<number, Float32Array>();
    const out = new Map<number, Float32Array>();
    for (const t of traces) {
      if (t.lapId === bestTrace.lapId) continue;
      // Raw-frame traces differ in length/spacing — sample best at each of
      // this lap's own frame fractions.
      const d = new Float32Array(t.n);
      for (let i = 0; i < t.n; i++) d[i] = t.timeS[i] - sampleAt(bestTrace, "timeS", t.frac[i]);
      out.set(t.lapId, d);
    }
    return out;
  }, [traces, bestTrace]);

  const deltaDomain = useMemo<[number, number]>(() => {
    let max = 0;
    for (const d of deltas.values()) {
      for (const v of d) max = Math.max(max, Math.abs(v));
    }
    if (max === 0) return [-0.5, 0.5];
    const pad = Math.max(0.1, max * 0.15);
    return [-max - pad, max + pad];
  }, [deltas]);

  const hasLineSpread = !!lineSpread && lineSpread.spreadM.length > 0;
  const spreadDomain = useMemo<[number, number]>(() => {
    if (!hasLineSpread) return [0, LINE_SPREAD_THRESHOLD_M * 2];
    const max = Math.max(...lineSpread!.spreadM, LINE_SPREAD_THRESHOLD_M);
    return [0, max * 1.15];
  }, [hasLineSpread, lineSpread]);
  const issueMarkers = useMemo(() => {
    const seen = new Set<number>();
    return issues.flatMap((issue) => {
      if (issue.distanceFrac == null || seen.has(issue.distanceFrac)) return [];
      seen.add(issue.distanceFrac);
      const color = issue.severity === "critical" ? "var(--status-danger)" : issue.severity === "warn" ? "var(--status-warning)" : "var(--status-info)";
      return [{ frac: issue.distanceFrac, color }];
    });
  }, [issues]);
  const channelSeries = useMemo(
    () => Object.fromEntries(CHANNELS.map((channel) => [
      channel.key,
      [
        ...traces
          .filter((trace) => trace.lapId !== bestLapId)
          .map((trace): LaneSeries => ({
            x: trace.frac,
            values: trace[channel.key],
            color: trace.isValid ? "color-mix(in srgb, var(--app-text-dim) 35%, transparent)" : "color-mix(in srgb, var(--status-danger) 55%, transparent)",
          })),
        ...(bestTrace ? [{ x: bestTrace.frac, values: bestTrace[channel.key], color: "var(--app-accent)", width: 1.8 }] : []),
      ],
    ])) as Record<(typeof CHANNELS)[number]["key"], LaneSeries[]>,
    [bestLapId, bestTrace, traces],
  );
  const speedSeries = useMemo(
    () => [
      ...traces
        .filter((trace) => trace.lapId !== bestLapId)
        .map((trace): LaneSeries => ({
          x: trace.frac,
          values: trace.speedKmh,
          color: trace.isValid ? "color-mix(in srgb, var(--app-text-dim) 35%, transparent)" : "color-mix(in srgb, var(--status-danger) 55%, transparent)",
        })),
      ...(bestTrace ? [{ x: bestTrace.frac, values: bestTrace.speedKmh, color: "var(--app-accent)", width: 1.8 }] : []),
    ],
    [bestLapId, bestTrace, traces],
  );
  const deltaSeries = useMemo(
    () => traces
      .filter((trace) => deltas.has(trace.lapId))
      .map((trace): LaneSeries => ({
        x: trace.frac,
        values: deltas.get(trace.lapId)!,
        color: trace.isValid ? "color-mix(in srgb, var(--delta-focus) 50%, transparent)" : "color-mix(in srgb, var(--status-danger) 55%, transparent)",
      })),
    [deltas, traces],
  );
  const spreadLaneSegments = useMemo(() => lineSpread ? spreadSegments(lineSpread) : [], [lineSpread]);
  const spreadSeries = useMemo<LaneSeries[]>(
    () => lineSpread ? [{ x: lineSpread.fracs, values: lineSpread.spreadM, color: "transparent" }] : [],
    [lineSpread],
  );

  return (
    <div className="space-y-3">
      {CHANNELS.map((ch) => {
        return (
          <div key={ch.key}>
            <Lane title={ch.label}
              bgFill="transparent"
              height={100}
              domain={ch.domain}
              visibleRange={visibleRange}
              onRangeSelect={onRangeSelect}
              onZoomOut={onZoomOut}
              cornerFracs={cornerFracs}
              cursorFrac={cursorFrac}
              onCursorFrac={ch.key === "brake" || ch.key === "throttle" ? zoomCursor : onCursorFrac}
              annotationMarkers={issueMarkers}
              series={channelSeries[ch.key]}
              tooltip={(f) => {
                const score = consistencyAt(traces, f, ch.key);
                const scoreColorValue = score == null ? "var(--app-text-dim)" : scoreColor(score);
                const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
                // Overview only — per-lap rows are noise here (the lanes
                // themselves already show every lap's trace). Aggregate the
                // valid laps at this fraction instead.
                const valid = traces.filter((t) => t.isValid);
                let worstDelta: number | null = null;
                if (bestTrace) {
                  for (const t of valid) {
                    if (t.lapId === bestTrace.lapId) continue;
                    const d = sampleAt(t, "timeS", f) - sampleAt(bestTrace, "timeS", f);
                    if (worstDelta == null || d > worstDelta) worstDelta = d;
                  }
                }
                let minSpeed = Number.POSITIVE_INFINITY;
                let maxSpeed = Number.NEGATIVE_INFINITY;
                for (const t of valid) {
                  const v = sampleAt(t, "speedKmh", f);
                  if (v < minSpeed) minSpeed = v;
                  if (v > maxSpeed) maxSpeed = v;
                }
                const hasSpeed = Number.isFinite(minSpeed) && Number.isFinite(maxSpeed);
                return (
                  <div className="space-y-1">
                    <ChartTooltip frac={f} cornerLabel={cornerLabel} rows={[]} />
                    <div className="font-mono tabular-nums text-app-text-dim space-y-0.5">
                      <div>
                        consistency: <span style={{ color: scoreColorValue }}>{score == null ? "—" : score.toFixed(0)}</span>
                      </div>
                      <div>
                        Δ worst:{" "}
                        <span style={{ color: worstDelta != null && worstDelta > 0 ? "var(--delta-loss)" : "var(--delta-gain)" }}>
                          {worstDelta != null ? `${worstDelta >= 0 ? "+" : ""}${worstDelta.toFixed(3)}s` : "—"}
                        </span>
                      </div>
                      <div>
                        speed: <span className="text-app-text-muted">{hasSpeed ? `${minSpeed.toFixed(0)}–${maxSpeed.toFixed(0)}km/h` : "—"}</span>
                      </div>
                    </div>
                  </div>
                );
              }}
            />
          </div>
        );
      })}
      <div>
        <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Speed (km/h)</div>
        <Lane
          bgFill="transparent"
          height={120}
          domain={speedDomain}
          annotationMarkers={issueMarkers}
          visibleRange={visibleRange}
          onRangeSelect={onRangeSelect}
          onZoomOut={onZoomOut}
          cornerFracs={cornerFracs}
          cursorFrac={cursorFrac}
          onCursorFrac={zoomCursor}
          series={speedSeries}
          tooltip={
            traces.length > 0
              ? (f) => {
                  const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
                  const valid = traces.filter((t) => t.isValid);
                  let minSpeed = Number.POSITIVE_INFINITY;
                  let maxSpeed = Number.NEGATIVE_INFINITY;
                  for (const t of valid) {
                    const v = sampleAt(t, "speedKmh", f);
                    if (v < minSpeed) minSpeed = v;
                    if (v > maxSpeed) maxSpeed = v;
                  }
                  const hasSpeed = Number.isFinite(minSpeed) && Number.isFinite(maxSpeed);
                  const bestSpeed = bestTrace ? sampleAt(bestTrace, "speedKmh", f) : null;
                  return (
                    <div className="space-y-1">
                      <ChartTooltip frac={f} cornerLabel={cornerLabel} rows={[]} />
                      <div className="font-mono tabular-nums text-app-text-dim space-y-0.5">
                        <div>
                          primary: <span className="text-app-accent">{bestSpeed != null ? `${bestSpeed.toFixed(0)}km/h` : "—"}</span>
                        </div>
                        <div>
                          spread: <span className="text-app-text-muted">{hasSpeed ? `${minSpeed.toFixed(0)}–${maxSpeed.toFixed(0)}km/h` : "—"}</span>
                        </div>
                      </div>
                    </div>
                  );
                }
              : undefined
          }
        />
      </div>
      <div>
      <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Δ time vs primary (s, cumulative)</div>
        <Lane
          bgFill="transparent"
          height={100}
          domain={deltaDomain}
          cornerFracs={cornerFracs}
          cursorFrac={cursorFrac}
          annotationMarkers={issueMarkers}
          onCursorFrac={onCursorFrac}
          visibleRange={visibleRange}
          onRangeSelect={onRangeSelect}
          onZoomOut={onZoomOut}
          series={deltaSeries}
          horizontalLines={[{ value: 0, color: "var(--app-accent)", width: 1, opacity: 0.6, dash: [4, 3] }]}
          tooltip={(f) => {
            const withDelta = traces.filter((t) => deltas.has(t.lapId) && t.isValid);
            if (withDelta.length === 0 || !bestTrace) return null;
            const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
            const bestT = sampleAt(bestTrace, "timeS", f);
            let worst: number | null = null;
            let sum = 0;
            for (const t of withDelta) {
              const d = sampleAt(t, "timeS", f) - bestT;
              if (worst == null || d > worst) worst = d;
              sum += d;
            }
            const avg = sum / withDelta.length;
            return (
              <div className="space-y-1">
                <ChartTooltip frac={f} cornerLabel={cornerLabel} rows={[]} />
                <div className="font-mono tabular-nums text-app-text-dim space-y-0.5">
                  <div>
                    Δ worst:{" "}
                    <span style={{ color: worst != null && worst > 0 ? "var(--delta-loss)" : "var(--delta-gain)" }}>{worst != null ? `${worst >= 0 ? "+" : ""}${worst.toFixed(3)}s` : "—"}</span>
                  </div>
                  <div>
                    Δ avg: <span style={{ color: avg > 0 ? "var(--delta-loss)" : "var(--delta-gain)" }}>{`${avg >= 0 ? "+" : ""}${avg.toFixed(3)}s`}</span>
                  </div>
                </div>
              </div>
            );
          }}
        />
      </div>
      <div>
        <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
          Race line spread (m)
          {hasLineSpread && (
            <span
              className="font-mono tabular-nums normal-case tracking-normal"
              style={{ color: scoreColor(lineSpread!.consistencyScore) }}
              title={`Racing-line consistency — 100 = laps trace the same line. Mean spread ${lineSpread!.overallSpreadM.toFixed(2)}m over ${lineSpread!.lapCount} clean laps.`}
            >
              {lineSpread!.consistencyScore}% consistent
            </span>
          )}
          {hasLineSpread && lineSpread!.lowTrust && (
            <span
              className="px-1 py-px rounded text-app-micro font-normal normal-case tracking-normal bg-app-surface-alt border border-app-border text-app-text-dim"
              title={`Average racing-line spread exceeds ${LINE_SPREAD_THRESHOLD_M}m — the line varies notably lap-to-lap.`}
            >
              inconsistent line
            </span>
          )}
        </div>
        {hasLineSpread ? (
          <Lane
            bgFill="transparent"
            height={90}
            domain={spreadDomain}
            cornerFracs={cornerFracs}
            cursorFrac={cursorFrac}
            visibleRange={visibleRange}
            onRangeSelect={onRangeSelect}
            onZoomOut={onZoomOut}
            annotationMarkers={issueMarkers}
            onCursorFrac={zoomCursor}
            series={spreadSeries}
            segments={spreadLaneSegments}
            horizontalLines={[
              { value: LINE_SPREAD_THRESHOLD_M, color: severityColor(1), opacity: 0.6, dash: [4, 3] },
              { value: LINE_SPREAD_THRESHOLD_M * 2, color: severityColor(3), opacity: 0.6, dash: [4, 3] },
            ]}
            tooltip={(f) => {
              const spreadM = spreadValueAt(lineSpread!, f);
              return (
                <div className="space-y-1">
                  <div className="font-mono tabular-nums text-app-text-dim space-y-0.5">
                    <div>
                      spread: <span style={{ color: spreadColor(spreadM) }}>{spreadM.toFixed(2)}m</span>
                    </div>
                    <div className="text-app-text-dim">over {lineSpread!.lapCount} clean laps</div>
                  </div>
                </div>
              );
            }}
          />
        ) : (
          <div className="h-[90px] flex items-center justify-center rounded bg-app-surface border border-app-border text-app-compact text-app-text-dim">No race line data</div>
        )}
      </div>
    </div>
  );
}
