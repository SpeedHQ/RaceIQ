import { useMemo, useState } from "react";
import { WHEEL_COLOR_VARS } from "@/lib/colors";
import { indexAtFrac, type LapTrace, type TireAverages, type TireTraces } from "../../../lib/stint-traces";
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
  { key: "FL", label: "FL", color: WHEEL_COLOR_VARS[0] },
  { key: "FR", label: "FR", color: WHEEL_COLOR_VARS[1] },
  { key: "RL", label: "RL", color: WHEEL_COLOR_VARS[2] },
  { key: "RR", label: "RR", color: WHEEL_COLOR_VARS[3] },
];

const REF_LINES_TEMP = [80, 90, 100];
const H = 160;

type Mode = "temp" | "pressure" | "brake";

interface MetricConfig {
  mode: Mode;
  title: string;
  avgUnit: string;
  laneUnit: string;
  defaultDomain: [number, number];
  /** Fixed y-domain for the avg chart (temp only); null = auto-fit. */
  fixedAvgDomain: [number, number] | null;
  refLines: number[] | null;
  pad: number;
  fmt: (v: number) => string;
}

const METRICS: MetricConfig[] = [
  { mode: "temp", title: "Tyres — avg temperature (°C)", avgUnit: "°C", laneUnit: "temp per lap (°C)", defaultDomain: [60, 120], fixedAvgDomain: [60, 120], refLines: REF_LINES_TEMP, pad: 2, fmt: (v) => `${v.toFixed(1)}°C` },
  { mode: "pressure", title: "Tyres — avg pressure (bar)", avgUnit: "bar", laneUnit: "pressure per lap (bar)", defaultDomain: [1.5, 2.5], fixedAvgDomain: null, refLines: null, pad: 0.02, fmt: (v) => `${v.toFixed(2)} bar` },
  { mode: "brake", title: "Brakes — avg brake temp (°C)", avgUnit: "°C", laneUnit: "brake temp per lap (°C)", defaultDomain: [100, 600], fixedAvgDomain: null, refLines: null, pad: 2, fmt: (v) => `${v.toFixed(0)}°C` },
];

function avgOf(t: LapTrace, mode: Mode): TireAverages | null {
  return mode === "temp" ? t.tire : mode === "pressure" ? t.pressure : t.brakeTemp;
}
function traceOf(t: LapTrace, mode: Mode): TireTraces | null {
  return mode === "temp" ? t.tireTempTrace : mode === "pressure" ? t.pressureTrace : t.brakeTempTrace;
}

function tirePolyline(t: LapTrace, arr: Float32Array, x: (f: number) => number, y: (v: number) => number): string {
  const pts: string[] = [];
  for (let i = 0; i < t.n; i++) pts.push(`${x(t.frac[i]).toFixed(1)},${y(arr[i]).toFixed(1)}`);
  return pts.join(" ");
}

/** OLS slope+intercept of `pts` (index -> value). Null when fewer than 2 points. */
function olsTrend(pts: { i: number; v: number }[]): { slope: number; intercept: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.i;
    sy += p.v;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.i - mx) * (p.v - my);
    den += (p.i - mx) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

/**
 * Tyres tab: three always-visible metric sections (tyre temperature, tyre
 * pressure, brake temperature). Each shows a per-lap average chart at the top
 * (one line per corner, laps along x, with a dashed OLS trend line per corner
 * to read stint-wide heating/pressure drift), then one lane per corner with
 * every lap's per-distance trace — dim per lap, best lap in accent, invalid
 * laps in red, matching the Consistency tab's visual language.
 */
export function TiresPanel({ traces, bestLapId = null, cornerFracs = [], cursorFrac = null, onCursorFrac = () => {} }: TiresPanelProps) {
  const laps = useMemo(() => traces.filter((t): t is LapTrace => !!t), [traces]);

  return (
    <div className="space-y-5">
      {METRICS.map((cfg) => (
        <TireMetricSection
          key={cfg.mode}
          cfg={cfg}
          laps={laps}
          bestLapId={bestLapId}
          cornerFracs={cornerFracs}
          cursorFrac={cursorFrac}
          onCursorFrac={onCursorFrac}
        />
      ))}
    </div>
  );
}

