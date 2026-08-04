import { useMemo } from "react";
import type { LapTrace } from "../../../lib/stint-traces";
import { useMeasuredWidth } from "./use-measured-width";

interface GgScatterProps {
  traces: LapTrace[];
  bestLapId: number | null;
  /** Shared cursor fraction (0..1) — the point nearest this fraction on each
   *  lap is highlighted so the scatter stays in sync with the lanes. */
  cursorFrac: number | null;
}

const H = 220;
/** Friction-circle reference rings, in g. */
const RINGS = [1, 1.5];
/** Fixed g-domain — a friction circle should read as a circle, not an
 *  ellipse, so both axes share the same scale regardless of container width. */
const G_RANGE = 2;

/** Index of the trace frame nearest a given lap fraction. */
function nearestIndex(t: LapTrace, f: number): number {
  const fr = t.frac;
  const n = fr.length;
  if (n <= 1) return 0;
  const target = Math.max(0, Math.min(1, f));
  if (target <= fr[0]) return 0;
  if (target >= fr[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid] <= target) lo = mid;
    else hi = mid;
  }
  return target - fr[lo] <= fr[hi] - target ? lo : hi;
}

/**
 * G-G friction-circle scatter: every valid lap's (latG, longG) points overlaid
 * — dim for regular laps, accent for the best lap. Friction-circle reference
 * rings show how much of the tyre's available grip is being used; a filled
 * envelope means the tyre is fully worked, a sparse quadrant means grip is
 * left on the table (e.g. trail-braking or corner-exit throttle). The point
 * at the shared cursor fraction is highlighted on every lap so this chart and
 * the lat/long lanes stay in sync while scrubbing.
 */
export function GgScatter({ traces, bestLapId, cursorFrac }: GgScatterProps) {
  const { ref: wrapRef, width: bw } = useMeasuredWidth<HTMLDivElement>(320);
  const withG = useMemo(() => traces.filter((t) => t.latG != null && t.longG != null), [traces]);

  const size = Math.min(bw, H);
  const cx = bw / 2;
  const cy = H / 2;
  const r = (size / 2 - 16) / G_RANGE;
  const px = (latG: number) => cx + latG * r;
  const py = (longG: number) => cy - longG * r;

  if (withG.length === 0) {
    return (
      <div>
        <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">G-G friction circle</div>
        <div className="h-[120px] flex items-center justify-center rounded bg-app-surface border border-app-border text-app-compact text-app-text-dim">No acceleration data for this game</div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="space-y-1">
      <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">G-G friction circle (lat vs long)</div>
      <svg viewBox={`0 0 ${bw} ${H}`} width="100%" height={H}>
        <rect x={0} y={0} width={bw} height={H} fill="var(--app-surface-alt)" fillOpacity={0.35} rx={4} />
        {RINGS.map((g) => (
          <circle key={g} cx={cx} cy={cy} r={g * r} fill="none" stroke="var(--app-border)" strokeDasharray="2 4" />
        ))}
        {RINGS.map((g) => (
          <text key={`label-${g}`} x={cx + g * r + 2} y={cy - 2} fontSize={9} fill="var(--app-text-dim)">
            {g}g
          </text>
        ))}
        <line x1={0} x2={bw} y1={cy} y2={cy} stroke="var(--app-border)" strokeWidth={1} />
        <line x1={cx} x2={cx} y1={0} y2={H} stroke="var(--app-border)" strokeWidth={1} />
        <text x={bw - 30} y={cy - 4} fontSize={9} fill="var(--app-text-dim)">
          right
        </text>
        <text x={4} y={cy - 4} fontSize={9} fill="var(--app-text-dim)">
          left
        </text>
        <text x={cx + 4} y={12} fontSize={9} fill="var(--app-text-dim)">
          accel
        </text>
        <text x={cx + 4} y={H - 4} fontSize={9} fill="var(--app-text-dim)">
          brake
        </text>

        {withG
          .filter((t) => t.lapId !== bestLapId)
          .map((t) => (
            <g key={t.lapId} opacity={t.isValid ? 0.3 : 0.45}>
              {Array.from(t.frac.slice(0, t.n), (fraction, i) => (
                <circle key={`${t.lapId}-${fraction}`} cx={px(t.latG![i])} cy={py(t.longG![i])} r={1.1} fill={t.isValid ? "var(--app-text-dim)" : "var(--status-danger)"} />
              ))}
            </g>
          ))}
        {withG
          .filter((t) => t.lapId === bestLapId)
          .map((t) => (
            <g key={t.lapId} opacity={0.85}>
              {Array.from(t.frac.slice(0, t.n), (fraction, i) => (
                <circle key={`${t.lapId}-${fraction}`} cx={px(t.latG![i])} cy={py(t.longG![i])} r={1.3} fill="var(--app-accent)" />
              ))}
            </g>
          ))}

        {cursorFrac != null &&
          withG.map((t) => {
            const idx = nearestIndex(t, cursorFrac);
            return (
              <circle
                key={`cursor-${t.lapId}`}
                cx={px(t.latG![idx])}
                cy={py(t.longG![idx])}
                r={4}
                fill="none"
                stroke={t.lapId === bestLapId ? "var(--app-accent)" : "var(--app-text)"}
                strokeWidth={1.5}
              />
            );
          })}
      </svg>
    </div>
  );
}
