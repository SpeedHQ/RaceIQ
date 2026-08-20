import type { ComparisonData } from "@shared/racing/comparison/types";
import { TelemetryChart } from "@/components/TelemetryChart";

import { m } from "@/paraglide/messages";

export interface ComparisonChartPair {
  comparison: ComparisonData;
  label: string;
  color: string;
}

interface ChartSeries {
  label: string;
  color: string;
  speed: number[];
  throttle: number[];
  brake: number[];
  rpm: number[];
  tireWear: number[];
  timeDelta?: number[];
}

const hasValues = (series: number[]) => series.some(Number.isFinite);

export function resampleComparisonValues(sourceDistances: number[], values: number[], targetDistances: number[]): number[] {
  if (sourceDistances.length === 0 || values.length === 0) return targetDistances.map(() => Number.NaN);
  if (sourceDistances.length === targetDistances.length && sourceDistances.every((distance, index) => distance === targetDistances[index])) return values.slice();

  const lastSourceIndex = Math.min(sourceDistances.length, values.length) - 1;
  let upper = 0;
  return targetDistances.map((target) => {
    while (upper < lastSourceIndex && sourceDistances[upper] < target) upper++;
    if (upper === 0) return values[0];
    if (upper >= lastSourceIndex && target >= sourceDistances[lastSourceIndex]) return values[lastSourceIndex];
    const lower = upper - 1;
    const startDistance = sourceDistances[lower];
    const endDistance = sourceDistances[upper];
    const startValue = values[lower];
    const endValue = values[upper];
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return Number.isFinite(startValue) ? startValue : endValue;
    const fraction = endDistance === startDistance ? 0 : (target - startDistance) / (endDistance - startDistance);
    return startValue + (endValue - startValue) * fraction;
  });
}

export function buildComparisonChartData(
  reference: { label: string; color: string },
  comparisons: ComparisonChartPair[],
  units: { fromMph: (value: number) => number; speedLabel: string },
): { distance: number[]; series: ChartSeries[] } {
  const primary = comparisons[0]?.comparison;
  if (!primary) return { distance: [], series: [] };
  const distance = primary.traces.distance;
  const referenceSeries: ChartSeries = {
    label: reference.label,
    color: reference.color,
    speed: primary.traces.speedA.map(units.fromMph),
    throttle: primary.traces.throttleA,
    brake: primary.traces.brakeA,
    rpm: primary.traces.rpmA,
    tireWear: primary.traces.tireWearA ?? [],
  };
  const comparedSeries = comparisons.map(({ comparison, label, color }): ChartSeries => {
    const sourceDistance = comparison.traces.distance;
    return {
      label,
      color,
      speed: resampleComparisonValues(sourceDistance, comparison.traces.speedB, distance).map(units.fromMph),
      throttle: resampleComparisonValues(sourceDistance, comparison.traces.throttleB, distance),
      brake: resampleComparisonValues(sourceDistance, comparison.traces.brakeB, distance),
      rpm: resampleComparisonValues(sourceDistance, comparison.traces.rpmB, distance),
      tireWear: resampleComparisonValues(sourceDistance, comparison.traces.tireWearB ?? [], distance),
      timeDelta: resampleComparisonValues(sourceDistance, comparison.timeDelta, distance),
    };
  });
  return { distance, series: [referenceSeries, ...comparedSeries] };
}

export function ComparisonCharts({
  reference,
  comparisons,
  units,
  onCursorMove,
}: {
  reference: { label: string; color: string };
  comparisons: ComparisonChartPair[];
  units: { fromMph: (value: number) => number; speedLabel: string };
  onCursorMove: (distance: number | null) => void;
}) {
  const { distance, series } = buildComparisonChartData(reference, comparisons, units);
  const comparisonSeries = series.slice(1);
  const inputSeries = series.flatMap((entry) => [entry.throttle, entry.brake]);
  const inputLabels = series.flatMap((entry) => [`${entry.label} — ${m.compare_chart_throttle()}`, `${entry.label} — ${m.compare_chart_brake()}`]);
  const inputColors = series.flatMap((entry) => [entry.color, `color-mix(in srgb, ${entry.color} 55%, transparent)`]);
  const tireSeries = series.filter((entry) => hasValues(entry.tireWear));
  return (
    <div className="flex min-w-0 flex-none flex-col gap-4 overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-hidden">
      <div className="rounded-lg border border-app-border p-1 shrink-0">
        <TelemetryChart
          data={{
            distance,
            values: comparisonSeries.map((entry) => entry.timeDelta ?? []),
            labels: comparisonSeries.map((entry) => `${entry.label} Δ`),
            colors: comparisonSeries.map((entry) => entry.color),
          }}
          syncKey="lap-compare"
          height={140}
          title={m.compare_time_delta()}
          onCursorMove={onCursorMove}
        />
      </div>
      <div className="overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-y-auto">
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-app-border p-1">
            <TelemetryChart
              data={{
                distance,
                values: series.map((entry) => entry.speed),
                labels: series.map((entry) => `${entry.label} (${units.speedLabel})`),
                colors: series.map((entry) => entry.color),
              }}
              syncKey="lap-compare"
              height={200}
              title={m.label_speed()}
              onCursorMove={onCursorMove}
            />
          </div>
          <div className="rounded-lg border border-app-border p-1">
            <TelemetryChart
              data={{ distance, values: inputSeries, labels: inputLabels, colors: inputColors }}
              syncKey="lap-compare"
              height={180}
              title={m.compare_throttle_brake()}
              onCursorMove={onCursorMove}
            />
          </div>
          <div className="rounded-lg border border-app-border p-1">
            <TelemetryChart
              data={{
                distance,
                values: series.map((entry) => entry.rpm),
                labels: series.map((entry) => `${entry.label} — ${m.compare_rpm()}`),
                colors: series.map((entry) => entry.color),
              }}
              syncKey="lap-compare"
              height={180}
              title={m.compare_rpm()}
              onCursorMove={onCursorMove}
            />
          </div>
          {tireSeries.length > 0 && (
            <div className="rounded-lg border border-app-border p-1">
              <TelemetryChart
                data={{
                  distance,
                  values: tireSeries.map((entry) => entry.tireWear),
                  labels: tireSeries.map((entry) => `${entry.label} (%)`),
                  colors: tireSeries.map((entry) => entry.color),
                }}
                syncKey="lap-compare"
                height={160}
                title={m.compare_tire_wear()}
                onCursorMove={onCursorMove}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
