import { useMemo } from "react";
import type { TrackCorner } from "../../../hooks/queries";
import { indexAtFrac, type LapTrace, sampleAt } from "../../../lib/stint-traces";
import { ChartTooltip } from "./ChartTooltip";
import { nearestCornerLabel } from "./detect-corners";
import { Lane } from "./Lane";

interface SpeedDeltaLanesProps {
  bestTrace: LapTrace | null;
  focusTrace: LapTrace | null;
  cornerFracs: number[];
  corners?: TrackCorner[];
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
export function SpeedDeltaLanes({ bestTrace, focusTrace, cornerFracs, corners = [], cursorFrac, onCursorFrac }: SpeedDeltaLanesProps) {
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
    // Traces are raw frames, so focus and best have different lengths and
    // uneven fractions — sample best at each focus frame's own fraction.
    const n = focusTrace.n;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = focusTrace.timeS[i] - sampleAt(bestTrace, "timeS", focusTrace.frac[i]);
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
                  const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
                  const rows = [
                    { lapNumber: focusTrace.lapNumber, color: "var(--app-accent)", isBest: focusTrace.lapId === bestTrace?.lapId, speedKmh: sampleAt(focusTrace, "speedKmh", f) },
                    ...(bestTrace && bestTrace.lapId !== focusTrace.lapId
                      ? [{ lapNumber: bestTrace.lapNumber, color: "var(--app-text-dim)", isBest: true, speedKmh: sampleAt(bestTrace, "speedKmh", f) }]
                      : []),
                  ];
                  return <ChartTooltip frac={f} cornerLabel={cornerLabel} rows={rows} />;
                }
              : undefined
          }
        >
          {({ x, y }) => (
            <>
              {bestTrace && <polyline points={polyline(bestTrace, bestTrace.speedKmh, x, y)} fill="none" stroke="var(--app-text-dim)" strokeWidth={1} />}
              {focusTrace && <polyline points={polyline(focusTrace, focusTrace.speedKmh, x, y)} fill="none" stroke="var(--app-accent)" strokeWidth={1.6} />}
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
                  const i = indexAtFrac(focusTrace, f);
                  const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
                  const rows = [{ lapNumber: focusTrace.lapNumber, color: "var(--delta-focus)", deltaS: delta[i] }];
                  return <ChartTooltip frac={f} cornerLabel={cornerLabel} rows={rows} />;
                }
              : undefined
          }
        >
          {({ x, y }) => delta && focusTrace && <polyline points={polyline(focusTrace, delta, x, y)} fill="none" stroke="var(--delta-focus)" strokeWidth={1.6} />}
        </Lane>
      </div>
    </div>
  );
}
