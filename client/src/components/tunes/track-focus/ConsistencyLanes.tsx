import type { TuneIssue } from "@shared/types";
import { useMemo } from "react";
import type { LineSpreadTrace, TrackCorner } from "../../../hooks/queries";
import { consistencyAt, type LapTrace, sampleAt } from "../../../lib/stint-traces";
import { ChartTooltip } from "./ChartTooltip";
import { nearestCornerLabel } from "./detect-corners";
import { Lane } from "./Lane";

interface ConsistencyLanesProps {
  traces: LapTrace[];
  bestLapId: number | null;
  cornerFracs: number[];
  corners?: TrackCorner[];
  issues: TuneIssue[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
  /** Trimmed racing-line spread trace (null = loading / no session / too few
   *  clean laps — the lane shows a "need 3+ laps" note instead). */
  lineSpread?: LineSpreadTrace | null;
  /** Fires true when the cursor enters a lane that drives the track zoom (brake,
   *  throttle, speed, race-line spread), false on leave. Steer and Δ-time do not. */
  onZoomHover?: (active: boolean) => void;
}

// Same threshold as server/lap-consistency.ts LINE_SPREAD_THRESHOLD_M.
const LINE_SPREAD_THRESHOLD_M = 1.5;

function spreadColor(spreadM: number): string {
  if (spreadM > LINE_SPREAD_THRESHOLD_M * 2) return "var(--color-dynamics-red, #ef4444)";
  if (spreadM > LINE_SPREAD_THRESHOLD_M) return "var(--color-dynamics-amber, #f59e0b)";
  return "var(--color-dynamics-green, #34d399)";
}

/** Same green/amber/red banding as the lap-time consistency readout. */
function scoreColor(score: number): string {
  if (score > 80) return "var(--color-dynamics-green, #34d399)";
  if (score > 60) return "var(--color-dynamics-amber, #f59e0b)";
  return "var(--color-dynamics-red, #ef4444)";
}

function spreadPolyline(trace: LineSpreadTrace, x: (f: number) => number, y: (v: number) => number): string {
  let s = "";
  for (let i = 0; i < trace.fracs.length; i++) {
    s += `${i ? " " : ""}${x(trace.fracs[i]).toFixed(1)},${y(trace.spreadM[i]).toFixed(1)}`;
  }
  return s;
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
  { key: "steer" as const, label: "Steering", domain: [-1.05, 1.05] as [number, number], color: "var(--color-ch-steer, #0891b2)", issueKinds: new Set(["oversteer", "understeer"]) },
  { key: "brake" as const, label: "Brake", domain: [0, 1.05] as [number, number], color: "var(--color-ch-brake, #ef4444)", issueKinds: new Set(["brake-lockup", "bottoming"]) },
  { key: "throttle" as const, label: "Throttle", domain: [0, 1.05] as [number, number], color: "var(--color-ch-throttle, #059669)", issueKinds: new Set<string>() },
];

/** Maps a lap's ordered points to an SVG polyline `points` string for a
 *  given channel, sampled at each trace's own fraction bins. */
function tracePolyline(trace: LapTrace, channel: "steer" | "brake" | "throttle", x: (f: number) => number, y: (v: number) => number): string {
  let s = "";
  for (let i = 0; i < trace.n; i++) {
    s += `${i ? " " : ""}${x(trace.frac[i]).toFixed(1)},${y(trace[channel][i]).toFixed(1)}`;
  }
  return s;
}

/** Same as `tracePolyline` but for an arbitrary per-point value series (speed, delta). */
function tracePolyline2(trace: LapTrace, values: Float32Array | number[], x: (f: number) => number, y: (v: number) => number): string {
  let s = "";
  for (let i = 0; i < trace.n; i++) {
    s += `${i ? " " : ""}${x(trace.frac[i]).toFixed(1)},${y(values[i]).toFixed(1)}`;
  }
  return s;
}

/**
 * Input-consistency lanes (steer/brake/throttle) — every lap drawn dim, the
 * stint's best (fastest, scored) lap in accent. Invalid laps are excluded
 * upstream (TrackFocusView filters them out). Issue
 * ticks appear along the top edge of the matching channel's lane. Hovering
 * anywhere reports a point consistency score + gap-vs-best for that channel.
 */
export function ConsistencyLanes({ traces, bestLapId, cornerFracs, corners = [], issues, cursorFrac, onCursorFrac, lineSpread, onZoomHover }: ConsistencyLanesProps) {
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

  return (
    <div className="space-y-3">
      {CHANNELS.map((ch) => {
        const laneIssues = issues.filter((it) => it.distanceFrac != null && ch.issueKinds.has(it.kind));
        return (
          <div key={ch.key}>
            <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">{ch.label}</div>
            <Lane
              bgFill="transparent"
              height={100}
              domain={ch.domain}
              cornerFracs={cornerFracs}
              cursorFrac={cursorFrac}
              onCursorFrac={ch.key === "brake" || ch.key === "throttle" ? zoomCursor : onCursorFrac}
              tooltip={(f) => {
                const score = consistencyAt(traces, f, ch.key);
                const scoreColor =
                  score == null
                    ? "var(--color-app-text-dim, #7a8ea0)"
                    : score > 80
                      ? "var(--color-dynamics-green, #34d399)"
                      : score > 60
                        ? "var(--color-dynamics-amber, #f59e0b)"
                        : "var(--color-dynamics-red, #ef4444)";
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
                        consistency: <span style={{ color: scoreColor }}>{score == null ? "—" : score.toFixed(0)}</span>
                      </div>
                      <div>
                        Δ worst:{" "}
                        <span className={worstDelta != null && worstDelta > 0 ? "text-amber-400" : "text-emerald-400"}>
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
            >
              {({ x, y }) => (
                <>
                  {traces
                    .filter((t) => t.lapId !== bestLapId)
                    .map((t) => (
                      <polyline
                        key={t.lapId}
                        points={tracePolyline(t, ch.key, x, y)}
                        fill="none"
                        stroke={t.isValid ? "var(--color-app-text-dim, #7a8ea0)" : "var(--color-dynamics-red, #ef4444)"}
                        strokeWidth={1}
                        opacity={t.isValid ? 0.35 : 0.55}
                      />
                    ))}
                  {bestTrace && <polyline points={tracePolyline(bestTrace, ch.key, x, y)} fill="none" stroke="var(--color-app-accent, #22d3ee)" strokeWidth={1.8} opacity={1} />}
                  {laneIssues.map((it) => (
                    <circle
                      key={`${it.kind}-${it.corner ?? ""}-${it.detail}`}
                      cx={x(it.distanceFrac!)}
                      cy={12}
                      r={3}
                      fill={it.severity === "critical" ? "var(--color-dynamics-red, #ef4444)" : it.severity === "warn" ? "var(--color-dynamics-amber, #f59e0b)" : "#38bdf8"}
                      stroke="#020617"
                      strokeWidth={1}
                    />
                  ))}
                </>
              )}
            </Lane>
          </div>
        );
      })}
      <div>
        <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">Speed (km/h)</div>
        <Lane
          bgFill="transparent"
          height={120}
          domain={speedDomain}
          cornerFracs={cornerFracs}
          cursorFrac={cursorFrac}
          onCursorFrac={zoomCursor}
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
                          best: <span className="text-app-accent">{bestSpeed != null ? `${bestSpeed.toFixed(0)}km/h` : "—"}</span>
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
        >
          {({ x, y }) => (
            <>
              {traces
                .filter((t) => t.lapId !== bestLapId)
                .map((t) => (
                  <polyline
                    key={t.lapId}
                    points={tracePolyline2(t, t.speedKmh, x, y)}
                    fill="none"
                    stroke={t.isValid ? "var(--color-app-text-dim, #7a8ea0)" : "var(--color-dynamics-red, #ef4444)"}
                    strokeWidth={1}
                    opacity={t.isValid ? 0.35 : 0.55}
                  />
                ))}
              {bestTrace && <polyline points={tracePolyline2(bestTrace, bestTrace.speedKmh, x, y)} fill="none" stroke="var(--color-app-accent, #22d3ee)" strokeWidth={1.8} />}
            </>
          )}
        </Lane>
      </div>
      <div>
        <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">Δ time vs best (s, cumulative)</div>
        <Lane
          bgFill="transparent"
          height={100}
          domain={deltaDomain}
          cornerFracs={cornerFracs}
          cursorFrac={cursorFrac}
          onCursorFrac={onCursorFrac}
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
                    Δ worst: <span className={worst != null && worst > 0 ? "text-amber-400" : "text-emerald-400"}>{worst != null ? `${worst >= 0 ? "+" : ""}${worst.toFixed(3)}s` : "—"}</span>
                  </div>
                  <div>
                    Δ avg: <span className={avg > 0 ? "text-amber-400" : "text-emerald-400"}>{`${avg >= 0 ? "+" : ""}${avg.toFixed(3)}s`}</span>
                  </div>
                </div>
              </div>
            );
          }}
        >
          {({ x, y }) => (
            <>
              <line x1={x(0)} x2={x(1)} y1={y(0)} y2={y(0)} stroke="var(--color-app-accent, #22d3ee)" strokeWidth={1} opacity={0.6} strokeDasharray="4 3" />
              {traces
                .filter((t) => deltas.has(t.lapId))
                .map((t) => (
                  <polyline
                    key={t.lapId}
                    points={tracePolyline2(t, deltas.get(t.lapId)!, x, y)}
                    fill="none"
                    stroke={t.isValid ? "var(--color-dynamics-amber, #f59e0b)" : "var(--color-dynamics-red, #ef4444)"}
                    strokeWidth={1}
                    opacity={t.isValid ? 0.5 : 0.55}
                  />
                ))}
            </>
          )}
        </Lane>
      </div>
      <div>
        <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
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
              className="px-1 py-px rounded text-[9px] font-normal normal-case tracking-normal bg-app-surface-alt border border-app-border text-app-text-dim"
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
            onCursorFrac={zoomCursor}
            tooltip={(f) => {
              const spreadM = spreadValueAt(lineSpread!, f);
              const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
              return (
                <div className="space-y-1">
                  <ChartTooltip frac={f} cornerLabel={cornerLabel} rows={[]} />
                  <div className="font-mono tabular-nums text-app-text-dim space-y-0.5">
                    <div>
                      spread: <span style={{ color: spreadColor(spreadM) }}>{spreadM.toFixed(2)}m</span>
                    </div>
                    <div className="text-app-text-dim">over {lineSpread!.lapCount} clean laps</div>
                  </div>
                </div>
              );
            }}
          >
            {({ x, y }) => (
              <>
                <line
                  x1={x(0)}
                  x2={x(1)}
                  y1={y(LINE_SPREAD_THRESHOLD_M)}
                  y2={y(LINE_SPREAD_THRESHOLD_M)}
                  stroke="var(--color-dynamics-amber, #f59e0b)"
                  strokeWidth={1}
                  opacity={0.5}
                  strokeDasharray="4 3"
                />
                <polyline points={spreadPolyline(lineSpread!, x, y)} fill="none" stroke="var(--color-app-accent, #22d3ee)" strokeWidth={1.8} opacity={0.9} />
              </>
            )}
          </Lane>
        ) : (
          <div className="h-[90px] flex items-center justify-center rounded bg-app-surface border border-app-border text-[11px] text-app-text-dim">Need 3+ valid laps</div>
        )}
      </div>
    </div>
  );
}
