import type { F1ExtendedData } from "@shared/types";

const WEATHER_LABELS: Record<number, string> = {
  0: "Clear",
  1: "Light Cloud",
  2: "Overcast",
  3: "Light Rain",
  4: "Heavy Rain",
  5: "Storm",
};

export function F1WeatherWidget({ f1 }: { f1: F1ExtendedData }) {
  const label = WEATHER_LABELS[f1.weather] ?? "Unknown";

  return (
    <div className="rounded-lg bg-zinc-900 p-3">
      <div className="text-xs text-zinc-400 font-medium mb-2">Weather</div>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-zinc-200 font-medium">{label}</div>
          {f1.rainPercentage > 0 && <div className="text-[10px] text-blue-400">Rain: {f1.rainPercentage}%</div>}
        </div>
        <div className="text-right">
          <div className="text-xs text-zinc-400">
            Track: <span className="text-zinc-200">{f1.trackTemperature}&deg;C</span>
          </div>
          <div className="text-xs text-zinc-400">
            Air: <span className="text-zinc-200">{f1.airTemperature}&deg;C</span>
          </div>
        </div>
      </div>
    </div>
  );
}
