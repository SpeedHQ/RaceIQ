import { Droplet } from "lucide-react";
import { useUnits } from "../../hooks/useUnits";
import { m } from "../../paraglide/messages";

const WEATHER_ICONS: Record<number, string> = {
  0: "\u2600\uFE0F",
  1: "\u26C5",
  2: "\u2601\uFE0F",
  3: "\uD83C\uDF27\uFE0F",
  4: "\uD83C\uDF27\uFE0F",
  5: "\u26C8\uFE0F",
};

const weatherLabel = (weather: number | undefined) => weather == null
  ? m.f1live_weather_unknown()
  : [m.f1live_weather_clear(), m.f1live_weather_light_cloud(), m.f1live_weather_overcast(), m.f1live_weather_light_rain(), m.f1live_weather_heavy_rain(), m.f1live_weather_storm()][weather] ?? m.f1live_weather_unknown();

export function WeatherWidget({
  weather,
  rainPercentage,
  trackTemperature,
  airTemperature,
  position = "bottom-left",
}: {
  weather?: number;
  rainPercentage?: number;
  trackTemperature?: number;
  airTemperature?: number;
  position?: "bottom-left" | "bottom-right";
}) {
  const units = useUnits();
  const temperature = (value: number | undefined) => value == null ? "—" : `${units.temp(value).toFixed(0)}${units.tempLabel}`;
  return (
    <div
      className={`absolute bottom-2 ${position === "bottom-right" ? "right-2" : "left-2"} bg-app-surface-alt/80 backdrop-blur border border-app-border-input/50 rounded-lg px-2.5 py-1.5 text-app-caption space-y-0.5`}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-sm leading-none">{weather == null ? "\u2601\uFE0F" : WEATHER_ICONS[weather] ?? "\u2601\uFE0F"}</span>
        <span className="text-app-text font-medium">{weatherLabel(weather)}</span>
        {rainPercentage != null && (
          <span className="ml-auto inline-flex items-center gap-1 text-(--metric-rain)">
            <Droplet aria-hidden className="size-2.5" />
            {rainPercentage}%
          </span>
        )}
      </div>
      <div className="flex gap-3 text-app-text-muted">
        <span>{m.f1live_weather_track()} {temperature(trackTemperature)}</span>
        <span>{m.analyse_air()} {temperature(airTemperature)}</span>
      </div>
    </div>
  );
}
