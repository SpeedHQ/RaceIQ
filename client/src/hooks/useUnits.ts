import { useMemo, useEffect } from "react";
import { useSettings } from "./queries";
import { convertSpeed, convertDistance, speedLabel, distanceLabel } from "../lib/speed";
import { convertTemp } from "../lib/temperature";
import { useTelemetryStore } from "../stores/telemetry";

/**
 * Centralised unit-conversion hook.
 *
 * Provides:
 * - Labels (speedLabel, tempLabel, distanceLabel)
 * - Converters for non-telemetry data (static car specs, thresholds)
 * - Syncs unit preferences to the telemetry store so live packets
 *   are auto-converted on arrival
 *
 * For telemetry data: use DisplayPacket fields (DisplaySpeed, DisplayTireTemp*)
 * instead of calling these converters manually.
 */
export function useUnits() {
  const { displaySettings } = useSettings();
  const setUnitSystem = useTelemetryStore((s) => s.setUnitSystem);

  const unit = displaySettings.unit;
  const su = unit === "metric" ? "kmh" as const : "mph" as const;
  const tu = unit === "metric" ? "C" as const : "F" as const;

  // Sync unit settings to telemetry store whenever they change
  useEffect(() => {
    setUnitSystem(unit);
  }, [unit, setUnitSystem]);

  return useMemo(() => {
    const thresholds = displaySettings.tireTempCelsiusThresholds;

    return {
      // ── Speed / distance (for non-telemetry data) ──────────────
      /** Convert m/s → user speed unit */
      speed: (ms: number) => convertSpeed(ms, su),
      /** Convert mph → user speed unit (for server data already in mph) */
      fromMph: (mph: number) => su === "kmh" ? mph * 1.60934 : mph,
      /** Convert metres → user distance unit */
      distance: (m: number) => convertDistance(m, su),
      /** Display label for speed, e.g. "mph" or "km/h" */
      speedLabel: speedLabel(su),
      /** Display label for distance, e.g. "mi" or "km" */
      distanceLabel: distanceLabel(su),

      // ── Temperature (for non-telemetry data) ────────────────────
      /** Convert Fahrenheit → user temp unit */
      temp: (f: number) => convertTemp(f, tu),
      /** Display label for temperature, e.g. "°F" or "°C" */
      tempLabel: `°${tu}`,
      /** Temperature unit raw value */
      tempUnit: tu,

      // ── Tire temperature thresholds (always stored in °F) ───────
      thresholds,

      // ── Raw settings (escape hatch) ─────────────────────────────
      speedUnit: su,
      temperatureUnit: tu,
      unit,
      displaySettings,
    };
  }, [displaySettings, su, tu, unit]);
}
