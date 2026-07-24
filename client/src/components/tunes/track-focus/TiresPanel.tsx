import { useMemo, useState } from "react";
import { indexAtFrac, type LapTrace, type TireAverages } from "../../../lib/stint-traces";
import { Lane } from "./Lane";
import { useMeasuredWidth } from "./use-measured-width";

interface TiresPanelProps {
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

const REF_LINES_TEMP = [80, 90, 100];
const H = 160;

function tirePolyline(t: LapTrace, arr: Float32Array, x: (f: number) => number, y: (v: number) => number): string {
  const pts: string[] = [];
  for (let i = 0; i < t.n; i++) pts.push(`${x(t.frac[i]).toFixed(1)},${y(arr[i]).toFixed(1)}`);
  return pts.join(" ");
}

/**
 * Tyres tab: per-lap average tyre temp/pressure at the top (one line per
 * corner, laps along x), then one lane per corner showing every lap's
 * per-distance trace — dim lines per lap, best lap in accent, invalid laps
 * in red, matching the Consistency tab's visual language.
 */
export function TiresPanel({ traces, bestLapId = null, cornerFracs = [], cursorFrac = null, onCursorFrac = () => {} }: TiresPanelProps) {
  const [mode, setMode] = useState<"temp" | "pressure">("temp");
  const { ref: wrapRef, width: bw } = useMeasuredWidth<HTMLDivElement>();

  const laps = useMemo(() => traces.filter((t): t is LapTrace => !!t), [traces]);

  const domain = useMemo<[number, number]>(() => {
    if (mode === "temp") return [60, 120];
    const all: number[] = [];
    for (const t of laps) {
      const p = t.pressure;
      if (p) all.push(p.FL, p.FR, p.RL, p.RR);
    }
    if (all.length === 0) return [1.5, 2.5];
    return [Math.min(...all) - 0.05, Math.max(...all) + 0.05];
  }, [laps, mode]);

  // Shared y-domain for the per-corner lanes so all four are comparable.
  const laneDomain = useMemo<[number, number]>(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of laps) {
      const tt = mode === "temp" ? t.tireTempTrace : t.pressureTrace;
      if (!tt) continue;
      for (const c of CORNERS) {
        const arr = tt[c.key];
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return mode === "temp" ? [60, 120] : [1.5, 2.5];
    const pad = mode === "temp" ? Math.max(2, (hi - lo) * 0.08) : Math.max(0.02, (hi - lo) * 0.08);
    return [lo - pad, hi + pad];
  }, [laps, mode]);

  const lapsWithTrace = useMemo(() => laps.filter((t) => (mode === "temp" ? t.tireTempTrace : t.pressureTrace)), [laps, mode]);

  const x0 = 30;
  const x1 = bw - 10;
  const y0 = 10;
  const y1 = H - 20;
  const [min, max] = domain;
  const x = (i: number) => (laps.length <= 1 ? (x0 + x1) / 2 : x0 + (i / (laps.length - 1)) * (x1 - x0));
  const y = (v: number) => y1 - ((v - min) / (max - min)) * (y1 - y0);

  return (
    <div ref={wrapRef} className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Tyres — avg {mode === "temp" ? "temperature (°C)" : "pressure (bar)"}</div>
        <div className="flex gap-1">
          {(["temp", "pressure"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`text-[10px] px-2 py-0.5 rounded border ${mode === m ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"}`}
            >
              {m === "temp" ? "Temp" : "Pressure"}
            </button>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${bw} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="rgba(30,41,59,0.35)" rx={4} />
        {mode === "temp" &&
          REF_LINES_TEMP.map((t) => (
            <g key={t}>
              <line x1={x0} x2={x1} y1={y(t)} y2={y(t)} stroke="var(--color-app-border, #2a2a2a)" strokeDasharray="2 4" />
              <text x={x0 - 4} y={y(t) + 3} textAnchor="end" fontSize={9} fill="var(--color-app-text-dim, #7a8ea0)">
                {t}
              </text>
            </g>
          ))}
        {CORNERS.map((c) => {
          const segs: string[] = [];
          let cur: string[] = [];
          laps.forEach((t, i) => {
            const src = mode === "temp" ? t.tire : t.pressure;
            const v = src?.[c.key];
            if (v == null || v === 0) {
              if (cur.length) {
                segs.push(cur.join(" "));
                cur = [];
              }
              return;
            }
            cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
          });
          if (cur.length) segs.push(cur.join(" "));
          return (
            <g key={c.key}>
              {segs.map((pts) => (
                <polyline key={pts} points={pts} fill="none" stroke={c.color} strokeWidth={1.6} />
              ))}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-app-text-dim">
        {CORNERS.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: c.color }} />
            {c.label}
          </span>
        ))}
      </div>

      {/* Per-corner lanes: every lap's per-distance trace, best lap in accent. */}
      {lapsWithTrace.length > 0 &&
        CORNERS.map((c) => (
          <div key={c.key} className="space-y-1">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-app-text-dim">
              <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: c.color }} />
              {c.label} — {mode === "temp" ? "temp per lap (°C)" : "pressure per lap (bar)"}
            </div>
            <Lane
              height={80}
              domain={laneDomain}
              cornerFracs={cornerFracs}
              cursorFrac={cursorFrac}
              onCursorFrac={onCursorFrac}
              tooltip={(f) => {
                const best = lapsWithTrace.find((t) => t.lapId === bestLapId);
                const tt = best ? (mode === "temp" ? best.tireTempTrace : best.pressureTrace) : null;
                if (!tt) return null;
                const idx = indexAtFrac(best!, f);
                const v = tt[c.key][idx];
                return (
                  <span>
                    best lap {c.label}: {mode === "temp" ? `${v.toFixed(1)}°C` : `${v.toFixed(2)} bar`}
                  </span>
                );
              }}
            >
              {({ x: lx, y: ly }) => (
                <>
                  {lapsWithTrace
                    .filter((t) => t.lapId !== bestLapId)
                    .map((t) => {
                      const tt = mode === "temp" ? t.tireTempTrace : t.pressureTrace;
                      if (!tt) return null;
                      return (
                        <polyline
                          key={t.lapId}
                          points={tirePolyline(t, tt[c.key], lx, ly)}
                          fill="none"
                          stroke={t.isValid ? "var(--color-app-text-dim, #7a8ea0)" : "var(--color-dynamics-red, #ef4444)"}
                          strokeWidth={1}
                          opacity={t.isValid ? 0.35 : 0.55}
                        />
                      );
                    })}
                  {(() => {
                    const best = lapsWithTrace.find((t) => t.lapId === bestLapId);
                    const tt = best ? (mode === "temp" ? best.tireTempTrace : best.pressureTrace) : null;
                    return best && tt ? <polyline points={tirePolyline(best, tt[c.key], lx, ly)} fill="none" stroke={c.color} strokeWidth={1.8} /> : null;
                  })()}
                </>
              )}
            </Lane>
          </div>
        ))}
    </div>
  );
}
