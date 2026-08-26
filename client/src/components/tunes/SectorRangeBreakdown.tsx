import { tireTempColor } from "@/lib/vehicle-dynamics";
import { type SemanticTuneSample, type TuneWheelMetric, wheelValue } from "./semantic-tune";

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
  field: TuneWheelMetric;
}

export const METRICS: MetricDef[] = [
  {
    key: "tyreTemp",
    label: "Tyre temp",
    unit: "°C",
    accent: "var(--metric-tire-temperature)",
    semantic: true,
    field: "tireTemperatureC",
  },
  {
    key: "brakeTemp",
    label: "Brake temp",
    unit: "°C",
    accent: "var(--metric-brake-temperature)",
    field: "brakeTemperatureC",
  },
  {
    key: "pressure",
    label: "Pressure",
    unit: "psi",
    accent: "var(--metric-pressure)",
    field: "tirePressurePsi",
  },
  {
    key: "wear",
    label: "Wear",
    unit: "%",
    accent: "var(--metric-wear)",
    field: "tireWearFraction",
  },
];
export function tuneMetricValue(sample: SemanticTuneSample, metric: MetricDef, index: number): number | undefined {
  const value = wheelValue(sample, metric.field, index);
  return value === undefined || metric.key !== "wear" ? value : value * 100;
}

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
export function buildSectorRanges(telemetry: SemanticTuneSample[], sectorTimes: SectorTimes | null, metric: MetricDef): SectorRangeModel | null {
  if (telemetry.length < 5) return null;

  const sampleCount = telemetry.length;
  const sectorCount = sectorTimes?.times.length && sectorTimes.times.length >= 2 ? sectorTimes.times.length : 3;
  const rawBoundaries =
    sectorTimes?.boundaryIndices.length === sectorCount - 1
      ? sectorTimes.boundaryIndices
      : Array.from({ length: sectorCount - 1 }, (_, index) => Math.floor(((index + 1) * sampleCount) / sectorCount));
  const boundaries: number[] = [];
  for (let index = 0; index < rawBoundaries.length; index++) {
    const previous = boundaries[index - 1] ?? 0;
    const remaining = rawBoundaries.length - index;
    boundaries.push(Math.min(Math.max(rawBoundaries[index], previous + 1), sampleCount - remaining));
  }
  const sliceBounds = [0, ...boundaries, sampleCount];
  const slices = Array.from({ length: sectorCount }, (_, index) => telemetry.slice(sliceBounds[index], sliceBounds[index + 1]));
  const skipZero = metric.key !== "wear";
  const sectors = slices.map((frames) => Object.fromEntries(CORNERS.map((corner, index) => [corner, rangeOf(frames, metric, index, skipZero)])) as Record<CornerKey, Range>);

  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const sector of sectors) {
    for (const corner of CORNERS) {
      const range = sector[corner];
      if (range.n === 0) continue;
      minimum = Math.min(minimum, range.min);
      maximum = Math.max(maximum, range.max);
    }
  }
  if (!Number.isFinite(minimum)) return { sectors, domain: [0, 1] };
  const padding = Math.max(metric.key === "wear" ? 1 : 4, (maximum - minimum) * 0.15);
  return { sectors, domain: [Math.floor(minimum - padding), Math.ceil(maximum + padding)] };
}

/** Compute per-corner ranges for a metric over a whole telemetry slice (no
 *  sector split), on a shared padded domain — used by the live test dashboard
 *  where the current lap is still in progress. */
export function buildLiveRanges(telemetry: SemanticTuneSample[], metric: MetricDef): { ranges: Record<CornerKey, Range>; domain: [number, number] } | null {
  if (telemetry.length < 5) return null;
  const skipZero = metric.key !== "wear";
  const ranges = Object.fromEntries(CORNERS.map((corner, index) => [corner, rangeOf(telemetry, metric, index, skipZero)])) as Record<CornerKey, Range>;
  const populated = CORNERS.flatMap((corner) => (ranges[corner].n === 0 ? [] : [ranges[corner].min, ranges[corner].max]));
  if (populated.length === 0) return { ranges, domain: [0, 1] };
  const minimum = Math.min(...populated);
  const maximum = Math.max(...populated);
  const padding = Math.max(metric.key === "wear" ? 1 : 4, (maximum - minimum) * 0.15);
  return { ranges, domain: [Math.floor(minimum - padding), Math.ceil(maximum + padding)] };
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

function rangeOf(frames: SemanticTuneSample[], metric: MetricDef, index: number, skipZero: boolean): Range {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let count = 0;
  for (const frame of frames) {
    const value = tuneMetricValue(frame, metric, index);
    if (value === undefined || (skipZero && value <= 0)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    count++;
  }
  return count === 0 ? { min: 0, avg: 0, max: 0, n: 0 } : { min, avg: sum / count, max, n: count };
}
