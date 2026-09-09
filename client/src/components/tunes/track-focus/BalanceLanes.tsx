import { useMemo } from "react";
import type { AnnotationMarker } from "./Lane";
import { severityRangeColor } from "@/lib/colors";
import type { TrackCorner } from "../../../hooks/track-queries";
import type { LapTrace } from "../../../lib/stint-traces";
import { ChartTooltip } from "./ChartTooltip";
import { nearestCornerLabel } from "./detect-corners";
import { Lane } from "./Lane";

interface BalanceLanesProps {
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
export function BalanceLanes({ traces, primaryLapId: primaryLapId, cornerFracs, corners = [], annotationMarkers, cursorFrac, onCursorFrac, visibleRange, onRangeSelect, onZoomOut }: BalanceLanesProps) {
  const withBalance = useMemo(() => traces.filter((t) => t.balance != null), [traces]);
  const bestTrace = useMemo(() => withBalance.find((t) => t.lapId === primaryLapId) ?? null, [withBalance, primaryLapId]);

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
  const series = useMemo(
    () => [
      ...withBalance
        .filter((trace) => trace.lapId !== primaryLapId)
        .map((trace) => ({
          x: trace.frac,
          values: trace.balance!,
          color: trace.isValid ? "color-mix(in srgb, var(--app-text-dim) 35%, transparent)" : "color-mix(in srgb, var(--status-danger) 55%, transparent)",
          width: 1,
        })),
      ...(bestTrace ? [{ x: bestTrace.frac, values: bestTrace.balance!, color: "var(--app-accent)", width: 1.8 }] : []),
    ],
    [primaryLapId, bestTrace, withBalance],
  );

  if (withBalance.length === 0) {
    return (
      <div>
        <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Balance (understeer / oversteer)</div>
        <div className="h-[100px] flex items-center justify-center rounded bg-app-surface border border-app-border text-app-compact text-app-text-dim">No slip-angle data for this game</div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Balance (° axle slip delta, + understeer / − oversteer)</div>
      <Lane
        bgFill="transparent"
        height={120}
        domain={domain}
        visibleRange={visibleRange}
        onRangeSelect={onRangeSelect}
        onZoomOut={onZoomOut}
        cornerFracs={cornerFracs}
        annotationMarkers={annotationMarkers}
        cursorFrac={cursorFrac}
        onCursorFrac={onCursorFrac}
        series={series}
        horizontalLines={[{ value: 0, color: "var(--app-accent)", width: 1, opacity: 0.5, dash: [4, 3] }]}
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
                    primary: <span style={{ color: magnitudeColor(Math.abs(bestDeg)) }}>{`${bestDeg >= 0 ? "+" : ""}${bestDeg.toFixed(1)}°`}</span>{" "}
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
      />
    </div>
  );
}
