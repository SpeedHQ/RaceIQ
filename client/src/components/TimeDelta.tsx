import { DELTA_COLOR_VARS } from "@/lib/colors";
import { TelemetryChart } from "./TelemetryChart";

interface Props {
  distances: number[];
  timeDelta: number[];
  syncKey?: string;
  height?: number;
  onCursorMove?: (distance: number | null) => void;
}

export function TimeDelta({ distances, timeDelta, syncKey, height = 160, onCursorMove }: Props) {
  // Split positive (losing) and negative (gaining) values for theme-owned fills.
  const gaining = timeDelta.map((d) => (d <= 0 ? d : 0));
  const losing = timeDelta.map((d) => (d > 0 ? d : 0));

  return (
    <TelemetryChart
      data={{
        distance: distances,
        values: [gaining, losing],
        labels: ["Gaining", "Losing"],
        colors: [...DELTA_COLOR_VARS],
      }}
      fillColors={DELTA_COLOR_VARS.map((color) => `color-mix(in srgb, ${color} 20%, transparent)`)}
      syncKey={syncKey}
      height={height}
      title="Time Delta"
      onCursorMove={onCursorMove}
    />
  );
}
