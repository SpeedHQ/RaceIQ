import { useMemo, useState } from "react";
import { SetupRangeBar } from "@/components/SetupRangeBar";
import type { TrackCorner } from "../../../hooks/queries";
import type { LapTrace } from "../../../lib/stint-traces";
import { detectCorners, ZONE_HALF_WIDTH } from "./detect-corners";

interface CornerLedgerProps {
  traces: LapTrace[];
  bestLapId: number | null;
  cornerFracs: number[];
  corners: TrackCorner[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
  /** Fired on row hover with the per-lap brake/throttle onset fracs for that
   *  corner (null on leave) — used to overlay the points on the track map. */
  onHoverPoints?: (pts: { brake: number[]; throttle: number[] } | null) => void;
}

interface LedgerRow {
  corner: TrackCorner;
  frac: number;
  minSpeedBest: number | null;
  topSpeedBest: number | null;
  medianSpeedBest: number | null;
  deltaBest: number | null;
  brakeVarPct: number | null;
  throttleVarPct: number | null;
  brakeOnsets: number[];
  throttleOnsets: number[];
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

function maxOver(arr: Float32Array, idxs: number[]): number | null {
  if (idxs.length === 0) return null;
  let m = Number.NEGATIVE_INFINITY;
  for (const i of idxs) if (arr[i] > m) m = arr[i];
  return Number.isFinite(m) ? m : null;
}

function medianOver(arr: Float32Array, idxs: number[]): number | null {
  if (idxs.length === 0) return null;
  const vals = idxs.map((i) => arr[i]).sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/** First index (within the zone) where brake exceeds a light threshold —
 *  approximates the driver's brake application point for that corner. */
function brakeOnsetFrac(trace: LapTrace, idxs: number[]): number | null {
  for (const i of idxs) {
    if (trace.brake[i] > 0.3) return trace.frac[i];
  }
  return null;
}

/** First index (within the zone) after the apex (min speed) where throttle is
 *  reapplied past a light threshold — approximates the driver's throttle
 *  pickup point for that corner. */
function throttleOnsetFrac(trace: LapTrace, idxs: number[]): number | null {
  if (idxs.length === 0) return null;
  let apexPos = 0;
  let minV = Number.POSITIVE_INFINITY;
  for (let k = 0; k < idxs.length; k++) {
    const v = trace.speedKmh[idxs[k]];
    if (v < minV) {
      minV = v;
      apexPos = k;
    }
  }
  for (let k = apexPos; k < idxs.length; k++) {
    const i = idxs[k];
    if (trace.throttle[i] > 0.3) return trace.frac[i];
  }
  return null;
}

function stdDev(vals: number[]): number | null {
  if (vals.length < 2) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
  return Math.sqrt(variance);
}

function buildRows(traces: LapTrace[], bestLapId: number | null, cornerFracs: number[], corners: TrackCorner[]): LedgerRow[] {
  if (traces.length === 0 || corners.length === 0) return [];
  const bestTrace = traces.find((t) => t.lapId === bestLapId) ?? traces[0];
  const others = traces.filter((t) => t.lapId !== bestTrace.lapId && t.isValid);

  return corners.map((corner, i) => {
    const cf = cornerFracs[i] ?? 0;
    const idxs = zoneIndices(bestTrace.frac, cf);
    const minSpeedBest = minOver(bestTrace.speedKmh, idxs);
    const topSpeedBest = maxOver(bestTrace.speedKmh, idxs);
    const medianSpeedBest = medianOver(bestTrace.speedKmh, idxs);

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

    const tOnsets: number[] = [];
    for (const t of traces) {
      const f = throttleOnsetFrac(t, zoneIndices(t.frac, cf));
      if (f != null) tOnsets.push(f);
    }
    const throttleVarPct = tOnsets.length >= 2 ? (stdDev(tOnsets) ?? 0) * 100 : null;

    const spark = idxs.map((idx) => ({ throttle: bestTrace.throttle[idx], brake: bestTrace.brake[idx], steer: bestTrace.steer[idx] }));

    return { corner, frac: cf, minSpeedBest, topSpeedBest, medianSpeedBest, deltaBest, brakeVarPct, throttleVarPct, brakeOnsets: onsets, throttleOnsets: tOnsets, dtLoss, spark };
  });
}

function sparkPath(row: LedgerRow) {
  const w = 170;
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
export function CornerLedger({ traces, bestLapId, cornerFracs, corners, cursorFrac, onCursorFrac, onHoverPoints }: CornerLedgerProps) {
  // When the track has no corner metadata, fall back to detecting apex zones
  // from the best lap's speed trace (as the mockup did from raw telemetry).
  const effective = useMemo(() => {
    if (corners.length > 0 || traces.length === 0) return { corners, fracs: cornerFracs };
    const bestTrace = traces.find((t) => t.lapId === bestLapId) ?? traces[0];
    const detected = detectCorners(bestTrace);
    return { corners: detected.corners, fracs: detected.fracs };
  }, [traces, bestLapId, cornerFracs, corners]);

  const rows = useMemo(() => buildRows(traces, bestLapId, effective.fracs, effective.corners), [traces, bestLapId, effective]);

  // Clicking a row pins its brake/throttle overlay on the track; hovering
  // another row previews it, and leaving falls back to the pinned corner
  // (or nothing). Clicking the pinned row again clears it.
  const [pinnedFrac, setPinnedFrac] = useState<number | null>(null);
  const pointsFor = (frac: number) => {
    const row = rows.find((r) => r.frac === frac);
    return row ? { brake: row.brakeOnsets, throttle: row.throttleOnsets } : null;
  };

  if (effective.corners.length === 0 || traces.length === 0) {
    return <div className="text-app-text-dim text-sm">No corner data available for this track.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Corner Ledger</div>
      <div className="rounded border border-app-border overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr>
              {["Corner", "Speed range", "Δ worst", "Brake pt var", "Throttle pt var", "Verdict", "Inputs (zone)"].map((h) => (
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
                  onClick={() => {
                    onCursorFrac(r.frac);
                    const nextPinned = pinnedFrac === r.frac ? null : r.frac;
                    setPinnedFrac(nextPinned);
                    onHoverPoints?.(nextPinned == null ? null : { brake: r.brakeOnsets, throttle: r.throttleOnsets });
                  }}
                  onMouseEnter={() => onHoverPoints?.({ brake: r.brakeOnsets, throttle: r.throttleOnsets })}
                  onMouseLeave={() => onHoverPoints?.(pinnedFrac == null ? null : pointsFor(pinnedFrac))}
                  className={`cursor-pointer border-b border-app-border last:border-0 hover:bg-app-surface-alt ${pinnedFrac === r.frac ? "bg-app-accent/10 ring-1 ring-inset ring-app-accent/40" : isActive ? "bg-app-surface-alt" : ""}`}
                >
                  <td className="text-left px-2.5 py-1.5 whitespace-nowrap">
                    <span className="font-semibold text-app-text">{r.corner.label}</span> <span className="text-[11px] text-app-text-dim">{(r.frac * 100).toFixed(0)}%</span>
                  </td>
                  <td
                    className="text-left px-2.5 py-1.5"
                    title={
                      r.minSpeedBest != null && r.medianSpeedBest != null && r.topSpeedBest != null
                        ? `min ${r.minSpeedBest.toFixed(0)} · median ${r.medianSpeedBest.toFixed(0)} · max ${r.topSpeedBest.toFixed(0)} km/h`
                        : undefined
                    }
                  >
                    {r.minSpeedBest != null && r.medianSpeedBest != null && r.topSpeedBest != null ? (
                      <div className="flex items-center gap-2">
                        <span className="w-8 text-right font-mono tabular-nums text-[10.5px] text-app-text-dim shrink-0">{r.minSpeedBest.toFixed(0)}</span>
                        <div className="w-32 shrink-0">
                          <SetupRangeBar min={r.minSpeedBest} max={r.topSpeedBest} median={r.medianSpeedBest} values={[r.minSpeedBest, r.medianSpeedBest, r.topSpeedBest]} showMedianLabel />
                        </div>
                        <span className="w-14 text-left font-mono tabular-nums text-[10.5px] text-app-text-dim shrink-0">{r.topSpeedBest.toFixed(0)} km/h</span>
                      </div>
                    ) : (
                      <span className="font-mono text-app-text">—</span>
                    )}
                  </td>
                  <td className={`text-left px-2.5 py-1.5 font-mono tabular-nums ${deltaColor(r.deltaBest)}`}>
                    {r.deltaBest != null ? `${r.deltaBest >= 0 ? "+" : ""}${r.deltaBest.toFixed(1)}` : "—"}
                  </td>
                  <td className={`text-left px-2.5 py-1.5 font-mono tabular-nums ${brakeVarColor(r.brakeVarPct)}`}>{r.brakeVarPct != null ? `±${r.brakeVarPct.toFixed(1)}%` : "—"}</td>
                  <td className={`text-left px-2.5 py-1.5 font-mono tabular-nums ${brakeVarColor(r.throttleVarPct)}`}>{r.throttleVarPct != null ? `±${r.throttleVarPct.toFixed(1)}%` : "—"}</td>
                  <td className="text-left px-2.5 py-1.5">
                    <Verdict dtLoss={r.dtLoss} brakeVarPct={r.brakeVarPct} />
                  </td>
                  <td className="text-left px-2.5 py-1.5">
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
