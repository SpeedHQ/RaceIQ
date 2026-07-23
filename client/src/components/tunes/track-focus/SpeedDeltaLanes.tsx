import { useMemo } from "react";
import type { LapTrace } from "../../../lib/stint-traces";
import { Lane } from "./Lane";

interface SpeedDeltaLanesProps {
  bestTrace: LapTrace | null;
  focusTrace: LapTrace | null;
  cornerFracs: number[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
}

function polyline(trace: LapTrace, values: Float32Array | number[], x: (f: number) => number, y: (v: number) => number): string {
  let s = "";
  for (let i = 0; i < trace.n; i++) {
    s += `${i ? " " : ""}${x(trace.frac[i]).toFixed(1)},${y(values[i]).toFixed(1)}`;
  }
  return s;
}

/**
 * Speed overlay (best dim, focus lap accent) + cumulative time-delta lane
 * (focus minus best, from each trace's own time-at-distance series).
 */
export function SpeedDeltaLanes({ bestTrace, focusTrace, cornerFracs, cursorFrac, onCursorFrac }: SpeedDeltaLanesProps) {
  const speedDomain = useMemo<[number, number]>(() => {
    const all: number[] = [];
    if (bestTrace) all.push(...Array.from(bestTrace.speedKmh));
    if (focusTrace) all.push(...Array.from(focusTrace.speedKmh));
    if (all.length === 0) return [0, 300];
    const min = Math.min(...all);
    const max = Math.max(...all);
    return [Math.max(0, min - 10), max + 10];
  }, [bestTrace, focusTrace]);

  const delta = useMemo(() => {
    if (!bestTrace || !focusTrace) return null;
    const n = focusTrace.n;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = focusTrace.timeS[i] - bestTrace.timeS[i];
    return out;
  }, [bestTrace, focusTrace]);

  const deltaDomain = useMemo<[number, number]>(() => {
    if (!delta) return [-0.5, 0.5];
    let max = 0;
    for (const v of delta) max = Math.max(max, Math.abs(v));
    const pad = Math.max(0.1, max * 0.15);
    return [-max - pad, max + pad];
  }, [delta]);

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">Speed (km/h)</div>
        <Lane
          height={150}
          domain={speedDomain}
          cornerFracs={cornerFracs}
          cursorFrac={cursorFrac}
          onCursorFrac={onCursorFrac}
          tooltip={
            focusTrace
              ? (f) => {
                  const i = Math.round(f * (focusTrace.n - 1));
                  return (
                    <div className="font-mono tabular-nums">
                      <div>focus: {focusTrace.speedKmh[i]?.toFixed(0)} km/h</div>
                      {bestTrace && <div className="text-app-text-dim">best: {bestTrace.speedKmh[Math.round(f * (bestTrace.n - 1))]?.toFixed(0)} km/h</div>}
                    </div>
                  );
                }
              : undefined
          }
        >
          {({ x, y }) => (
            <>
              {bestTrace && <polyline points={polyline(bestTrace, bestTrace.speedKmh, x, y)} fill="none" stroke="var(--color-app-text-dim, #7a8ea0)" strokeWidth={1} />}
              {focusTrace && <polyline points={polyline(focusTrace, focusTrace.speedKmh, x, y)} fill="none" stroke="var(--color-app-accent, #22d3ee)" strokeWidth={1.6} />}
            </>
          )}
        </Lane>
      </div>
      <div>
        <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">Δ time vs best (s, cumulative)</div>
        <Lane
          height={110}
          domain={deltaDomain}
          cornerFracs={cornerFracs}
          cursorFrac={cursorFrac}
          onCursorFrac={onCursorFrac}
          tooltip={
            delta && focusTrace
              ? (f) => {
                  const i = Math.round(f * (focusTrace.n - 1));
                  const v = delta[i];
                  return (
                    <div className="font-mono tabular-nums">
                      Δ {v >= 0 ? "+" : ""}
                      {v.toFixed(3)}s
                    </div>
                  );
                }
              : undefined
          }
        >
          {({ x, y }) => delta && focusTrace && <polyline points={polyline(focusTrace, delta, x, y)} fill="none" stroke="var(--color-dynamics-amber, #f59e0b)" strokeWidth={1.6} />}
        </Lane>
      </div>
    </div>
  );
}
