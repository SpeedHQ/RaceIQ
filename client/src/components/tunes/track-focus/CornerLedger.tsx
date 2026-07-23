import { useMemo } from "react";
import type { TrackCorner } from "../../../hooks/queries";
import type { LapTrace } from "../../../lib/stint-traces";

interface CornerLedgerProps {
  traces: LapTrace[];
  bestLapId: number | null;
  cornerFracs: number[];
  corners: TrackCorner[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
}

/** Half-width (in lap-distance fraction) of the window around a corner's apex
 *  fraction used to pull zone samples out of each lap's trace. Matches the
 *  design mockup's `0.045` band (~9% of lap total). */
const ZONE_HALF_WIDTH = 0.045;

interface LedgerRow {
  corner: TrackCorner;
  frac: number;
  minSpeedBest: number | null;
  deltaBest: number | null;
  brakeVarPct: number | null;
  dtLoss: number | null;
  spark: { throttle: number; brake: number; steer: number }[];
}

function zoneIndices(frac: Float32Array, cf: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frac.length; i++) {
    if (Math.abs(frac[i] - cf) < ZONE_HALF_WIDTH) out.push(i);
  }
  return out;
}

function minOver(arr: Float32Array, idxs: number[]): number | null {
  if (idxs.length === 0) return null;
  let m = Number.POSITIVE_INFINITY;
  for (const i of idxs) if (arr[i] < m) m = arr[i];
  return Number.isFinite(m) ? m : null;
}

/** First index (within the zone) where brake exceeds a light threshold —
 *  approximates the driver's brake application point for that corner. */
function brakeOnsetFrac(trace: LapTrace, idxs: number[]): number | null {
  for (const i of idxs) {
    if (trace.brake[i] > 0.3) return trace.frac[i];
  }
  return null;
}

function stdDev(vals: number[]): number | null {
  if (vals.length < 2) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
  return Math.sqrt(variance);
}

/** Minimum lap-fraction separation between two detected apexes. */
const DETECT_MIN_GAP = 0.03;
/** Max corners synthesized when the track has no corner metadata. */
const DETECT_MAX_CORNERS = 14;

/** Fallback for tracks without corner metadata: detect apex zones as local
 *  minima of the best lap's (lightly smoothed) speed trace, mirroring how the
 *  `4-corner-ledger.html` mockup derived corners purely from telemetry. */
function detectCorners(trace: LapTrace): { corners: TrackCorner[]; fracs: number[] } {
  const n = trace.speedKmh.length;
  if (n < 16) return { corners: [], fracs: [] };
  // Light box smoothing to suppress sample noise.
  const smooth = new Float32Array(n);
  const W = 5;
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) { sum += trace.speedKmh[j]; cnt++; }
    smooth[i] = sum / cnt;
  }
  let vMax = 0;
  for (let i = 0; i < n; i++) if (smooth[i] > vMax) vMax = smooth[i];
  if (vMax <= 0) return { corners: [], fracs: [] };

  // Local minima that dip meaningfully below top speed.
  const cands: { frac: number; v: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (smooth[i] <= smooth[i - 1] && smooth[i] < smooth[i + 1] && smooth[i] < vMax * 0.85) {
      cands.push({ frac: trace.frac[i], v: smooth[i] });
    }
  }
  // Keep the slowest apex within each MIN_GAP window.
  cands.sort((a, b) => a.v - b.v);
  const kept: { frac: number; v: number }[] = [];
  for (const c of cands) {
    if (kept.length >= DETECT_MAX_CORNERS) break;
    if (kept.every((k) => Math.abs(k.frac - c.frac) >= DETECT_MIN_GAP)) kept.push(c);
  }
  kept.sort((a, b) => a.frac - b.frac);

  const corners = kept.map((k, i) => ({
    index: i,
    label: `T${i + 1}`,
    distanceStart: Math.max(0, k.frac - ZONE_HALF_WIDTH),
    distanceEnd: Math.min(1, k.frac + ZONE_HALF_WIDTH),
    apexDistance: k.frac,
  }));
  return { corners, fracs: kept.map((k) => k.frac) };
}

