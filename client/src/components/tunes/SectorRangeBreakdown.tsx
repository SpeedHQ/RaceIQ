import { tireTempColor } from "@/lib/vehicle-dynamics";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";

interface SectorTimes {
  times: number[];
  boundaryIndices: number[];
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
    accent: "var(--metric-tire-temperature)",
    semantic: true,
    sel: { FL: (p) => p.TireTempFL, FR: (p) => p.TireTempFR, RL: (p) => p.TireTempRL, RR: (p) => p.TireTempRR },
  },
  {
    key: "brakeTemp",
    label: "Brake temp",
    unit: "°C",
    accent: "var(--metric-brake-temperature)",
    sel: { FL: (p) => p.BrakeTempFrontLeft, FR: (p) => p.BrakeTempFrontRight, RL: (p) => p.BrakeTempRearLeft, RR: (p) => p.BrakeTempRearRight },
  },
  {
    key: "pressure",
    label: "Pressure",
    unit: "psi",
    accent: "var(--metric-pressure)",
    sel: { FL: (p) => p.TirePressureFrontLeft, FR: (p) => p.TirePressureFrontRight, RL: (p) => p.TirePressureRearLeft, RR: (p) => p.TirePressureRearRight },
  },
  {
    key: "wear",
    label: "Wear",
    unit: "%",
    accent: "var(--metric-wear)",
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
  /** Per-sector corner ranges in source-defined order. */
  sectors: Record<CornerKey, Range>[];
  /** Shared value domain across all sectors, for comparable bar scales. */
  domain: [number, number];
}

/** Compute per-sector corner ranges for a metric, on a shared domain. */
export function buildSectorRanges(telemetry: TelemetryPacket[], sectorTimes: SectorTimes | null, metric: MetricDef): SectorRangeModel | null {
  if (telemetry.length < 5) return null;

  const n = telemetry.length;
  const sectorCount = sectorTimes?.times.length && sectorTimes.times.length >= 2 ? sectorTimes.times.length : 3;
  const rawBoundaries =
    sectorTimes?.boundaryIndices.length === sectorCount - 1 ? sectorTimes.boundaryIndices : Array.from({ length: sectorCount - 1 }, (_, index) => Math.floor(((index + 1) * n) / sectorCount));
  const boundaries: number[] = [];
  for (let index = 0; index < rawBoundaries.length; index++) {
    const previous = boundaries[index - 1] ?? 0;
    const remaining = rawBoundaries.length - index;
    boundaries.push(Math.min(Math.max(rawBoundaries[index], previous + 1), n - remaining));
  }
  const sliceBounds = [0, ...boundaries, n];
  const slices = Array.from({ length: sectorCount }, (_, index) => telemetry.slice(sliceBounds[index], sliceBounds[index + 1]));
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
                  className="absolute left-[-3px] right-[-3px] h-[2px] rounded ring-1 ring-app-bg/40"
                  style={{
                    background: "var(--app-accent)",
                    bottom: `${pct(cv!)}%`,
                  }}
                />
              )}
            </div>
            <span className="text-app-caption font-mono tabular-nums" style={{ color: hasCursor ? "var(--app-accent)" : empty ? "var(--app-text-dim)" : color }}>
              {hasCursor ? Math.round(cv!) : empty ? "—" : Math.round(r.avg)}
            </span>
            <span className="text-app-micro text-app-text-dim uppercase">{c}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Tyre-temp hot/cold bands (°C). */
export function bandColor(t: number): string {
  return tireTempColor(t, { cold: 70, warm: 100, hot: 110 });
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

import type { SemanticTuneSample } from "./semantic-tune";
import { wheelValue } from "./semantic-tune";

export function buildSemanticSectorRanges(samples: SemanticTuneSample[], sectorTimes: SectorTimes | null, metric: MetricKey): SectorRangeModel | null {
  if (samples.length < 5) return null;
  const ids: Record<MetricKey, keyof SemanticTuneSample["values"]> = { tyreTemp: "tire.temperature.average", brakeTemp: "brakes.brake-temp", pressure: "tires.tire-pressure", wear: "tires.tire-wear" };
  const n = samples.length;
  const count = sectorTimes?.times.length && sectorTimes.times.length >= 2 ? sectorTimes.times.length : 3;
  const bounds = sectorTimes?.boundaryIndices.length === count - 1 ? sectorTimes.boundaryIndices : Array.from({ length: count - 1 }, (_, i) => Math.floor(((i + 1) * n) / count));
  const slices = [0, ...bounds, n].map((start, i, a) => samples.slice(start, a[i + 1] ?? n)).slice(0, count);
  const skipZero = metric !== "wear";
  const ranges = (xs: SemanticTuneSample[]) => Object.fromEntries(CORNERS.map((c, i) => {
    const vs = xs.map((s) => wheelValue(s, ids[metric], i)).filter((v): v is number => v != null && (!skipZero || v > 0));
    return [c, vs.length ? { min: Math.min(...vs), avg: vs.reduce((a, b) => a + b, 0) / vs.length, max: Math.max(...vs), n: vs.length } : { min: 0, avg: 0, max: 0, n: 0 }];
  })) as Record<CornerKey, Range>;
  const sectors = slices.map(ranges); const vals = sectors.flatMap((s) => CORNERS.flatMap((c) => s[c].n ? [s[c].min, s[c].max] : []));
  if (!vals.length) return { sectors, domain: [0, 1] };
  const min = Math.min(...vals), max = Math.max(...vals), pad = Math.max(metric === "wear" ? 1 : 4, (max - min) * .15);
  return { sectors, domain: [Math.floor(min - pad), Math.ceil(max + pad)] };
}