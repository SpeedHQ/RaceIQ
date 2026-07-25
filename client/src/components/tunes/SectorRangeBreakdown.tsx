import type { TelemetryPacket } from "@shared/types";

interface SectorTimes {
  times: [number, number, number];
  s1Idx: number;
  s2Idx: number;
}

export type MetricKey = "tyreTemp" | "brakeTemp" | "pressure" | "wear";
export const CORNERS = ["FL", "FR", "RL", "RR"] as const;
export type CornerKey = (typeof CORNERS)[number];

export interface MetricDef {
  key: MetricKey;
  label: string;
  unit: string;
  accent: string;
  semantic?: boolean; // colour the avg by hot/cold bands (tyre temp only)
  sel: Record<CornerKey, (p: TelemetryPacket) => number | undefined>;
}

export const METRICS: MetricDef[] = [
  {
    key: "tyreTemp",
    label: "Tyre temp",
    unit: "°C",
    accent: "#34d399",
    semantic: true,
    sel: { FL: (p) => p.TireTempFL, FR: (p) => p.TireTempFR, RL: (p) => p.TireTempRL, RR: (p) => p.TireTempRR },
  },
  {
    key: "brakeTemp",
    label: "Brake temp",
    unit: "°C",
    accent: "#fb923c",
    sel: { FL: (p) => p.BrakeTempFrontLeft, FR: (p) => p.BrakeTempFrontRight, RL: (p) => p.BrakeTempRearLeft, RR: (p) => p.BrakeTempRearRight },
  },
  {
    key: "pressure",
    label: "Pressure",
    unit: "psi",
    accent: "#22d3ee",
    sel: { FL: (p) => p.TirePressureFrontLeft, FR: (p) => p.TirePressureFrontRight, RL: (p) => p.TirePressureRearLeft, RR: (p) => p.TirePressureRearRight },
  },
  {
    key: "wear",
    label: "Wear",
    unit: "%",
    accent: "#fbbf24",
    sel: { FL: (p) => p.TireWearFL, FR: (p) => p.TireWearFR, RL: (p) => p.TireWearRL, RR: (p) => p.TireWearRR },
  },
];

export interface Range {
  min: number;
  avg: number;
  max: number;
  n: number;
}

export interface SectorRangeModel {
  /** Per-sector corner ranges, index 0..2 = S1..S3. */
  sectors: Record<CornerKey, Range>[];
  /** Shared value domain across all sectors, for comparable bar scales. */
  domain: [number, number];
}

/** Compute per-sector corner ranges for a metric, on a shared domain. */
export function buildSectorRanges(telemetry: TelemetryPacket[], sectorTimes: SectorTimes | null, metric: MetricDef): SectorRangeModel | null {
  if (telemetry.length < 5) return null;

  const n = telemetry.length;
  const s1 = sectorTimes && sectorTimes.s1Idx > 0 ? Math.min(sectorTimes.s1Idx, n - 1) : Math.floor(n / 3);
  const s2 = sectorTimes && sectorTimes.s2Idx > s1 ? Math.min(sectorTimes.s2Idx, n - 1) : Math.floor((2 * n) / 3);

  const slices = [telemetry.slice(0, s1), telemetry.slice(s1, s2), telemetry.slice(s2)];
  const skipZero = metric.key !== "wear"; // wear of 0 is valid; temp of 0 = unpopulated

  const sectors = slices.map((frames) => Object.fromEntries(CORNERS.map((c) => [c, rangeOf(frames, metric.sel[c], skipZero)])) as Record<CornerKey, Range>);

  let gMin = Number.POSITIVE_INFINITY;
  let gMax = Number.NEGATIVE_INFINITY;
  for (const sec of sectors) {
    for (const c of CORNERS) {
      const r = sec[c];
      if (r.n === 0) continue;
      if (r.min < gMin) gMin = r.min;
      if (r.max > gMax) gMax = r.max;
    }
  }
  if (!Number.isFinite(gMin)) return { sectors, domain: [0, 1] };
  const pad = Math.max(metric.key === "wear" ? 1 : 4, (gMax - gMin) * 0.15);
  return { sectors, domain: [Math.floor(gMin - pad), Math.ceil(gMax + pad)] };
}