function buildRows(traces: LapTrace[], bestLapId: number | null, cornerFracs: number[], corners: TrackCorner[]): LedgerRow[] {
  if (traces.length === 0 || corners.length === 0) return [];
  const bestTrace = traces.find((t) => t.lapId === bestLapId) ?? traces[0];
  const others = traces.filter((t) => t.lapId !== bestTrace.lapId && t.isValid);

  return corners.map((corner, i) => {
    const cf = cornerFracs[i] ?? 0;
    const idxs = zoneIndices(bestTrace.frac, cf);
    const minSpeedBest = minOver(bestTrace.speedKmh, idxs);

    // Pick the "worst" other lap in this zone (largest cumulative time loss
    // vs the best lap across the zone) to drive the delta/verdict columns.
    let worst: LapTrace | null = null;
    let worstDt = Number.NEGATIVE_INFINITY;
    for (const t of others) {
      const oIdxs = zoneIndices(t.frac, cf);
      if (idxs.length < 2 || oIdxs.length < 2) continue;
      const bestSeg = bestTrace.timeS[idxs[idxs.length - 1]] - bestTrace.timeS[idxs[0]];
      const otherSeg = t.timeS[oIdxs[oIdxs.length - 1]] - t.timeS[oIdxs[0]];
      const dt = otherSeg - bestSeg;
      if (dt > worstDt) {
        worstDt = dt;
        worst = t;
      }
    }

    const deltaBest = worst ? (minOver(worst.speedKmh, zoneIndices(worst.frac, cf)) ?? 0) - (minSpeedBest ?? 0) : null;
    const dtLoss = worst && Number.isFinite(worstDt) ? worstDt : null;

    const onsets: number[] = [];
    for (const t of traces) {
      const f = brakeOnsetFrac(t, zoneIndices(t.frac, cf));
      if (f != null) onsets.push(f);
    }
    const brakeVarPct = onsets.length >= 2 ? (stdDev(onsets) ?? 0) * 100 : null;

    const spark = idxs.map((idx) => ({ throttle: bestTrace.throttle[idx], brake: bestTrace.brake[idx], steer: bestTrace.steer[idx] }));

    return { corner, frac: cf, minSpeedBest, deltaBest, brakeVarPct, dtLoss, spark };
  });
}

function sparkPath(row: LedgerRow) {
  const w = 110;
  const h = 24;
  const n = row.spark.length;
  if (n < 2) return null;
  let t = "";
  let b = "";
  let st = "";
  row.spark.forEach((s, i) => {
    const x = (i / (n - 1)) * w;
    t += `${i ? "L" : "M"}${x.toFixed(1)} ${(h - s.throttle * h).toFixed(1)} `;
    b += `${i ? "L" : "M"}${x.toFixed(1)} ${(h - s.brake * h).toFixed(1)} `;
    st += `${i ? "L" : "M"}${x.toFixed(1)} ${(h / 2 - (s.steer * h) / 2).toFixed(1)} `;
  });
  return { w, h, t, b, st };
}

function deltaColor(dv: number | null): string {
  if (dv == null) return "text-app-text-dim";
  if (dv < -4) return "text-red-400";
  if (dv < -1.5) return "text-amber-400";
  return "text-emerald-400";
}

function brakeVarColor(v: number | null): string {
  if (v == null) return "text-app-text-dim";
  if (v > 1.2) return "text-red-400";
  if (v > 0.6) return "text-amber-400";
  return "text-emerald-400";
}

function Verdict({ dtLoss, brakeVarPct }: { dtLoss: number | null; brakeVarPct: number | null }) {
  if (dtLoss != null && dtLoss > 0.06) {
    return <span className="text-[10.5px] px-1.5 py-0.5 rounded-full border border-red-900 bg-red-950/40 text-red-300">losing {dtLoss.toFixed(2)}s</span>;
  }
  if (brakeVarPct != null && brakeVarPct > 1.2) {
    return <span className="text-[10.5px] px-1.5 py-0.5 rounded-full border border-amber-900 bg-amber-950/40 text-amber-300">inconsistent</span>;
  }
  return <span className="text-[10.5px] px-1.5 py-0.5 rounded-full border border-emerald-900 bg-emerald-950/40 text-emerald-300">on pace</span>;
}

/**
 * Corner-by-corner ledger: focus/best lap min speed, spread vs the worst lap
 * in the stint, brake-point variance across the stint, an input sparkline for
 * the zone, estimated time loss, and a verdict pill. Mirrors
 * `design-mockups/tune-review/4-corner-ledger.html`, adapted to the traces
 * and corner data already resolved for Track Focus.
 */
