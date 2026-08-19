import type { ComparisonData } from "@shared/racing/comparison/types";
import { TelemetryChart } from "@/components/TelemetryChart";
import { TimeDelta } from "@/components/TimeDelta";
import { COLOR_A, COLOR_B } from "@/lib/comparison-utils";
import { m } from "@/paraglide/messages";

const hasValues = (series: number[]) => series.some(Number.isFinite);

export function buildComparisonChartData(
  comparison: ComparisonData,
  units: { fromMph: (value: number) => number; speedLabel: string },
) {
  return {
    distance: comparison.traces.distance,
    speedA: comparison.traces.speedA.map(units.fromMph),
    speedB: comparison.traces.speedB.map(units.fromMph),
    throttleA: comparison.traces.throttleA,
    throttleB: comparison.traces.throttleB,
    brakeA: comparison.traces.brakeA,
    brakeB: comparison.traces.brakeB,
    rpmA: comparison.traces.rpmA,
    rpmB: comparison.traces.rpmB,
    tireWearA: comparison.traces.tireWearA ?? [],
    tireWearB: comparison.traces.tireWearB ?? [],
    timeDelta: comparison.timeDelta,
  };
}

export function ComparisonCharts({
  comparison,
  units,
  onCursorMove,
}: {
  comparison: ComparisonData;
  units: { fromMph: (value: number) => number; speedLabel: string };
  onCursorMove: (distance: number | null) => void;
}) {
  const {
    distance,
    speedA,
    speedB,
    throttleA,
    throttleB,
    brakeA,
    brakeB,
    rpmA,
    rpmB,
    tireWearA,
    tireWearB,
    timeDelta,
  } = buildComparisonChartData(comparison, units);
  return (
    <div className="flex min-w-0 flex-none flex-col gap-4 overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-hidden">
      <div className="rounded-lg border border-app-border p-1 shrink-0">
        <TimeDelta distances={distance} timeDelta={timeDelta} syncKey="lap-compare" height={140} onCursorMove={onCursorMove} />
      </div>
      <div className="overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-y-auto">
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-app-border p-1">
            <TelemetryChart
              data={{
                distance,
                values: [speedA, speedB],
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
