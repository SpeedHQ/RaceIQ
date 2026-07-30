import { useMemo } from "react";
import { severityRangeColor } from "@/lib/colors";
import type { TrackCorner } from "../../../hooks/queries";
import type { LapTrace } from "../../../lib/stint-traces";
import { ChartTooltip } from "./ChartTooltip";
import { nearestCornerLabel } from "./detect-corners";
import { Lane } from "./Lane";

interface BalanceLanesProps {
  traces: LapTrace[];
  bestLapId: number | null;
  cornerFracs: number[];
  corners?: TrackCorner[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
}

/** Magnitude thresholds (degrees) for the severity banding — tuned to
 *  typical GT3-class axle slip deltas rather than a formal spec. */
const BAND_AMBER_DEG = 3;
const BAND_RED_DEG = 6;

function magnitudeColor(absDeg: number): string {
  return severityRangeColor(absDeg, [BAND_AMBER_DEG, BAND_RED_DEG]);
}

function verdict(deg: number): string {
  if (Math.abs(deg) < 0.5) return "neutral";
  return deg > 0 ? "understeer" : "oversteer";
}

function balancePolyline(t: LapTrace, x: (f: number) => number, y: (v: number) => number): string {
  const balance = t.balance!;
  let s = "";
  for (let i = 0; i < t.n; i++) {
    s += `${i ? " " : ""}${x(t.frac[i]).toFixed(1)},${y(balance[i]).toFixed(1)}`;
  }
  return s;
}

/** Linear-interpolate a trace's `balance` channel at fraction `f`. */
function balanceAt(t: LapTrace, f: number): number {
  const arr = t.balance!;
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

/**
 * Balance tab: one signed lane showing per-frame axle slip delta (degrees).
 * Positive = understeer (front slips more), negative = oversteer (rear slips
 * more). Every lap dim, best lap in accent, dashed zero line. Empty state
 * when the game reports no slip-angle data at all.
 */
export function BalanceLanes({ traces, bestLapId, cornerFracs, corners = [], cursorFrac, onCursorFrac }: BalanceLanesProps) {
  const withBalance = useMemo(() => traces.filter((t) => t.balance != null), [traces]);
  const bestTrace = useMemo(() => withBalance.find((t) => t.lapId === bestLapId) ?? null, [withBalance, bestLapId]);

  const domain = useMemo<[number, number]>(() => {
    let maxAbs = 0;
    for (const t of withBalance) {
      const balance = t.balance!;
      for (let i = 0; i < balance.length; i++) maxAbs = Math.max(maxAbs, Math.abs(balance[i]));
    }
    if (maxAbs === 0) return [-2, 2];
    const pad = Math.max(0.3, maxAbs * 0.15);
    return [-maxAbs - pad, maxAbs + pad];
  }, [withBalance]);

  if (withBalance.length === 0) {
    return (
      <div>
        <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">Balance (understeer / oversteer)</div>
        <div className="h-[100px] flex items-center justify-center rounded bg-app-surface border border-app-border text-[11px] text-app-text-dim">No slip-angle data for this game</div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">Balance (° axle slip delta, + understeer / − oversteer)</div>
      <Lane
        bgFill="transparent"
        height={120}
        domain={domain}
        cornerFracs={cornerFracs}
        cursorFrac={cursorFrac}
        onCursorFrac={onCursorFrac}
        tooltip={(f) => {
          const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
          let worst: { lapNumber: number; deg: number } | null = null;
          for (const t of withBalance) {
            const deg = balanceAt(t, f);
            if (worst == null || Math.abs(deg) > Math.abs(worst.deg)) worst = { lapNumber: t.lapNumber, deg };
          }
          const bestDeg = bestTrace ? balanceAt(bestTrace, f) : null;
          return (
            <div className="space-y-1">
              <ChartTooltip frac={f} cornerLabel={cornerLabel} rows={[]} />
              <div className="font-mono tabular-nums text-app-text-dim space-y-0.5">
                {bestDeg != null && (
                  <div>
                    best: <span style={{ color: magnitudeColor(Math.abs(bestDeg)) }}>{`${bestDeg >= 0 ? "+" : ""}${bestDeg.toFixed(1)}°`}</span>{" "}
                    <span className="text-app-text-muted">{verdict(bestDeg)}</span>
                  </div>
                )}
                {worst && (
                  <div>
                    worst: L{worst.lapNumber} <span style={{ color: magnitudeColor(Math.abs(worst.deg)) }}>{`${worst.deg >= 0 ? "+" : ""}${worst.deg.toFixed(1)}°`}</span>{" "}
                    <span className="text-app-text-muted">{verdict(worst.deg)}</span>
                  </div>
                )}
              </div>
            </div>
          );
        }}
      >
        {({ x, y }) => (
          <>
            <line x1={x(0)} x2={x(1)} y1={y(0)} y2={y(0)} stroke="var(--app-accent)" strokeWidth={1} opacity={0.5} strokeDasharray="4 3" />
            {withBalance
              .filter((t) => t.lapId !== bestLapId)
              .map((t) => (
                <polyline
                  key={t.lapId}
                  points={balancePolyline(t, x, y)}
                  fill="none"
                  stroke={t.isValid ? "var(--app-text-dim)" : "var(--status-danger)"}
                  strokeWidth={1}
                  opacity={t.isValid ? 0.35 : 0.55}
                />
              ))}
            {bestTrace && <polyline points={balancePolyline(bestTrace, x, y)} fill="none" stroke="var(--app-accent)" strokeWidth={1.8} opacity={1} />}
          </>
        )}
      </Lane>
    </div>
  );
}