export function CornerLedger({ traces, bestLapId, cornerFracs, corners, cursorFrac, onCursorFrac }: CornerLedgerProps) {
  // When the track has no corner metadata, fall back to detecting apex zones
  // from the best lap's speed trace (as the mockup did from raw telemetry).
  const effective = useMemo(() => {
    if (corners.length > 0 || traces.length === 0) return { corners, fracs: cornerFracs };
    const bestTrace = traces.find((t) => t.lapId === bestLapId) ?? traces[0];
    const detected = detectCorners(bestTrace);
    return { corners: detected.corners, fracs: detected.fracs };
  }, [traces, bestLapId, cornerFracs, corners]);

  const rows = useMemo(
    () => buildRows(traces, bestLapId, effective.fracs, effective.corners),
    [traces, bestLapId, effective],
  );

  const waterfall = useMemo(() => {
    const withLoss = rows.filter((r) => r.dtLoss != null);
    const sorted = [...withLoss].sort((a, b) => (b.dtLoss ?? 0) - (a.dtLoss ?? 0));
    const max = Math.max(...sorted.map((r) => r.dtLoss ?? 0), 0.01);
    return { sorted, max };
  }, [rows]);

  if (effective.corners.length === 0 || traces.length === 0) {
    return <div className="text-app-text-dim text-sm">No corner data available for this track.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Corner Ledger</div>
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_260px] gap-3">
        <div className="rounded border border-app-border overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead>
              <tr>
                {["Corner", "Min speed", "Δ worst", "Brake pt var", "Inputs (zone)", "Δ time", "Verdict"].map((h) => (
                  <th key={h} className="text-left text-[10.5px] uppercase tracking-wider text-app-text-dim px-2.5 py-1.5 border-b border-app-border whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const sp = sparkPath(r);
                const isActive = cursorFrac != null && Math.abs(cursorFrac - r.frac) < ZONE_HALF_WIDTH;
                return (
                  <tr
                    key={r.corner.index}
                    onClick={() => onCursorFrac(r.frac)}
                    className={`cursor-pointer border-b border-app-border last:border-0 hover:bg-app-surface-alt ${isActive ? "bg-app-surface-alt" : ""}`}
                  >
                    <td className="px-2.5 py-1.5 whitespace-nowrap">
                      <span className="font-semibold text-app-text">{r.corner.label}</span> <span className="text-[11px] text-app-text-dim">{(r.frac * 100).toFixed(0)}%</span>
                    </td>
                    <td className="px-2.5 py-1.5 font-mono tabular-nums text-app-text">{r.minSpeedBest != null ? `${r.minSpeedBest.toFixed(0)} km/h` : "—"}</td>
                    <td className={`px-2.5 py-1.5 font-mono tabular-nums ${deltaColor(r.deltaBest)}`}>{r.deltaBest != null ? `${r.deltaBest >= 0 ? "+" : ""}${r.deltaBest.toFixed(1)}` : "—"}</td>
                    <td className={`px-2.5 py-1.5 font-mono tabular-nums ${brakeVarColor(r.brakeVarPct)}`}>{r.brakeVarPct != null ? `±${r.brakeVarPct.toFixed(1)}%` : "—"}</td>
                    <td className="px-2.5 py-1.5">
                      {sp ? (
                        <svg width={sp.w} height={sp.h} className="block">
                          <path d={sp.st} fill="none" stroke="var(--color-ch-steer, #0891b2)" strokeWidth={1} opacity={0.8} />
                          <path d={sp.t} fill="none" stroke="var(--color-ch-throttle, #059669)" strokeWidth={1.4} />
                          <path d={sp.b} fill="none" stroke="var(--color-ch-brake, #ef4444)" strokeWidth={1.4} />
                        </svg>
                      ) : (
                        <span className="text-app-text-dim">—</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 font-mono tabular-nums text-app-text">{r.dtLoss != null && r.dtLoss > 0.005 ? `+${r.dtLoss.toFixed(3)}` : "—"}</td>
                    <td className="px-2.5 py-1.5">
                      <Verdict dtLoss={r.dtLoss} brakeVarPct={r.brakeVarPct} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="rounded bg-app-surface border border-app-border p-3 space-y-1.5">
          <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">Where time goes</div>
          {waterfall.sorted.length === 0 ? (
            <div className="text-app-text-dim text-xs">No time-loss data yet.</div>
          ) : (
            <div className="space-y-1">
              {waterfall.sorted.map((r) => {
                const dt = r.dtLoss ?? 0;
                const w = Math.max(2, (dt / waterfall.max) * 100);
                const barColor = dt > 0.06 ? "var(--color-dynamics-red, #ef4444)" : dt > 0.03 ? "var(--color-dynamics-amber, #f59e0b)" : "var(--color-app-accent, #22d3ee)";
                return (
                  <button type="button" key={r.corner.index} onClick={() => onCursorFrac(r.frac)} className="flex items-center gap-2 w-full text-left">
                    <span className="text-[10.5px] text-app-text-dim w-8 shrink-0 text-right">{r.corner.label}</span>
                    <span className="flex-1 h-3.5 bg-app-surface-alt rounded-sm overflow-hidden">
                      <span className="block h-full rounded-sm" style={{ width: `${w}%`, background: barColor }} />
                    </span>
                    <span className="text-[10px] font-mono tabular-nums text-app-text-dim w-10 shrink-0">{dt > 0.005 ? `+${dt.toFixed(2)}` : "—"}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
