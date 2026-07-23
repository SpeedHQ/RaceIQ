import type { TuneIssue } from "@shared/types";
import { useMemo } from "react";
import { consistencyAt, type LapTrace, sampleAt } from "../../../lib/stint-traces";
import { Lane } from "./Lane";

interface ConsistencyLanesProps {
  traces: LapTrace[];
  bestLapId: number | null;
  cornerFracs: number[];
  issues: TuneIssue[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
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
 * stint's best (fastest, scored) lap in accent, invalid laps in red. Issue
 * ticks appear along the top edge of the matching channel's lane. Hovering
 * anywhere reports a point consistency score + gap-vs-best for that channel.
 */
export function ConsistencyLanes({ traces, bestLapId, cornerFracs, issues, cursorFrac, onCursorFrac }: ConsistencyLanesProps) {
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
      const d = new Float32Array(t.n);
      for (let i = 0; i < t.n; i++) d[i] = t.timeS[i] - bestTrace.timeS[i];
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

  return (
    <div className="space-y-3">
      {CHANNELS.map((ch) => {
        const laneIssues = issues.filter((it) => it.distanceFrac != null && ch.issueKinds.has(it.kind));
        return (
          <div key={ch.key}>
            <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">{ch.label}</div>
            <Lane
              height={100}
              domain={ch.domain}
              cornerFracs={cornerFracs}
              cursorFrac={cursorFrac}
              onCursorFrac={onCursorFrac}
              tooltip={(f) => {
                const score = consistencyAt(traces, f, ch.key);
                const gap = bestTrace ? (traces.find((t) => t.lapId !== bestLapId) ?? bestTrace) : null;
                const focusVsBest = bestTrace && gap ? sampleAt(gap, ch.key, f) - sampleAt(bestTrace, ch.key, f) : null;
                const scoreColor =
                  score == null
                    ? "var(--color-app-text-dim, #7a8ea0)"
                    : score > 80
                      ? "var(--color-dynamics-green, #34d399)"
                      : score > 60
                        ? "var(--color-dynamics-amber, #f59e0b)"
                        : "var(--color-dynamics-red, #ef4444)";
                return (
                  <div className="font-mono tabular-nums">
                    <div className="text-app-text-dim">
                      {ch.label} @ {(f * 100).toFixed(1)}% lap
                    </div>
                    <div>
                      consistency: <span style={{ color: scoreColor }}>{score == null ? "—" : score.toFixed(0)}</span>
                    </div>
                    {focusVsBest != null && (
                      <div className="text-app-text-muted">
                        gap Δ: {focusVsBest >= 0 ? "+" : ""}
                        {(focusVsBest * 100).toFixed(1)}%
                      </div>
                    )}
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
          height={120}
          domain={speedDomain}
          cornerFracs={cornerFracs}
          cursorFrac={cursorFrac}
          onCursorFrac={onCursorFrac}
          tooltip={
            bestTrace
              ? (f) => {
                  const i = Math.round(f * (bestTrace.n - 1));
                  return (
                    <div className="font-mono tabular-nums">
                      <div className="text-app-text-dim">Speed @ {(f * 100).toFixed(1)}% lap</div>
                      <div>best: {bestTrace.speedKmh[i]?.toFixed(0)} km/h</div>
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
          height={100}
          domain={deltaDomain}
          cornerFracs={cornerFracs}
          cursorFrac={cursorFrac}
          onCursorFrac={onCursorFrac}
          tooltip={(f) => {
            const rows = traces
              .filter((t) => deltas.has(t.lapId))
              .map((t) => {
                const d = deltas.get(t.lapId)!;
                const v = d[Math.round(f * (t.n - 1))];
                return { lap: t.lapNumber, v };
              });
            if (rows.length === 0) return null;
            return (
              <div className="font-mono tabular-nums">
                {rows.map((r) => (
                  <div key={r.lap}>
                    L{r.lap}: {r.v >= 0 ? "+" : ""}
                    {r.v.toFixed(3)}s
                  </div>
                ))}
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
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-app-text-dim">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: "var(--color-app-text-dim, #7a8ea0)" }} />
          laps (all)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: "var(--color-app-accent, #22d3ee)" }} />
          best lap
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: "var(--color-dynamics-red, #ef4444)" }} />
          invalid lap
        </span>
      </div>
    </div>
  );
}
