import { useMemo, useEffect } from "react";
import { useSettings } from "./queries";
import { convertSpeed, convertDistance, speedLabel, distanceLabel } from "../lib/speed";
import { convertTemp, fahrenheitToCelsius } from "../lib/temperature";
import { useTelemetryStore } from "../stores/telemetry";
import { useGameId } from "../stores/game";
import { tryGetGame } from "../../../shared/games/registry";

const DEFAULT_TIRE_TEMP = { cold: 75, warm: 115, hot: 150 };

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
  const gameId = useGameId();

  const unit = displaySettings.unit;
  const su = unit === "metric" ? "kmh" as const : "mph" as const;
  const tu = unit === "metric" ? "C" as const : "F" as const;

  // Sync unit settings to telemetry store whenever they change
  useEffect(() => {
    setUnitSystem(unit);
  }, [unit, setUnitSystem]);

  return useMemo(() => {
    // Game-specific tire temp thresholds (°C) from adapter
    const adapter = gameId ? tryGetGame(gameId) : null;
    const thresholds = adapter?.tireTempThresholds ?? DEFAULT_TIRE_TEMP;
    // Forza sends °F, F1/ACC send °C — convert raw packet temp to °C for threshold comparison
    const isForza = gameId === "fm-2023";
    /** Convert raw packet temp to °C for threshold comparisons */
    const toTempC = (rawTemp: number) => isForza ? fahrenheitToCelsius(rawTemp) : rawTemp;

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

      // ── Temperature ─────────────────────────────────────────────
      /** Convert raw packet temp → user display unit (handles Forza °F) */
      temp: (rawTemp: number) => convertTemp(rawTemp, tu, isForza ? "F" : "C"),
      /** Display label for temperature, e.g. "°F" or "°C" */
      tempLabel: `°${tu}`,
      /** Temperature unit raw value */
      tempUnit: tu,

      // ── Tire temperature thresholds (°C, game-specific) ─────────
      /** Game-specific tire temp thresholds in °C */
      thresholds,
      /** Convert raw packet temp to °C for threshold comparisons */
      toTempC,

      // ── Raw settings (escape hatch) ─────────────────────────────
      speedUnit: su,
      temperatureUnit: tu,
      unit,
      displaySettings,
    };
  }, [displaySettings, su, tu, unit, gameId]);
}
