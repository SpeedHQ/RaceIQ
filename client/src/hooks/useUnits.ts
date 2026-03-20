import { useMemo } from "react";
import { useSettings } from "./queries";
import { convertSpeed, convertDistance, speedLabel, distanceLabel } from "../lib/speed";
import { convertTemp } from "../lib/temperature";

/**
 * Centralised unit-conversion hook.
 * All components should use this instead of manually importing conversion
 * functions + useSettings.  The returned helpers are pre-bound to the
 * user's current unit choices so callers never need to pass the unit arg.
 */
export function useUnits() {
  const { displaySettings } = useSettings();

  return useMemo(() => {
    const su = displaySettings.speedUnit;
    const tu = displaySettings.temperatureUnit;
    const thresholds = displaySettings.tireTemperatureThresholds;

    return {
      // ── Speed / distance ──────────────────────────────────────
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

      // ── Temperature ───────────────────────────────────────────
      /** Convert Fahrenheit → user temp unit */
      temp: (f: number) => convertTemp(f, tu),
      /** Display label for temperature, e.g. "°F" or "°C" */
      tempLabel: `°${tu}`,
      /** Temperature unit raw value */
      tempUnit: tu,

      // ── Tire temperature thresholds (always stored in °F) ─────
      thresholds,

      // ── Raw settings (escape hatch) ───────────────────────────
      speedUnit: su,
      temperatureUnit: tu,
      displaySettings,
    };
  }, [displaySettings]);
}
