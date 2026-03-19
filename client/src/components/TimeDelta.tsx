import { TelemetryChart } from "./TelemetryChart";

interface Props {
  distances: number[];
  timeDelta: number[];
  syncKey?: string;
  height?: number;
  onCursorMove?: (distance: number | null) => void;
}

export function TimeDelta({ distances, timeDelta, syncKey, height = 160, onCursorMove }: Props) {
  // Split into positive (losing time = red) and negative (gaining time = green) for fill
  const gaining = timeDelta.map((d) => (d <= 0 ? d : 0));
  const losing = timeDelta.map((d) => (d > 0 ? d : 0));

  return (
    <TelemetryChart
      data={{
        distance: distances,
        values: [gaining, losing],
        labels: ["Gaining", "Losing"],
        colors: ["#22c55e", "#ef4444"],
      }}
      fillColors={["rgba(34, 197, 94, 0.2)", "rgba(239, 68, 68, 0.2)"]}
      syncKey={syncKey}
      height={height}
      title="Time Delta"
      onCursorMove={onCursorMove}
    />
  );
}
