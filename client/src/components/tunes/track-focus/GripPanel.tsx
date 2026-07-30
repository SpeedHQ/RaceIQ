import { useMemo } from "react";
import { WHEEL_COLOR_VARS } from "@/lib/colors";
import type { TrackCorner } from "../../../hooks/queries";
import type { LapTrace, TireAverages } from "../../../lib/stint-traces";
import { ChartTooltip } from "./ChartTooltip";
import { nearestCornerLabel } from "./detect-corners";
import { GgScatter } from "./GgScatter";
import { Lane } from "./Lane";

interface GripPanelProps {
  traces: LapTrace[];
  bestLapId: number | null;
  cornerFracs: number[];
  corners?: TrackCorner[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
}

const SLIP_CORNERS: { key: keyof TireAverages; label: string; color: string }[] = [
  { key: "FL", label: "FL", color: WHEEL_COLOR_VARS[0] },
  { key: "FR", label: "FR", color: WHEEL_COLOR_VARS[1] },
  { key: "RL", label: "RL", color: WHEEL_COLOR_VARS[2] },
  { key: "RR", label: "RR", color: WHEEL_COLOR_VARS[3] },
];

/** Linear-interpolate an arbitrary per-frame value series at fraction `f`,
 *  using the trace's own (monotonic, unevenly-spaced) `frac` bins. */
function valueAt(t: LapTrace, arr: Float32Array, f: number): number {
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

function gPolyline(t: LapTrace, arr: Float32Array, x: (f: number) => number, y: (v: number) => number): string {
  let s = "";
  for (let i = 0; i < t.n; i++) s += `${i ? " " : ""}${x(t.frac[i]).toFixed(1)},${y(arr[i]).toFixed(1)}`;
  return s;
}

function gDomain(traces: LapTrace[], sel: (t: LapTrace) => Float32Array | null): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const t of traces) {
    const arr = sel(t);
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < min) min = arr[i];
      if (arr[i] > max) max = arr[i];
    }
  }
  if (!Number.isFinite(min)) return [-2, 2];
  const pad = Math.max(0.2, (max - min) * 0.1);
  return [min - pad, max + pad];
}

/**
 * Grip tab: latG + longG lanes (track position), a 4-corner combined-slip
 * lane, and the G-G friction-circle scatter. Composes the same overlay idiom
 * as Consistency/Balance — every lap dim, best lap accent — reusing `Lane`
 * for the two scalar lanes and the corner lane, plus the standalone
 * `GgScatter` for the friction circle.
 */
