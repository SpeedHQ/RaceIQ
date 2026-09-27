import { useMemo } from "react";
import type { AnnotationMarker } from "./Lane";
import { signedBalanceColor } from "@/lib/colors";
import type { LapTrace } from "../../../lib/stint-traces";
import type { TrackCorner } from "../../../hooks/track-queries";
import { ChartSpread, type TooltipDisplayMode } from "./ChartTooltip";
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
  tooltipMode?: TooltipDisplayMode;
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
export function BalanceLanes({ traces, primaryLapId, cornerFracs, corners = [], annotationMarkers, cursorFrac, onCursorFrac, visibleRange, onRangeSelect, onZoomOut, tooltipMode = "per-lap" }: BalanceLanesProps) {
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
        tooltip={(f) => {
          const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
          const samples = withBalance.map((lap) => ({ lap, value: balanceAt(lap, f) }));
          if (tooltipMode === "per-lap") {
            return <div className="space-y-0.5 font-mono tabular-nums"><ChartSpread values={samples.map((sample) => sample.value)} format={(value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}°`} />{samples.sort((a, b) => Math.abs(a.value) - Math.abs(b.value)).map(({ lap, value }) => <div key={lap.lapId}><span className={lap.lapId === primaryLapId ? "text-app-accent" : "text-app-text-muted"}>L{lap.lapNumber}</span>: <span style={{ color: signedBalanceColor(value, 0.5) }}>{value >= 0 ? "+" : ""}{value.toFixed(1)}° {verdict(value)}</span></div>)}</div>;
          }
          const byMagnitude = [...samples].sort((a, b) => Math.abs(a.value) - Math.abs(b.value));
          const middle = Math.floor(byMagnitude.length / 2);
          const median = byMagnitude.length % 2 === 0 ? (byMagnitude[middle - 1].value + byMagnitude[middle].value) / 2 : byMagnitude[middle].value;
          const primary = samples.find(({ lap }) => lap.lapId === primaryLapId)?.value;
          const stats: Array<readonly [string, number | undefined]> = [["max", byMagnitude.at(-1)?.value], ["median", median], ["min", byMagnitude[0]?.value]];
          stats.splice(primary == null ? 1 : Math.abs(primary) >= Math.abs(median) ? 1 : 2, 0, ["primary", primary]);
          return <div className="space-y-0.5 font-mono tabular-nums"><div className="text-app-text-dim">{cornerLabel ?? "Balance"}</div><ChartSpread values={samples.map((sample) => sample.value)} format={(value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}°`} />{stats.map(([label, value]) => <div key={label} className={label === "primary" ? "text-app-accent" : "text-app-text-muted"}>{label}: <span style={{ color: value == null ? "var(--app-text)" : signedBalanceColor(value, 0.5) }}>{value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}° ${verdict(value)}`}</span></div>)}</div>;
        }}
      />
    </div>
  );
}
