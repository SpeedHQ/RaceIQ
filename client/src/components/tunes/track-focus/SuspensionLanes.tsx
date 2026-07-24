import { useMemo } from "react";
import type { LapTrace, TireAverages } from "../../../lib/stint-traces";
import { indexAtFrac } from "../../../lib/stint-traces";
import { Lane } from "./Lane";

interface SuspensionLanesProps {
  /** Traces in lap order (undefined entries = not loaded yet, skipped). */
  traces: (LapTrace | undefined)[];
  bestLapId?: number | null;
  cornerFracs?: number[];
  cursorFrac?: number | null;
  onCursorFrac?: (f: number | null) => void;
}

const CORNERS: { key: keyof TireAverages; label: string; color: string }[] = [
  { key: "FL", label: "FL", color: "#38bdf8" },
  { key: "FR", label: "FR", color: "#f472b6" },
  { key: "RL", label: "RL", color: "#facc15" },
  { key: "RR", label: "RR", color: "#34d399" },
];

function suspPolyline(t: LapTrace, arr: Float32Array, x: (f: number) => number, y: (v: number) => number): string {
  const pts: string[] = [];
  for (let i = 0; i < t.n; i++) pts.push(`${x(t.frac[i]).toFixed(1)},${y(arr[i]).toFixed(1)}`);
  return pts.join(" ");
}

/**
 * Suspension tab: four per-corner lanes (FL/FR/RL/RR) from the `suspTravel`
 * channel, mirroring the Tyres tab's per-corner layout — every lap dim, best
 * lap in accent, invalid laps red. Empty state when the game has no
 * suspension-travel data (e.g. F1, which doesn't expose it).
 */
export function SuspensionLanes({ traces, bestLapId = null, cornerFracs = [], cursorFrac = null, onCursorFrac = () => {} }: SuspensionLanesProps) {
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

  if (lapsWithTrace.length === 0) {
    return (
      <div>
        <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">Suspension travel</div>
        <div className="h-[100px] flex items-center justify-center rounded bg-app-surface border border-app-border text-[11px] text-app-text-dim">No suspension travel data for this game</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-app-text-dim">
        Normalized 0–1 suspension travel. ACC reports absolute compression (0 = full droop); AC Evo is centred at 0.5 (neutral ride height) — "more" means something different per game, but
        lap-to-lap variation is comparable either way.
      </p>
      {CORNERS.map((c) => (
        <div key={c.key} className="space-y-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-app-text-dim">
            <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: c.color }} />
            {c.label} — travel per lap
          </div>
          <Lane
            height={80}
            domain={laneDomain}
            cornerFracs={cornerFracs}
            cursorFrac={cursorFrac}
            onCursorFrac={onCursorFrac}
            tooltip={(f) => {
              const best = lapsWithTrace.find((t) => t.lapId === bestLapId);
              if (!best?.suspTravel) return null;
              const idx = indexAtFrac(best, f);
              const v = best.suspTravel[c.key][idx];
              return (
                <span>
                  best lap {c.label}: {v.toFixed(2)}
                </span>
              );
            }}
          >
            {({ x: lx, y: ly }) => (
              <>
                {lapsWithTrace
                  .filter((t) => t.lapId !== bestLapId)
                  .map((t) => (
                    <polyline
                      key={t.lapId}
                      points={suspPolyline(t, t.suspTravel![c.key], lx, ly)}
                      fill="none"
                      stroke={t.isValid ? "var(--color-app-text-dim, #7a8ea0)" : "var(--color-dynamics-red, #ef4444)"}
                      strokeWidth={1}
                      opacity={t.isValid ? 0.35 : 0.55}
                    />
                  ))}
                {(() => {
                  const best = lapsWithTrace.find((t) => t.lapId === bestLapId);
                  return best?.suspTravel ? <polyline points={suspPolyline(best, best.suspTravel[c.key], lx, ly)} fill="none" stroke={c.color} strokeWidth={1.8} /> : null;
                })()}
              </>
            )}
          </Lane>
        </div>
      ))}
    </div>
  );
}
