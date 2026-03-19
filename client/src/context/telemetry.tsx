import { createContext, useContext, useState, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";

export interface DisplaySettings {
  temperatureUnit: "F" | "C";
  speedUnit: "mph" | "kmh";
  tireTemperatureThresholds: { cold: number; warm: number; hot: number };
}

const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  temperatureUnit: "F",
  speedUnit: "mph",
  tireTemperatureThresholds: { cold: 150, warm: 220, hot: 280 },
};

interface TelemetryContextValue {
  connected: boolean;
  packet: TelemetryPacket | null;
  packetsPerSec: number;
  displaySettings: DisplaySettings;
  refetchSettings: () => Promise<void>;
}

export const TelemetryContext = createContext<TelemetryContextValue>({
  connected: false,
  packet: null,
  packetsPerSec: 0,
  displaySettings: DEFAULT_DISPLAY_SETTINGS,
  refetchSettings: async () => {},
});

export function useTelemetry() {
  return useContext(TelemetryContext);
}

export function useDisplaySettings() {
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings>(DEFAULT_DISPLAY_SETTINGS);

  const refetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      setDisplaySettings({
        temperatureUnit: data.temperatureUnit ?? "F",
        speedUnit: data.speedUnit ?? "mph",
        tireTemperatureThresholds: data.tireTemperatureThresholds ?? DEFAULT_DISPLAY_SETTINGS.tireTemperatureThresholds,
      });
    } catch {
      // Keep defaults on error
    }
  }, []);

  return { displaySettings, refetchSettings };
}
