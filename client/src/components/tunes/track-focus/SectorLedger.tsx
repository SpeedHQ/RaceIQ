import { useMemo } from "react";
import { SetupRangeBar } from "@/components/SetupRangeBar";
import { type LapTrace, sampleAt } from "../../../lib/stint-traces";

interface SectorLedgerProps {
  traces: LapTrace[];
  bestLapId: number | null;
  /** Boundary lap-fractions between sectors (e.g. [s1End, s2End] for 3
   *  sectors), same source as the track map's sector-colored segments.
   *  Empty/invalid falls back to even thirds. */
  sectorBoundaryFracs: number[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
}

interface SectorDef {
  index: number;
  label: string;
  startFrac: number;
  endFrac: number;
  midFrac: number;
}

interface LedgerRow {
  sector: SectorDef;
  bestTimeS: number | null;
  minSpeedBest: number | null;
  topSpeedBest: number | null;
  medianSpeedBest: number | null;
  deltaWorst: number | null;
  dtLoss: number | null;
  spark: { throttle: number; brake: number; steer: number }[];
}

function sectorDefs(boundaryFracs: number[]): SectorDef[] {
  const sorted = [...boundaryFracs].filter((f) => f > 0 && f < 1).sort((a, b) => a - b);
  const bounds = sorted.length > 0 ? [0, ...sorted, 1] : [0, 1 / 3, 2 / 3, 1];
  const defs: SectorDef[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const startFrac = bounds[i];
    const endFrac = bounds[i + 1];
    defs.push({ index: i, label: `S${i + 1}`, startFrac, endFrac, midFrac: (startFrac + endFrac) / 2 });
  }
  return defs;
}

/** Duration (s) of a trace between two lap-fractions, via interpolated timeS. */
function sectorDuration(trace: LapTrace, startFrac: number, endFrac: number): number {
  return sampleAt(trace, "timeS", endFrac) - sampleAt(trace, "timeS", startFrac);
}

function sparkSamples(trace: LapTrace, startFrac: number, endFrac: number): { throttle: number; brake: number; steer: number }[] {
  const out: { throttle: number; brake: number; steer: number }[] = [];
  for (let i = 0; i < trace.n; i++) {
    const f = trace.frac[i];
    if (f >= startFrac && f <= endFrac) out.push({ throttle: trace.throttle[i], brake: trace.brake[i], steer: trace.steer[i] });
  }
  return out;
}

/** Min + top + median speed for a trace between two lap-fractions. */
function speedStats(trace: LapTrace, startFrac: number, endFrac: number): { min: number | null; top: number | null; median: number | null } {
  const vals: number[] = [];
  for (let i = 0; i < trace.n; i++) {
    const f = trace.frac[i];
    if (f >= startFrac && f <= endFrac) vals.push(trace.speedKmh[i]);
  }
  if (vals.length === 0) return { min: null, top: null, median: null };
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return {
    min: vals[0],
    top: vals[vals.length - 1],
    median: vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2,
  };
}

function buildRows(traces: LapTrace[], bestLapId: number | null, sectors: SectorDef[]): LedgerRow[] {
  if (traces.length === 0 || sectors.length === 0) return [];
  const bestTrace = traces.find((t) => t.lapId === bestLapId) ?? traces[0];
  const others = traces.filter((t) => t.lapId !== bestTrace.lapId && t.isValid);

  return sectors.map((sector) => {
    const bestTimeS = sectorDuration(bestTrace, sector.startFrac, sector.endFrac);

    let worstDt = Number.NEGATIVE_INFINITY;
    for (const t of others) {
      const dt = sectorDuration(t, sector.startFrac, sector.endFrac) - bestTimeS;
      if (dt > worstDt) worstDt = dt;
    }
    const dtLoss = Number.isFinite(worstDt) ? worstDt : null;
    const deltaWorst = dtLoss;

    const spark = sparkSamples(bestTrace, sector.startFrac, sector.endFrac);
    const { min: minSpeedBest, top: topSpeedBest, median: medianSpeedBest } = speedStats(bestTrace, sector.startFrac, sector.endFrac);

    return { sector, bestTimeS, minSpeedBest, topSpeedBest, medianSpeedBest, deltaWorst, dtLoss, spark };
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
  if (dv > 0.3) return "text-red-400";
  if (dv > 0.1) return "text-amber-400";
  return "text-emerald-400";
}

/**
 * Sector-by-sector ledger: same visual language and interaction model as
 * `CornerLedger` (left-aligned, full-width table, integrated time-loss bar,
 * inputs sparkline last column) but rows are the track's sectors (S1/S2/S3)
 * rather than individual corners. Sector boundaries are derived from the
 * focus lap's `SectorTimesLite` indices upstream (see `TrackFocusView`).
 */
export function SectorLedger({ traces, bestLapId, sectorBoundaryFracs, cursorFrac, onCursorFrac }: SectorLedgerProps) {
  const sectors = useMemo(() => sectorDefs(sectorBoundaryFracs), [sectorBoundaryFracs]);
  const rows = useMemo(() => buildRows(traces, bestLapId, sectors), [traces, bestLapId, sectors]);
  if (sectors.length === 0 || traces.length === 0) {
    return <div className="text-app-text-dim text-sm">No sector data available for this track.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Sector Ledger</div>
      <div className="rounded border border-app-border overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr>
              {["Sector", "Best time", "Speed range", "Δ worst", "Inputs (zone)"].map((h) => (
                <th key={h} className="text-left text-[10.5px] uppercase tracking-wider text-app-text-dim px-2.5 py-1.5 border-b border-app-border whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sp = sparkPath(r);
              const isActive = cursorFrac != null && cursorFrac >= r.sector.startFrac && cursorFrac <= r.sector.endFrac;
              return (
                <tr
                  key={r.sector.index}
                  onClick={() => onCursorFrac(r.sector.midFrac)}
                  className={`cursor-pointer border-b border-app-border last:border-0 hover:bg-app-surface-alt ${isActive ? "bg-app-surface-alt" : ""}`}
                >
                  <td className="text-left px-2.5 py-1.5 whitespace-nowrap">
                    <span className="font-semibold text-app-text">{r.sector.label}</span>{" "}
                    <span className="text-[11px] text-app-text-dim">
                      {(r.sector.startFrac * 100).toFixed(0)}–{(r.sector.endFrac * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="text-left px-2.5 py-1.5 font-mono tabular-nums text-app-text">{r.bestTimeS != null ? `${r.bestTimeS.toFixed(3)}s` : "—"}</td>
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
                  <td className={`text-left px-2.5 py-1.5 font-mono tabular-nums ${deltaColor(r.deltaWorst)}`}>
                    {r.deltaWorst != null ? `${r.deltaWorst >= 0 ? "+" : ""}${r.deltaWorst.toFixed(3)}` : "—"}
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
