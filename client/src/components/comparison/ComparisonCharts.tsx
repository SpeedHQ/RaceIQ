import type { ComparisonData } from "@shared/racing/comparison/types";
import { useMemo } from "react";
import { TelemetryChart } from "@/components/TelemetryChart";
import { TimeDelta } from "@/components/TimeDelta";
import { COLOR_A, COLOR_B } from "@/lib/comparison-utils";
import { m } from "@/paraglide/messages";

const hasValues = (series: number[]) => series.some(Number.isFinite);

export function ComparisonCharts({
  comparison,
  units,
  onCursorMove,
  onRangeSelect,
  onResetZoom,
}: {
  comparison: ComparisonData;
  units: { fromMph: (value: number) => number; speedLabel: string };
  onCursorMove: (distance: number | null) => void;
  onRangeSelect?: (start: number, end: number) => void;
  onResetZoom?: () => void;
}) {
  const chartData = useMemo(() => {
    const { traces } = comparison;
    return {
      distance: traces.distance,
      speedA: traces.speedA.map(units.fromMph),
      speedB: traces.speedB.map(units.fromMph),
      throttleA: traces.throttleA,
      throttleB: traces.throttleB,
      brakeA: traces.brakeA,
      brakeB: traces.brakeB,
      rpmA: traces.rpmA,
      rpmB: traces.rpmB,
      tireWearA: traces.tireWearA ?? [],
      tireWearB: traces.tireWearB ?? [],
      timeDelta: comparison.timeDelta.map((delta) => -delta),
    };
  }, [comparison, units]);
  const { distance, speedA, speedB, throttleA, throttleB, brakeA, brakeB, rpmA, rpmB, tireWearA, tireWearB, timeDelta } = chartData;
  return (
    <div className="flex min-w-0 flex-none flex-col gap-4 overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-hidden">
      <div className="rounded-lg border border-app-border p-1 shrink-0">
        <TimeDelta distances={distance} timeDelta={timeDelta} syncKey="lap-compare" height={140} onCursorMove={onCursorMove} onRangeSelect={onRangeSelect} onResetZoom={onResetZoom} />
      </div>
      <div className="overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-y-auto">
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-app-border p-1">
            <TelemetryChart data={{ distance, values: [speedA, speedB], labels: [`${m.compare_speed_a()} (${units.speedLabel})`, `${m.compare_speed_b()} (${units.speedLabel})`], colors: [COLOR_A, COLOR_B] }} syncKey="lap-compare" height={200} title={m.label_speed()} onCursorMove={onCursorMove} onRangeSelect={onRangeSelect} onResetZoom={onResetZoom} />
          </div>
          <div className="rounded-lg border border-app-border p-1">
            <TelemetryChart data={{ distance, values: [throttleA, throttleB, brakeA, brakeB], labels: [m.compare_chart_throttle_a(), m.compare_chart_throttle_b(), m.compare_chart_brake_a(), m.compare_chart_brake_b()], colors: [COLOR_A, COLOR_B, "color-mix(in srgb, var(--comparison-lap-a) 67%, transparent)", "color-mix(in srgb, var(--comparison-lap-b) 67%, transparent)"] }} syncKey="lap-compare" height={180} onCursorMove={onCursorMove} onRangeSelect={onRangeSelect} onResetZoom={onResetZoom} />
          </div>
          <div className="rounded-lg border border-app-border p-1">
            <TelemetryChart data={{ distance, values: [rpmA, rpmB], labels: [m.compare_chart_rpm_a(), m.compare_chart_rpm_b()], colors: [COLOR_A, COLOR_B] }} syncKey="lap-compare" height={180} onCursorMove={onCursorMove} onRangeSelect={onRangeSelect} onResetZoom={onResetZoom} />
          </div>
          {hasValues(tireWearA) && hasValues(tireWearB) && (
            <div className="rounded-lg border border-app-border p-1">
              <TelemetryChart data={{ distance, values: [tireWearA, tireWearB], labels: [`${m.compare_chart_tire_wear_a()} (%)`, `${m.compare_chart_tire_wear_b()} (%)`], colors: [COLOR_A, COLOR_B] }} syncKey="lap-compare" height={160} onCursorMove={onCursorMove} onRangeSelect={onRangeSelect} onResetZoom={onResetZoom} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
