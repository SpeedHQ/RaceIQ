import { createContext, useContext, useState, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";

export interface TempSettings {
  temperatureUnit: "F" | "C";
  tireTemperatureThresholds: {
    cold: number;
    warm: number;
    hot: number;
  };
}

const DEFAULT_TEMP_SETTINGS: TempSettings = {
  temperatureUnit: "F",
  tireTemperatureThresholds: { cold: 150, warm: 220, hot: 280 },
};

interface TelemetryContextValue {
  connected: boolean;
  packet: TelemetryPacket | null;
  packetsPerSec: number;
  tempSettings: TempSettings;
  refetchSettings: () => Promise<void>;
}

export const TelemetryContext = createContext<TelemetryContextValue>({
  connected: false,
  packet: null,
  packetsPerSec: 0,
  tempSettings: DEFAULT_TEMP_SETTINGS,
  refetchSettings: async () => {},
});

export function useTelemetry() {
  return useContext(TelemetryContext);
}

export function useTempSettings() {
  const [tempSettings, setTempSettings] = useState<TempSettings>(DEFAULT_TEMP_SETTINGS);

  const refetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      setTempSettings({
        temperatureUnit: data.temperatureUnit ?? "F",
        tireTemperatureThresholds: data.tireTemperatureThresholds ?? DEFAULT_TEMP_SETTINGS.tireTemperatureThresholds,
      });
    } catch {
      // Keep defaults on error
    }
  }, []);

  return { tempSettings, refetchSettings };
}
