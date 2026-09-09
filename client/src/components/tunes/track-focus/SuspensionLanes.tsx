import { useMemo } from "react";
import { WHEEL_COLOR_VARS } from "@/lib/colors";
import type { LapTrace, TireAverages } from "../../../lib/stint-traces";
import { indexAtFrac } from "../../../lib/stint-traces";
import { Lane, type AnnotationMarker, type LaneSeries } from "./Lane";

interface SuspensionLanesProps {
  /** Traces in lap order (undefined entries = not loaded yet, skipped). */
  traces: (LapTrace | undefined)[];
  primaryLapId?: number | null;
  cornerFracs?: number[];
  cursorFrac?: number | null;
  onCursorFrac?: (f: number | null) => void;
  annotationMarkers?: AnnotationMarker[];
  visibleRange?: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
}
const CORNERS: { key: keyof TireAverages; label: string; color: string }[] = [
  { key: "FL", label: "FL", color: WHEEL_COLOR_VARS[0] },
  { key: "FR", label: "FR", color: WHEEL_COLOR_VARS[1] },
  { key: "RL", label: "RL", color: WHEEL_COLOR_VARS[2] },
  { key: "RR", label: "RR", color: WHEEL_COLOR_VARS[3] },
];

/**
 * Suspension tab: four per-corner lanes (FL/FR/RL/RR) from the `suspTravel`
 * channel, mirroring the Tyres tab's per-corner layout — every lap dim, best
 * lap in accent, invalid laps red. Empty state when the game has no
 * suspension-travel data (e.g. F1, which doesn't expose it).
 */
export function SuspensionLanes({
  traces,
  primaryLapId: primaryLapId = null,
  cornerFracs = [],
  annotationMarkers,
  cursorFrac = null,
  onCursorFrac = () => {},
  visibleRange,
  onRangeSelect,
  onZoomOut,
}: SuspensionLanesProps) {
  const laps = useMemo(() => traces.filter((t): t is LapTrace => !!t), [traces]);
  const lapsWithTrace = useMemo(() => laps.filter((t) => t.suspTravel != null), [laps]);

  const laneDomain = useMemo<[number, number]>(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of lapsWithTrace) {
      const tt = t.suspTravel!;
      for (const c of CORNERS) {
        const arr = tt[c.key];
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] < lo) lo = arr[i];
          if (arr[i] > hi) hi = arr[i];
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    const pad = Math.max(0.02, (hi - lo) * 0.08);
    return [lo - pad, hi + pad];
  }, [lapsWithTrace]);
  const seriesByCorner = useMemo(
    () =>
      Object.fromEntries(
        CORNERS.map((corner) => [
          corner.key,
          [
            ...lapsWithTrace
              .filter((trace) => trace.lapId !== primaryLapId)
              .map((trace): LaneSeries => ({
                x: trace.frac,
                values: trace.suspTravel![corner.key],
                color: trace.isValid ? "color-mix(in srgb, var(--app-text-dim) 35%, transparent)" : "color-mix(in srgb, var(--status-danger) 55%, transparent)",
              })),
            ...lapsWithTrace.filter((trace) => trace.lapId === primaryLapId).map((trace): LaneSeries => ({ x: trace.frac, values: trace.suspTravel![corner.key], color: corner.color, width: 1.8 })),
          ],
        ]),
      ) as Record<keyof TireAverages, LaneSeries[]>,
    [primaryLapId, lapsWithTrace],
  );

  if (lapsWithTrace.length === 0) {
    return (
      <div>
        <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Suspension travel</div>
        <div className="h-[100px] flex items-center justify-center rounded bg-app-surface border border-app-border text-app-compact text-app-text-dim">No suspension travel data for this game</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-app-compact text-app-text-dim">
        Normalized 0–1 suspension travel. ACC reports absolute compression (0 = full droop); AC Evo is centred at 0.5 (neutral ride height) — "more" means something different per game, but lap-to-lap
        variation is comparable either way.
      </p>
      {CORNERS.map((c) => (
        <div key={c.key} className="space-y-1">
          <div className="flex items-center gap-2 text-app-caption uppercase tracking-wider text-app-text-dim">
            <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: c.color }} />
            {c.label} — travel per lap
          </div>
          <Lane
            height={80}
            domain={laneDomain}
            visibleRange={visibleRange}
            onRangeSelect={onRangeSelect}
            onZoomOut={onZoomOut}
            cornerFracs={cornerFracs}
            annotationMarkers={annotationMarkers}
            cursorFrac={cursorFrac}
            onCursorFrac={onCursorFrac}
            tooltip={(f) => {
              const best = lapsWithTrace.find((t) => t.lapId === primaryLapId);
              if (!best?.suspTravel) return null;
              const idx = indexAtFrac(best, f);
              const v = best.suspTravel[c.key][idx];
              return (
                <span>
                  primary lap {c.label}: {v.toFixed(2)}
                </span>
              );
            }}
            series={seriesByCorner[c.key]}
          />
        </div>
      ))}
    </div>
  );
}
