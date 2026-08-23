import type { ComparisonData, SemanticTelemetrySample } from "@shared/racing/comparison/types";
import { TelemetryChart } from "@/components/TelemetryChart";
import { TimeDelta } from "@/components/TimeDelta";
import { COLOR_A, COLOR_B } from "@/lib/comparison-utils";
import { m } from "@/paraglide/messages";

const numericSeries = (samples: SemanticTelemetrySample[], id: keyof SemanticTelemetrySample["values"]) => samples.map((sample) => (typeof sample.values[id] === "number" ? sample.values[id] as number : Number.NaN))
const interpolateSeries = (samples: SemanticTelemetrySample[], id: keyof SemanticTelemetrySample["values"], grid: number[]) => {
  const points = samples.map((sample) => ({ x: sample.values["timing.distance-traveled"], y: sample.values[id] }))
    .filter((point): point is { x: number; y: number } => typeof point.x === "number" && typeof point.y === "number");
  return grid.map((x) => {
    if (points.length === 0) return Number.NaN;
    let right = points.findIndex((point) => point.x >= x);
    if (right < 0) right = points.length - 1;
    if (right === 0) return points[0].y;
    const left = points[right - 1];
    const next = points[right];
    const span = next.x - left.x;
    return span > 0 ? left.y + ((next.y - left.y) * (x - left.x)) / span : next.y;
  });
}
const hasValues = (series: number[]) => series.some(Number.isFinite);

export function ComparisonCharts({
  comparison,
  units,
  onCursorMove,
}: {
  comparison: ComparisonData;
  units: { fromMph: (value: number) => number; speedLabel: string };
  onCursorMove: (distance: number | null) => void;
}) {
  const distance = numericSeries(comparison.telemetryA, "timing.distance-traveled").filter(Number.isFinite);
  const speedA = interpolateSeries(comparison.telemetryA, "motion.speed", distance);
  const speedB = interpolateSeries(comparison.telemetryB, "motion.speed", distance);
  const throttleA = interpolateSeries(comparison.telemetryA, "inputs.throttle", distance);
  const throttleB = interpolateSeries(comparison.telemetryB, "inputs.throttle", distance);
  const brakeA = interpolateSeries(comparison.telemetryA, "inputs.brake", distance);
  const brakeB = interpolateSeries(comparison.telemetryB, "inputs.brake", distance);
  const rpmA = interpolateSeries(comparison.telemetryA, "engine.current-engine-rpm", distance);
  const rpmB = interpolateSeries(comparison.telemetryB, "engine.current-engine-rpm", distance);
  const tireWearA = interpolateSeries(comparison.telemetryA, "tires.tire-wear", distance);
  const tireWearB = interpolateSeries(comparison.telemetryB, "tires.tire-wear", distance);
  const lapA = interpolateSeries(comparison.telemetryA, "timing.current-lap", distance);
  const lapB = interpolateSeries(comparison.telemetryB, "timing.current-lap", distance);
  const semanticTimeDelta = lapA.map((value, index) => Number.isFinite(value) && Number.isFinite(lapB[index]) ? lapB[index] - value : Number.NaN);
  return (
    <div className="flex min-w-0 flex-none flex-col gap-4 overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-hidden">
      <div className="rounded-lg border border-app-border p-1 shrink-0">
        <TimeDelta distances={distance} timeDelta={semanticTimeDelta} syncKey="lap-compare" height={140} onCursorMove={onCursorMove} />
      </div>
      <div className="overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-y-auto">
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-app-border p-1">
            <TelemetryChart
              data={{
                distance,
                values: [speedA.map((value) => units.fromMph(value * 2.2369362920544)), speedB.map((value) => units.fromMph(value * 2.2369362920544))],
                labels: [`${m.compare_speed_a()} (${units.speedLabel})`, `${m.compare_speed_b()} (${units.speedLabel})`],
                colors: [COLOR_A, COLOR_B],
              }}
              syncKey="lap-compare"
              height={200}
              title={m.label_speed()}
              onCursorMove={onCursorMove}
            />
          </div>
          <div className="rounded-lg border border-app-border p-1">
            <TelemetryChart
              data={{
                distance,
                values: [throttleA, throttleB, brakeA, brakeB],
                labels: [m.compare_chart_throttle_a(), m.compare_chart_throttle_b(), m.compare_chart_brake_a(), m.compare_chart_brake_b()],
                colors: [COLOR_A, COLOR_B, "color-mix(in srgb, var(--comparison-lap-a) 67%, transparent)", "color-mix(in srgb, var(--comparison-lap-b) 67%, transparent)"],
              }}
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
                values: [rpmA, rpmB],
                labels: [m.compare_chart_rpm_a(), m.compare_chart_rpm_b()],
                colors: [COLOR_A, COLOR_B],
              }}
              syncKey="lap-compare"
              height={180}
              title={m.compare_rpm()}
              onCursorMove={onCursorMove}
            />
          </div>
          {hasValues(tireWearA) && hasValues(tireWearB) && (
            <div className="rounded-lg border border-app-border p-1">
              <TelemetryChart
                data={{
                  distance,
                  values: [tireWearA, tireWearB],
                  labels: [`${m.compare_chart_tire_wear_a()} (%)`, `${m.compare_chart_tire_wear_b()} (%)`],
                  colors: [COLOR_A, COLOR_B],
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
