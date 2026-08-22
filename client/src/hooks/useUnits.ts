import { useEffect, useMemo } from "react";
import { tryGetGame } from "../../../shared/games/registry";
import { convertDistance, convertSpeed, distanceLabel, speedLabel } from "../lib/speed";
import { convertTemp } from "../lib/temperature";
import { useGameId } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";
import { useSettings } from "./settings";

const DEFAULT_TIRE_TEMP = { cold: 75, warm: 115, hot: 150 };

/**
 * Centralised unit-conversion hook.
 *
 * Provides:
 * - Labels (speedLabel, tempLabel, distanceLabel)
 * - Converters for non-telemetry data (static car specs, thresholds)
 * - Syncs unit preferences to semantic telemetry rendering
 *
 * Telemetry resolver values use catalog units. Temperature semantics are °C,
 * independent of simulator source units.
 */
export function useUnits() {
  const { displaySettings } = useSettings();
  const setDisplayUnits = useTelemetryStore((s) => s.setDisplayUnits);
  const gameId = useGameId();

  const unit = displaySettings.unit;
  const su = unit === "metric" ? ("kmh" as const) : ("mph" as const);
  const tu = displaySettings.temperatureUnit;

  // Sync unit settings to telemetry store whenever they change
  useEffect(() => {
    setDisplayUnits(unit, tu);
  }, [unit, tu, setDisplayUnits]);

  return useMemo(() => {
    // Game-specific tire temp thresholds (°C) from adapter
    const adapter = gameId ? tryGetGame(gameId) : null;
    const thresholds = adapter?.tireTempThresholds ?? DEFAULT_TIRE_TEMP;
    /** Semantic temperature values are already canonical °C. */
    const toTempC = (temperatureC: number) => temperatureC;

    return {
      // ── Speed / distance (for non-telemetry data) ──────────────
      /** Convert m/s → user speed unit */
      speed: (ms: number) => convertSpeed(ms, su),
      /** Convert mph → user speed unit (for server data already in mph) */
      fromMph: (mph: number) => (su === "kmh" ? mph * 1.60934 : mph),
      /** Convert metres → user distance unit */
      distance: (m: number) => convertDistance(m, su),
      /** Display label for speed, e.g. "mph" or "km/h" */
      speedLabel: speedLabel(su),
      /** Display label for distance, e.g. "mi" or "km" */
      distanceLabel: distanceLabel(su),

      // ── Temperature ─────────────────────────────────────────────
      /** Convert canonical °C to user display unit. */
      temp: (temperatureC: number) => convertTemp(temperatureC, tu, "C"),
      /** Display label for temperature, e.g. "°F" or "°C" */
      tempLabel: `°${tu}`,
      /** Temperature unit raw value */
      tempUnit: tu,

      // ── Tire temperature thresholds (°C, game-specific) ─────────
      /** Game-specific tire temp thresholds in °C */
      thresholds,
      /** Preserve canonical °C for threshold comparisons. */
      toTempC,

      // ── Raw settings (escape hatch) ─────────────────────────────
      speedUnit: su,
      temperatureUnit: tu,
      unit,
      displaySettings,
    };
  }, [displaySettings, su, tu, unit, gameId]);
}
