import { useEffect, useMemo } from "react";
import type { GameId } from "../../../shared/games/ids";
import { tryGetGame } from "../../../shared/games/registry";
import { convertDistance, convertSpeed, distanceLabel, speedLabel } from "../lib/speed";
import { convertTemp } from "../lib/temperature";
import { useGameId } from "../stores/game";
import { telemetryStore } from "../stores/telemetry";
import { useSettings } from "./settings";

const DEFAULT_TIRE_TEMP = { cold: 75, warm: 115, hot: 150 };

/**
 * Centralised unit-conversion hook.
 *
 * Provides display labels and converters at presentation boundaries.
 * `temp` accepts canonical Celsius semantic values.
 */
export function useUnits(gameIdOverride?: GameId) {
  const { displaySettings } = useSettings();
  const setDisplayUnits = telemetryStore.actions.setDisplayUnits;
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;

  const unit = displaySettings.unit;
  const su = unit === "metric" ? ("kmh" as const) : ("mph" as const);
  const tu = displaySettings.temperatureUnit;

  useEffect(() => {
    setDisplayUnits(unit, tu);
  }, [unit, tu, setDisplayUnits]);

  return useMemo(() => {
    const adapter = gameId ? tryGetGame(gameId) : null;
    const thresholds = adapter?.tireTempThresholds ?? DEFAULT_TIRE_TEMP;

    return {
      speed: (ms: number) => convertSpeed(ms, su),
      fromMph: (mph: number) => (su === "kmh" ? mph * 1.60934 : mph),
      distance: (m: number) => convertDistance(m, su),
      speedLabel: speedLabel(su),
      distanceLabel: distanceLabel(su),
      temp: (celsius: number) => convertTemp(celsius, tu, "C"),
      tempLabel: `°${tu}`,
      tempUnit: tu,
      thresholds,
      speedUnit: su,
      temperatureUnit: tu,
      unit,
      displaySettings,
    };
  }, [displaySettings, su, tu, unit, gameId]);
}