function TireMetricSection({
  cfg,
  laps,
  bestLapId,
  cornerFracs,
  cursorFrac,
  onCursorFrac,
}: {
  cfg: MetricConfig;
  laps: LapTrace[];
  bestLapId: number | null;
  cornerFracs: number[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
}) {
  const { mode } = cfg;
  const { ref: wrapRef, width: bw } = useMeasuredWidth<HTMLDivElement>();
  const [expanded, setExpanded] = useState(false);

  const domain = useMemo<[number, number]>(() => {
    if (cfg.fixedAvgDomain) return cfg.fixedAvgDomain;
    const all: number[] = [];
    for (const t of laps) {
      const src = avgOf(t, mode);
      if (src) all.push(src.FL, src.FR, src.RL, src.RR);
    }
    if (all.length === 0) return cfg.defaultDomain;
    return [Math.min(...all) - cfg.pad, Math.max(...all) + cfg.pad];
  }, [laps, cfg]);

  // Shared y-domain for the per-corner lanes so all four are comparable.
  const laneDomain = useMemo<[number, number]>(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of laps) {
      const tt = traceOf(t, mode);
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
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return cfg.defaultDomain;
    const pad = Math.max(cfg.pad, (hi - lo) * 0.08);
    return [lo - pad, hi + pad];
  }, [laps, cfg]);

  const lapsWithTrace = useMemo(() => laps.filter((t) => traceOf(t, mode)), [laps, mode]);

  // Per-corner OLS trend across laps, computed on the valid (non-zero) points.
  const trends = useMemo(() => {
    const out: Record<string, { slope: number; intercept: number } | null> = {};
    for (const c of CORNERS) {
      const pts: { i: number; v: number }[] = [];
      laps.forEach((t, i) => {
        const v = avgOf(t, mode)?.[c.key];
        if (v != null && v !== 0) pts.push({ i, v });
      });
      out[c.key] = olsTrend(pts);
    }
    return out;
  }, [laps, mode]);

  const hasData = laps.some((t) => avgOf(t, mode));
  if (!hasData) return null;

  const x0 = 30;
  const x1 = bw - 10;
  const y0 = 10;
  const y1 = H - 20;
  const [min, max] = domain;
  const x = (i: number) => (laps.length <= 1 ? (x0 + x1) / 2 : x0 + (i / (laps.length - 1)) * (x1 - x0));
  const y = (v: number) => y1 - ((v - min) / (max - min)) * (y1 - y0);

  return (
    <div ref={wrapRef} className="space-y-2">
      <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">{cfg.title}</div>
      <svg viewBox={`0 0 ${bw} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="var(--app-surface-alt)" fillOpacity={0.35} rx={4} />
        {cfg.refLines?.map((t) => (
          <g key={t}>
            <line x1={x0} x2={x1} y1={y(t)} y2={y(t)} stroke="var(--app-border)" strokeDasharray="2 4" />
            <text x={x0 - 4} y={y(t) + 3} textAnchor="end" fontSize={9} fill="var(--app-text-dim)">
              {t}
            </text>
          </g>
        ))}
        {CORNERS.map((c) => {
          const segs: string[] = [];
          let cur: string[] = [];
          laps.forEach((t, i) => {
            const v = avgOf(t, mode)?.[c.key];
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
          const tr = trends[c.key];
          return (
            <g key={c.key}>
              {segs.map((pts) => (
                <polyline key={pts} points={pts} fill="none" stroke={c.color} strokeWidth={1.6} />
              ))}
              {tr && laps.length > 1 && (
                <line
                  x1={x(0)}
                  y1={y(tr.intercept)}
                  x2={x(laps.length - 1)}
                  y2={y(tr.intercept + tr.slope * (laps.length - 1))}
                  stroke={c.color}
                  strokeWidth={1.2}
                  strokeDasharray="5 4"
                  opacity={0.55}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-app-text-dim">
        {CORNERS.map((c) => {
          const tr = trends[c.key];
          return (
            <span key={c.key} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: c.color }} />
              {c.label}
              {tr && laps.length > 1 && (
                <span className="tabular-nums opacity-70">
                  {tr.slope >= 0 ? "+" : ""}
                  {cfg.fmt(tr.slope)}/lap
                </span>
              )}
            </span>
          );
        })}
      </div>

      {/* Per-corner lanes: collapsed by default — the averages chart above is the summary. */}
      {lapsWithTrace.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-app-text-dim hover:text-app-text border border-app-border rounded px-2 py-1"
        >
          <span className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
          {expanded ? "Hide per-wheel detail" : "Show per-wheel detail"}
        </button>
      )}
      {expanded &&
        lapsWithTrace.length > 0 &&
        CORNERS.map((c) => (
          <div key={c.key} className="space-y-1">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-app-text-dim">
              <span className="w-2.5 h-1.5 rounded-sm inline-block" style={{ background: c.color }} />
              {c.label} — {cfg.laneUnit}
            </div>
            <Lane
              height={80}
              domain={laneDomain}
              cornerFracs={cornerFracs}
              cursorFrac={cursorFrac}
              onCursorFrac={onCursorFrac}
              tooltip={(f) => {
                const best = lapsWithTrace.find((t) => t.lapId === bestLapId);
                const tt = best ? traceOf(best, mode) : null;
                if (!tt) return null;
                const idx = indexAtFrac(best!, f);
                return (
                  <span>
                    best lap {c.label}: {cfg.fmt(tt[c.key][idx])}
                  </span>
                );
              }}
            >
              {({ x: lx, y: ly }) => (
                <>
                  {lapsWithTrace
                    .filter((t) => t.lapId !== bestLapId)
                    .map((t) => {
                      const tt = traceOf(t, mode);
                      if (!tt) return null;
                      return (
                        <polyline
                          key={t.lapId}
                          points={tirePolyline(t, tt[c.key], lx, ly)}
                          fill="none"
                          stroke={t.isValid ? "var(--app-text-dim)" : "var(--status-danger)"}
                          strokeWidth={1}
                          opacity={t.isValid ? 0.35 : 0.55}
                        />
                      );
                    })}
                  {(() => {
                    const best = lapsWithTrace.find((t) => t.lapId === bestLapId);
                    const tt = best ? traceOf(best, mode) : null;
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
