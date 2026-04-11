import type { F1ExtendedData } from "@shared/types";

const WEATHER_ICONS: Record<number, string> = {
  0: "\u2600\uFE0F",
  1: "\u26C5",
  2: "\u2601\uFE0F",
  3: "\uD83C\uDF27\uFE0F",
  4: "\uD83C\uDF27\uFE0F",
  5: "\u26C8\uFE0F",
};

const WEATHER_LABELS: Record<number, string> = {
  0: "Clear", 1: "Light Cloud", 2: "Overcast",
  3: "Light Rain", 4: "Heavy Rain", 5: "Storm",
};

export function WeatherWidget({ f1 }: { f1: F1ExtendedData }) {
  const weather = f1.weather ?? 0;
  return (
    <div className="absolute bottom-2 left-2 bg-app-surface-alt/80 backdrop-blur border border-app-border-input/50 rounded-lg px-2.5 py-1.5 text-[10px] space-y-0.5">
      <div className="flex items-center gap-1.5">
        <span className="text-sm leading-none">{WEATHER_ICONS[weather] ?? "\u2600\uFE0F"}</span>
        <span className="text-app-text font-medium">{WEATHER_LABELS[weather] ?? "Unknown"}</span>
        {f1.rainPercentage > 0 && (
          <span className="text-blue-400">{f1.rainPercentage}%</span>
        )}
      </div>
      <div className="flex gap-3 text-app-text-muted">
        <span>Track {f1.trackTemperature}°C</span>
        <span>Air {f1.airTemperature}°C</span>
      </div>
    </div>
  );
}
