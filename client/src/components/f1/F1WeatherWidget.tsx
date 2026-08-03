import { m } from "@/paraglide/messages";
import type { F1ExtendedData } from "../../../../shared/telemetry/f1-2025";

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
    <div className="rounded-lg bg-app-surface p-3">
      <div className="text-xs text-app-text-muted font-medium mb-2">{m.f1weather_label()}</div>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-app-text font-medium">{label}</div>
          {f1.rainPercentage > 0 && (
            <div className="text-app-caption text-(--metric-rain)">
              {m.f1weather_rain_label()} {f1.rainPercentage}%
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-xs text-app-text-muted">
            {m.f1weather_track_label()} <span className="text-(--metric-track-temperature)">{f1.trackTemperature}&deg;C</span>
          </div>
          <div className="text-xs text-app-text-muted">
            {m.f1weather_air_label()} <span className="text-(--metric-air-temperature)">{f1.airTemperature}&deg;C</span>
          </div>
        </div>
      </div>
    </div>
  );
}
