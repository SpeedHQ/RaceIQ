import { useEffect, useMemo } from "react";
import { tryGetGame } from "../../../shared/games/registry";
import { getTireTemperatureSourceUnit } from "../../../shared/games/telemetry";
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
 * - Syncs unit preferences to the telemetry store so live packets
 *   are auto-converted on arrival
 *
 * For telemetry data: use DisplayPacket fields (DisplaySpeed, DisplayTireTemp*)
 * instead of calling these converters manually.
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
    const sourceTempUnit = adapter ? getTireTemperatureSourceUnit(adapter.telemetry.tireTemperature) : "C";
    /** Convert raw packet temp to °C for threshold comparisons */
    const toTempC = (rawTemp: number) => convertTemp(rawTemp, "C", sourceTempUnit);

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
      /** Convert raw packet temp → user display unit. */
      temp: (rawTemp: number) => convertTemp(rawTemp, tu, sourceTempUnit),
      /** Convert canonical semantic telemetry °C to user display unit. */
      tempFromC: (celsius: number) => convertTemp(celsius, tu, "C"),
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
