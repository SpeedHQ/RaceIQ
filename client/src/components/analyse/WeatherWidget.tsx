import type { F1ExtendedData } from "../../../../shared/telemetry/f1-2025";
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

const weatherLabel = (weather: number) => [m.f1live_weather_clear(), m.f1live_weather_light_cloud(), m.f1live_weather_overcast(), m.f1live_weather_light_rain(), m.f1live_weather_heavy_rain(), m.f1live_weather_storm()][weather] ?? m.f1live_weather_unknown();

export function WeatherWidget({ f1, position = "bottom-left" }: { f1: F1ExtendedData; position?: "bottom-left" | "bottom-right" }) {
  const units = useUnits();
  const temperature = (value: number | undefined) => value == null ? "—" : `${units.temp(value).toFixed(0)}${units.tempLabel}`;
  const weather = f1.weather ?? 0;
  return (
    <div
      className={`absolute bottom-2 ${position === "bottom-right" ? "right-2" : "left-2"} bg-app-surface-alt/80 backdrop-blur border border-app-border-input/50 rounded-lg px-2.5 py-1.5 text-app-caption space-y-0.5`}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-sm leading-none">{WEATHER_ICONS[weather] ?? "\u2600\uFE0F"}</span>
        <span className="text-app-text font-medium">{weatherLabel(weather)}</span>
        {f1.rainPercentage > 0 && <span className="text-(--metric-rain)">{f1.rainPercentage}%</span>}
      </div>
      <div className="flex gap-3 text-app-text-muted">
        <span>{m.f1live_weather_track()} {temperature(f1.trackTemperature)}</span>
        <span>{m.analyse_air()} {temperature(f1.airTemperature)}</span>
      </div>
    </div>
  );
}
