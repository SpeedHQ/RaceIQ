import { useMemo, useState } from "react";
import { useUnits } from "@/hooks/useUnits";
import type { AlignedLapTrace } from "@raceiq/analysis-core/racing/laps/alignment/types";
import { m } from "@/paraglide/messages";
import { Lane } from "@/components/tunes/track-focus/Lane";

const channels = [
  { key: "speed", color: "var(--app-accent)", domain: [0, 300] as [number, number] },
  { key: "brake", color: "var(--ch-brake)", domain: [0, 100] as [number, number] },
  { key: "throttle", color: "var(--ch-throttle)", domain: [0, 100] as [number, number] },
  { key: "steering", color: "var(--app-text)", domain: [-1, 1] as [number, number] },
] as const;

export function CoachingEvidenceChart({ trace, markerFraction }: { trace: AlignedLapTrace; markerFraction: number }) {
  const units = useUnits();
  const [cursorFrac, setCursorFrac] = useState<number | null>(null);
  const fraction = trace.frac;
  const start = fraction[0] ?? 0;
  const end = fraction[fraction.length - 1] ?? 1;
  const span = end - start || 1;
  let markerIndex = -1;
  for (let index = 0; index < fraction.length; index++) {
    if (fraction[index]! >= markerFraction) { markerIndex = index; break; }
  }
  if (markerIndex < 0) markerIndex = fraction.length - 1;
  const speedValues = useMemo(() => Float32Array.from(trace.speedMps, units.speed), [trace.speedMps, units.speed]);
  const brakeValues = useMemo(() => Float32Array.from(trace.brake, (value) => value * 100), [trace.brake]);
  const throttleValues = useMemo(() => Float32Array.from(trace.throttle, (value) => value * 100), [trace.throttle]);
  const series = {
    speed: { values: speedValues, label: m.chart_speed({ unit: units.speedLabel }) },
    brake: { values: brakeValues, label: m.analyse_chart_brake() },
    throttle: { values: throttleValues, label: m.analyse_chart_throttle() },
    steering: { values: trace.steer, label: m.analyse_chart_steering() },
  };
  return <div data-testid="coaching-evidence-chart" className="grid gap-2 p-2">
    {channels.map(({ key, color, domain }) => {
      const { values, label } = series[key];
      const value = markerIndex >= 0 ? values[markerIndex] : undefined;
      const formatted = value == null || !Number.isFinite(value)
        ? "—"
        : key === "speed" ? `${value.toFixed(2)} ${units.speedLabel}`
          : key === "brake" || key === "throttle" ? `${value.toFixed(2)}%`
            : value.toFixed(2);
      const title = `${label}: ${formatted}`;
      return <div key={key} data-channel={key} className="min-w-0">
        <Lane
          height={48}
          title={title}
          series={[{ x: fraction, values, color }]}
          domain={domain}
          cursorFrac={cursorFrac}
          onCursorFrac={setCursorFrac}
          visibleRange={{ start, end }}
          annotationMarkers={[{ frac: markerFraction, color: "var(--status-danger)" }]}
        />
      </div>;
    })}
    <span className="sr-only" data-event-marker="true">{Math.max(0, Math.min(100, ((markerFraction - start) / span) * 100)).toFixed(2)}%</span>
  </div>;
}