/** Compute per-corner ranges for a metric over a whole telemetry slice (no
 *  sector split), on a shared padded domain — used by the live test dashboard
 *  where the current lap is still in progress. */
export function buildLiveRanges(telemetry: TelemetryPacket[], metric: MetricDef): { ranges: Record<CornerKey, Range>; domain: [number, number] } | null {
  if (telemetry.length < 5) return null;
  const skipZero = metric.key !== "wear";
  const ranges = Object.fromEntries(CORNERS.map((c) => [c, rangeOf(telemetry, metric.sel[c], skipZero)])) as Record<CornerKey, Range>;
  let gMin = Number.POSITIVE_INFINITY;
  let gMax = Number.NEGATIVE_INFINITY;
  for (const c of CORNERS) {
    const r = ranges[c];
    if (r.n === 0) continue;
    if (r.min < gMin) gMin = r.min;
    if (r.max > gMax) gMax = r.max;
  }
  if (!Number.isFinite(gMin)) return { ranges, domain: [0, 1] };
  const pad = Math.max(metric.key === "wear" ? 1 : 4, (gMax - gMin) * 0.15);
  return { ranges, domain: [Math.floor(gMin - pad), Math.ceil(gMax + pad)] };
}

/** Four corner bars (min→max fill, avg tick) on a shared domain. When `cursor`
 *  is supplied (from hovering the track map), a line marks the live value. */
export function CornerBars({
  ranges,
  domain,
  metric,
  height = 74,
  cursor,
}: {
  ranges: Record<CornerKey, Range>;
  domain: [number, number];
  metric: MetricDef;
  height?: number;
  cursor?: Partial<Record<CornerKey, number>>;
}) {
  const [lo, hi] = domain;
  const span = hi - lo || 1;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - lo) / span) * 100));

  return (
    <div className="flex items-end justify-between gap-1">
      {CORNERS.map((c) => {
        const r = ranges[c];
        const empty = r.n === 0;
        const color = metric.semantic ? bandColor(r.avg) : metric.accent;
        const cv = cursor?.[c];
        const hasCursor = cv != null && Number.isFinite(cv);
        return (
          <div key={c} className="flex flex-col items-center gap-1 flex-1 min-w-0">
            <div className="relative w-full max-w-[15px] rounded border border-app-border" style={{ height }}>
              {!empty && (
                <>
                  <div className="absolute left-0 right-0 rounded opacity-30" style={{ background: color, bottom: `${pct(r.min)}%`, top: `${100 - pct(r.max)}%` }} />
                  <div className="absolute left-[-2px] right-[-2px] h-[2px]" style={{ background: color, bottom: `${pct(r.avg)}%` }} />
                </>
              )}
              {hasCursor && (
                <div
                  className="absolute left-[-3px] right-[-3px] h-[2px] rounded"
                  style={{ background: "var(--color-app-accent, #22d3ee)", bottom: `${pct(cv!)}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.4)" }}
                />
              )}
            </div>
            <span className="text-[10px] font-mono tabular-nums" style={{ color: hasCursor ? "var(--color-app-accent, #22d3ee)" : empty ? "#6b7480" : color }}>
              {hasCursor ? Math.round(cv!) : empty ? "—" : Math.round(r.avg)}
            </span>
            <span className="text-[9px] text-app-text-dim uppercase">{c}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Tyre-temp hot/cold bands (°C). */
export function bandColor(t: number): string {
  if (t >= 110) return "#f87171";
  if (t >= 100) return "#fb923c";
  if (t < 70) return "#60a5fa";
  return "#34d399";
}

function rangeOf(frames: TelemetryPacket[], sel: (p: TelemetryPacket) => number | undefined, skipZero: boolean): Range {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let n = 0;
  for (const p of frames) {
    const v = sel(p);
    if (v == null || !Number.isFinite(v)) continue;
    if (skipZero && v <= 0) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  if (n === 0) return { min: 0, avg: 0, max: 0, n: 0 };
  return { min, avg: sum / n, max, n };
}