export function GripPanel({ traces, bestLapId, cornerFracs, corners = [], cursorFrac, onCursorFrac }: GripPanelProps) {
  const withLatG = useMemo(() => traces.filter((t) => t.latG != null), [traces]);
  const withLongG = useMemo(() => traces.filter((t) => t.longG != null), [traces]);
  const withSlip = useMemo(() => traces.filter((t) => t.combinedSlip != null), [traces]);

  const bestLatG = withLatG.find((t) => t.lapId === bestLapId) ?? null;
  const bestLongG = withLongG.find((t) => t.lapId === bestLapId) ?? null;
  const bestSlip = withSlip.find((t) => t.lapId === bestLapId) ?? null;

  const latDomain = useMemo(() => gDomain(withLatG, (t) => t.latG), [withLatG]);
  const longDomain = useMemo(() => gDomain(withLongG, (t) => t.longG), [withLongG]);

  // Auto-fit min→max (not anchored at 0) so miniscule slip variation is
  // visible — combined slip in clean laps sits in a narrow band well above 0.
  const slipDomain = useMemo<[number, number]>(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const t of withSlip) {
      for (const c of SLIP_CORNERS) {
        const arr = t.combinedSlip![c.key];
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] < min) min = arr[i];
          if (arr[i] > max) max = arr[i];
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
    const pad = Math.max(0.001, (max - min) * 0.08);
    return [min - pad, max + pad];
  }, [withSlip]);

  return (
    <div className="space-y-3">
      {withLatG.length === 0 ? (
        <div>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Lateral g</div>
          <div className="h-[100px] flex items-center justify-center rounded bg-app-surface border border-app-border text-app-compact text-app-text-dim">No acceleration data for this game</div>
        </div>
      ) : (
        <div>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Lateral g</div>
          <Lane
            bgFill="transparent"
            height={100}
            domain={latDomain}
            cornerFracs={cornerFracs}
            cursorFrac={cursorFrac}
            onCursorFrac={onCursorFrac}
            tooltip={(f) => {
              const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
              const best = bestLatG ? valueAt(bestLatG, bestLatG.latG!, f) : null;
              return (
                <div className="space-y-1">
                  <ChartTooltip frac={f} cornerLabel={cornerLabel} rows={[]} />
                  <div className="font-mono tabular-nums text-app-text-dim">best: {best != null ? `${best.toFixed(2)}g` : "—"}</div>
                </div>
              );
            }}
          >
            {({ x, y }) => (
              <>
                {withLatG
                  .filter((t) => t.lapId !== bestLapId)
                  .map((t) => (
                    <polyline
                      key={t.lapId}
                      points={gPolyline(t, t.latG!, x, y)}
                      fill="none"
                      stroke={t.isValid ? "var(--app-text-dim)" : "var(--status-danger)"}
                      strokeWidth={1}
                      opacity={t.isValid ? 0.35 : 0.55}
                    />
                  ))}
                {bestLatG && <polyline points={gPolyline(bestLatG, bestLatG.latG!, x, y)} fill="none" stroke="var(--app-accent)" strokeWidth={1.8} />}
              </>
            )}
          </Lane>
        </div>
      )}

      {withLongG.length === 0 ? (
        <div>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Longitudinal g</div>
          <div className="h-[100px] flex items-center justify-center rounded bg-app-surface border border-app-border text-app-compact text-app-text-dim">No acceleration data for this game</div>
        </div>
      ) : (
        <div>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Longitudinal g (+ accel / − brake)</div>
          <Lane
            bgFill="transparent"
            height={100}
            domain={longDomain}
            cornerFracs={cornerFracs}
            cursorFrac={cursorFrac}
            onCursorFrac={onCursorFrac}
            tooltip={(f) => {
              const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
              const best = bestLongG ? valueAt(bestLongG, bestLongG.longG!, f) : null;
              return (
                <div className="space-y-1">
                  <ChartTooltip frac={f} cornerLabel={cornerLabel} rows={[]} />
                  <div className="font-mono tabular-nums text-app-text-dim">best: {best != null ? `${best.toFixed(2)}g` : "—"}</div>
                </div>
              );
            }}
          >
            {({ x, y }) => (
              <>
                {withLongG
                  .filter((t) => t.lapId !== bestLapId)
                  .map((t) => (
                    <polyline
                      key={t.lapId}
                      points={gPolyline(t, t.longG!, x, y)}
                      fill="none"
                      stroke={t.isValid ? "var(--app-text-dim)" : "var(--status-danger)"}
                      strokeWidth={1}
                      opacity={t.isValid ? 0.35 : 0.55}
                    />
                  ))}
                {bestLongG && <polyline points={gPolyline(bestLongG, bestLongG.longG!, x, y)} fill="none" stroke="var(--app-accent)" strokeWidth={1.8} />}
              </>
            )}
          </Lane>
        </div>
      )}

      {withSlip.length === 0 ? (
        <div>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Combined tyre slip</div>
          <div className="h-[100px] flex items-center justify-center rounded bg-app-surface border border-app-border text-app-compact text-app-text-dim">No combined-slip data for this game</div>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Combined tyre slip</div>
          <Lane
            bgFill="transparent"
            height={100}
            domain={slipDomain}
            cornerFracs={cornerFracs}
            cursorFrac={cursorFrac}
            onCursorFrac={onCursorFrac}
            tooltip={(f) => {
              const cornerLabel = nearestCornerLabel(corners, cornerFracs, f);
              if (!bestSlip) return null;
              return (
                <div className="space-y-1">
                  <ChartTooltip frac={f} cornerLabel={cornerLabel} rows={[]} />
                  <div className="font-mono tabular-nums text-app-text-dim space-y-0.5">
                    {SLIP_CORNERS.map((c) => (
                      <div key={c.key} className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full inline-block" style={{ background: c.color }} />
                        {c.label}: {valueAt(bestSlip, bestSlip.combinedSlip![c.key], f).toFixed(2)}
                      </div>
                    ))}
                  </div>
                </div>
              );
            }}
          >
            {({ x, y }) => (
              <>
                {bestSlip &&
                  SLIP_CORNERS.map((c) => <polyline key={c.key} points={gPolyline(bestSlip, bestSlip.combinedSlip![c.key], x, y)} fill="none" stroke={c.color} strokeWidth={1.6} opacity={0.9} />)}
              </>
            )}
          </Lane>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-app-compact text-app-text-dim">
            {SLIP_CORNERS.map((c) => (
              <span key={c.key} className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: c.color }} />
                {c.label}
              </span>
            ))}
          </div>
        </div>
      )}

      <GgScatter traces={traces} bestLapId={bestLapId} cursorFrac={cursorFrac} />
    </div>
  );
}
