import { create } from "zustand";
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

interface TelemetryState {
  connected: boolean;
  packet: TelemetryPacket | null;
  packetsPerSec: number;
  displaySettings: DisplaySettings;
  setConnected: (connected: boolean) => void;
  setPacket: (packet: TelemetryPacket) => void;
  setPacketsPerSec: (pps: number) => void;
  refetchSettings: () => Promise<void>;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  connected: false,
  packet: null,
  packetsPerSec: 0,
  displaySettings: DEFAULT_DISPLAY_SETTINGS,
  setConnected: (connected) => set({ connected }),
  setPacket: (packet) => set({ packet }),
  setPacketsPerSec: (packetsPerSec) => set({ packetsPerSec }),
  refetchSettings: async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      set({
        displaySettings: {
          temperatureUnit: data.temperatureUnit ?? "F",
          speedUnit: data.speedUnit ?? "mph",
          tireTemperatureThresholds:
            data.tireTemperatureThresholds ??
            DEFAULT_DISPLAY_SETTINGS.tireTemperatureThresholds,
        },
      });
    } catch {
      // Keep defaults on error
    }
  },
}));
